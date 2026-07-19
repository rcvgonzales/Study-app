import React, { useState, useEffect, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────
   STUDY FORGE v2 — cert-prep study tool
   v2 adds:
   • Miss recycling — "Again" re-queues the card later in the same session
   • Spaced repetition — interval ladder (1d → 3d → 7d → 21d → 50d) with due dates
   • Deck editing — edit/add/delete cards, generate more from new notes
   Palette: teal ink / jade / brass · Type: Bricolage Grotesque / Figtree / JetBrains Mono
   ───────────────────────────────────────────────────────────── */

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Figtree:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap');
`;

const C = {
  paper: "#F2F5F3",
  ink: "#0E3230",
  inkSoft: "#3D5A56",
  jade: "#2E8B6F",
  jadeDeep: "#1C6B54",
  brass: "#A97E2F",
  line: "#CBD8D3",
  card: "#FFFFFF",
  danger: "#A0453A",
};

const STORAGE_KEY = "study-forge-decks-v1";
const DAY = 24 * 60 * 60 * 1000;
const LADDER = [1, 3, 7, 21, 50]; // days until next review, indexed by streak

const intervalFor = (streak) => LADDER[Math.min(streak, LADDER.length - 1)];
const isDue = (c) => (c.due ?? 0) <= Date.now();

/* ── storage ── localStorage in browsers; window.storage inside Claude artifacts */
function normalizeCard(c) {
  return { interval: 0, due: 0, streak: 0, reviews: 0, ...c };
}
const hasArtifactStorage = typeof window !== "undefined" && window.storage?.get;
async function loadDecks() {
  try {
    let raw = null;
    if (hasArtifactStorage) {
      try { const r = await window.storage.get(STORAGE_KEY); raw = r ? r.value : null; } catch { raw = null; }
    } else {
      raw = localStorage.getItem(STORAGE_KEY);
    }
    if (!raw) return { decks: [], sessions: [] };
    const data = JSON.parse(raw);
    data.decks = (data.decks || []).map((d) => ({ ...d, cards: d.cards.map(normalizeCard) }));
    data.sessions = data.sessions || [];
    return data;
  } catch {
    return { decks: [], sessions: [] };
  }
}
async function saveDecks(data) {
  const raw = JSON.stringify(data);
  try {
    if (hasArtifactStorage) await window.storage.set(STORAGE_KEY, raw);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch (e) { console.error("save failed", e); }
}

/* ── Claude API (instrumented: errors carry status + raw body so failures are diagnosable) ── */
async function callClaude(prompt, maxRetries = 1) {
  let lastErr = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, max_tokens: 1500 }),
      });
      const rawBody = await res.text();
      if (!res.ok) throw new Error(`API HTTP ${res.status}: ${rawBody.slice(0, 160)}`);
      let data;
      try { data = JSON.parse(rawBody); }
      catch { throw new Error(`Proxy returned non-JSON (${res.status}): ${rawBody.slice(0, 160)}`); }
      if (data.detail) throw new Error(`Proxy error: ${String(data.detail).slice(0, 160)}`);
      if (data.text) return data.text;
      throw new Error(`Proxy gave empty text. Body: ${rawBody.slice(0, 160)}`);
    } catch (e) {
      lastErr = e;
      if (i === maxRetries) throw e;
    }
  }
  throw lastErr || new Error("No response");
}

async function summarizeNotes(notes) {
  const prompt = `Summarize these study notes into a tight, exam-oriented summary. Use short plain sentences. Lead with the concepts most likely to be tested. Keep it under 200 words. Respond with ONLY the summary text, no preamble.\n\nNOTES:\n${notes}`;
  return callClaude(prompt);
}

function extractJsonArray(text) {
  // Tolerate preamble/fences; grab the outermost [...] span
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Model replied with text instead of cards: "${clean.slice(0, 140)}"`);
  }
  return JSON.parse(clean.slice(start, end + 1));
}

function extractJsonObject(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error(`Grader replied with text: "${clean.slice(0, 120)}"`);
  return JSON.parse(clean.slice(start, end + 1));
}

async function gradeAnswer(question, correctAnswer, userAnswer) {
  const prompt = `You are grading one flashcard quiz answer.\nQuestion: "${question}"\nCorrect answer: "${correctAnswer}"\nStudent's answer: "${userAnswer}"\n\nGrade generously on substance: accept paraphrases, partial wording, and different phrasing that captures the key idea. Grade "incorrect" only if the core concept is wrong or missing.\n\nRespond with ONLY raw JSON, no fences, no preamble:\n{"verdict":"correct" or "incorrect","feedback":"one short sentence explaining why"}`;
  const text = await callClaude(prompt);
  const parsed = extractJsonObject(text);
  if (parsed.verdict !== "correct" && parsed.verdict !== "incorrect") throw new Error("Bad verdict");
  return { verdict: parsed.verdict, feedback: String(parsed.feedback || "") };
}

async function generateCardBatch(notes, count, avoidFronts) {
  const avoid = avoidFronts.length
    ? `\n\nDo NOT duplicate these existing questions:\n${avoidFronts.map((f) => "- " + f).join("\n")}`
    : "";
  const prompt = `You are generating exam flashcards from study notes. Create EXACTLY ${count} flashcards covering the most testable concepts. Front = a specific question. Back = a concise answer (1-2 short sentences maximum).${avoid}\n\nCRITICAL RULES:\n- Respond with ONLY a raw JSON array. No markdown fences, no preamble, no explanation.\n- Even if the notes are brief, unstructured, or oddly formatted, still generate ${count} cards from whatever content is present.\n- NEVER reply with a complaint, request for clarification, or commentary about the notes' format. JSON array only, always.\n\nFormat:\n[{"front":"...","back":"..."}]\n\nNOTES:\n${notes}`;
  const text = await callClaude(prompt);
  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) throw new Error("Bad format");
  return parsed.filter((c) => c.front && c.back);
}

async function generateCards(notes, count, existingFronts = []) {
  // Batches of 5 keep each response comfortably inside the token limit
  const BATCH = 5;
  const collected = [];
  const avoid = [...existingFronts];
  let failures = 0;
  while (collected.length < count && failures < 2) {
    const need = Math.min(BATCH, count - collected.length);
    try {
      const batch = await generateCardBatch(notes, need, avoid.slice(-40));
      for (const c of batch) {
        collected.push(c);
        avoid.push(c.front);
      }
    } catch (e) {
      failures += 1;
      if (collected.length === 0 && failures >= 2) throw e;
    }
  }
  if (collected.length === 0) throw new Error("Generation produced no cards");
  return collected.slice(0, count).map((c, i) =>
    normalizeCard({
      id: Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 6),
      front: String(c.front),
      back: String(c.back),
    })
  );
}

/* ── shared styles ── */
const S = {
  app: {
    minHeight: "100vh",
    background: C.paper,
    color: C.ink,
    fontFamily: "'Figtree', sans-serif",
    padding: "0 16px 64px",
  },
  shell: { maxWidth: 720, margin: "0 auto" },
  display: { fontFamily: "'Bricolage Grotesque', sans-serif" },
  mono: { fontFamily: "'JetBrains Mono', monospace" },
  btn: (variant = "primary") => ({
    fontFamily: "'Figtree', sans-serif",
    fontWeight: 600,
    fontSize: 14,
    padding: "10px 18px",
    borderRadius: 8,
    cursor: "pointer",
    border: "1.5px solid",
    ...(variant === "primary" && { background: C.jadeDeep, borderColor: C.jadeDeep, color: "#fff" }),
    ...(variant === "ghost" && { background: "transparent", borderColor: C.line, color: C.inkSoft }),
    ...(variant === "brass" && { background: C.brass, borderColor: C.brass, color: "#fff" }),
    ...(variant === "danger" && { background: "transparent", borderColor: C.danger, color: C.danger }),
  }),
  panel: {
    background: C.card,
    border: `1.5px solid ${C.line}`,
    borderRadius: 12,
    padding: 20,
  },
  label: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: C.brass,
    fontWeight: 600,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    fontSize: 15,
    fontFamily: "'Figtree', sans-serif",
    border: `1.5px solid ${C.line}`,
    borderRadius: 8,
    background: C.card,
    color: C.ink,
  },
};

const dueLabel = (c) => {
  if (isDue(c)) return "due now";
  const days = Math.ceil((c.due - Date.now()) / DAY);
  return `due in ${days}d`;
};

/* ── header ── */
function Header({ onHome, sub }) {
  return (
    <header style={{ padding: "28px 0 20px", borderBottom: `2px solid ${C.ink}`, marginBottom: 24 }}>
      <div onClick={onHome} style={{ cursor: "pointer", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ ...S.display, fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>Study Forge</h1>
        <span style={{ ...S.mono, fontSize: 11, color: C.jade }}>notes → cards → reps</span>
      </div>
      {sub && <div style={{ ...S.mono, fontSize: 12, color: C.inkSoft, marginTop: 6 }}>{sub}</div>}
    </header>
  );
}

/* ── HOME ── */
function Home({ data, onNew, onOpen, onDelete }) {
  const [confirmId, setConfirmId] = useState(null);
  const totalCards = data.decks.reduce((a, d) => a + d.cards.length, 0);
  const totalDue = data.decks.reduce((a, d) => a + d.cards.filter(isDue).length, 0);
  const totalReviews = data.sessions.reduce((a, s) => a + (s.reviewed || s.total || 0), 0);
  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 24, flexWrap: "wrap" }}>
        <Stat label="Decks" value={data.decks.length} />
        <Stat label="Cards" value={totalCards} />
        <Stat label="Due today" value={totalDue} accent />
        <Stat label="Reviews" value={totalReviews} />
      </div>

      <button style={S.btn("primary")} onClick={onNew}>+ New deck from notes</button>

      <div style={{ marginTop: 28 }}>
        {data.decks.length === 0 && (
          <div style={{ ...S.panel, textAlign: "center", padding: 40 }}>
            <div style={{ ...S.display, fontSize: 20, fontWeight: 600, marginBottom: 8 }}>No decks yet</div>
            <div style={{ color: C.inkSoft, fontSize: 14 }}>
              Paste your first set of notes to generate a summary and flashcards.
            </div>
          </div>
        )}
        {data.decks.map((d) => {
          const due = d.cards.filter(isDue).length;
          const mastered = d.cards.filter((c) => c.streak >= 3).length;
          const deckQuizzes = data.sessions.filter((s) => s.quiz && (s.deckId === d.id || (!s.deckId && s.deckTitle === d.title)));
          const lastQuiz = deckQuizzes.length ? deckQuizzes[deckQuizzes.length - 1] : null;
          return (
            <div key={d.id} style={{ ...S.panel, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ cursor: "pointer", flex: 1, minWidth: 200 }} onClick={() => onOpen(d.id)}>
                <div style={{ ...S.display, fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
                  {d.title}
                  {due > 0 && (
                    <span style={{ ...S.mono, fontSize: 10, fontWeight: 600, background: C.brass, color: "#fff", borderRadius: 20, padding: "3px 9px" }}>
                      {due} due
                    </span>
                  )}
                </div>
                <div style={{ ...S.mono, fontSize: 11, color: C.inkSoft, marginTop: 4 }}>
                  {d.cards.length} cards · {mastered} mastered ·{" "}
                  {lastQuiz
                    ? <span style={{ color: Math.round((lastQuiz.score / lastQuiz.total) * 100) >= 70 ? C.jadeDeep : C.danger, fontWeight: 600 }}>
                        quiz {lastQuiz.score}/{lastQuiz.total}
                      </span>
                    : <span style={{ color: C.brass }}>no quiz yet</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {confirmId === d.id ? (
                  <>
                    <span style={{ ...S.mono, fontSize: 11, color: C.danger }}>
                      Delete "{d.title}" and its {d.cards.length} cards?
                    </span>
                    <button
                      style={{ ...S.btn("danger"), background: C.danger, color: "#fff" }}
                      onClick={() => { onDelete(d.id); setConfirmId(null); }}
                    >
                      Yes, delete
                    </button>
                    <button style={S.btn("ghost")} onClick={() => setConfirmId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button style={S.btn("ghost")} onClick={() => onOpen(d.id)}>Open</button>
                    <button style={S.btn("danger")} onClick={() => setConfirmId(d.id)}>Delete</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {(() => {
        const studySessions = data.sessions.filter((s) => !s.quiz).slice(-6).reverse();
        const quizSessions = data.sessions.filter((s) => s.quiz).slice(-6).reverse();
        if (!studySessions.length && !quizSessions.length) return null;
        return (
          <div style={{ marginTop: 32 }}>
            {studySessions.length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <div style={{ ...S.label, marginBottom: 10 }}>Reviewed</div>
                <div style={{ ...S.panel, padding: 0, overflow: "hidden" }}>
                  {studySessions.map((s, i) => (
                    <div key={i} style={{ ...S.mono, fontSize: 12, padding: "10px 16px", borderBottom: i < studySessions.length - 1 ? `1px solid ${C.line}` : "none", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span>{new Date(s.date).toLocaleDateString()} · {s.deckTitle}</span>
                      <span style={{ color: C.jadeDeep }}>{s.reviewed} reviews · {s.cleared} cleared</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {quizSessions.length > 0 && (
              <div>
                <div style={{ ...S.label, marginBottom: 10 }}>Quiz results</div>
                <div style={{ ...S.panel, padding: 0, overflow: "hidden" }}>
                  {quizSessions.map((s, i) => {
                    const p = Math.round((s.score / s.total) * 100);
                    return (
                      <div key={i} style={{ ...S.mono, fontSize: 12, padding: "10px 16px", borderBottom: i < quizSessions.length - 1 ? `1px solid ${C.line}` : "none", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                        <span>{new Date(s.date).toLocaleDateString()} · {s.deckTitle}</span>
                        <span style={{ color: p >= 70 ? C.jadeDeep : C.danger, fontWeight: 600 }}>{s.score}/{s.total} · {p}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div style={{ ...S.display, fontSize: 34, fontWeight: 800, color: accent ? C.brass : C.ink, lineHeight: 1 }}>{value}</div>
      <div style={{ ...S.mono, fontSize: 11, color: C.inkSoft, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</div>
    </div>
  );
}

/* ── card editor row (shared by Create and DeckView edit mode) ── */
function CardEditor({ card, onChange, onRemove }) {
  return (
    <div style={{ ...S.panel, marginBottom: 10, padding: 14 }}>
      <input
        value={card.front}
        onChange={(e) => onChange({ ...card, front: e.target.value })}
        placeholder="Question"
        style={{ width: "100%", boxSizing: "border-box", border: "none", background: "transparent", fontFamily: "'Figtree', sans-serif", fontWeight: 600, fontSize: 14, color: C.ink, marginBottom: 6 }}
      />
      <textarea
        value={card.back}
        onChange={(e) => onChange({ ...card, back: e.target.value })}
        placeholder="Answer"
        rows={2}
        style={{ width: "100%", boxSizing: "border-box", border: "none", background: "transparent", fontFamily: "'Figtree', sans-serif", fontSize: 13, color: C.inkSoft, resize: "vertical" }}
      />
      <button style={{ ...S.mono, fontSize: 11, color: C.danger, background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={onRemove}>
        remove
      </button>
    </div>
  );
}

/* ── CREATE ── */
function Create({ onSave, onCancel }) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [summary, setSummary] = useState("");
  const [cards, setCards] = useState([]);
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const doSummary = async () => {
    setErr(""); setBusy("summary");
    try { setSummary(await summarizeNotes(notes)); }
    catch (e) { setErr(`Summary failed: ${e.message || e}`); }
    setBusy("");
  };
  const doCards = async () => {
    setErr(""); setBusy("cards");
    try { setCards(await generateCards(notes, count)); }
    catch (e) { setErr(`Card generation failed: ${e.message || e}. Try again or use fewer cards.`); }
    setBusy("");
  };

  const canGen = notes.trim().length > 40;

  return (
    <div>
      <div style={{ ...S.label, marginBottom: 8 }}>Deck title</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. GCP DE — BigQuery partitioning" style={{ ...S.input, marginBottom: 18 }} />
      <div style={{ ...S.label, marginBottom: 8 }}>Paste notes</div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Paste raw study notes, doc excerpts, or exam-guide sections here…"
        rows={9}
        style={{ ...S.input, padding: 14, fontSize: 14, lineHeight: 1.5, resize: "vertical" }}
      />
      <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button style={{ ...S.btn("ghost"), opacity: canGen ? 1 : 0.5 }} disabled={!canGen || !!busy} onClick={doSummary}>
          {busy === "summary" ? "Summarizing…" : "Summarize"}
        </button>
        <button style={{ ...S.btn("primary"), opacity: canGen ? 1 : 0.5 }} disabled={!canGen || !!busy} onClick={doCards}>
          {busy === "cards" ? "Generating…" : `Generate ${count} flashcards`}
        </button>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ ...S.mono, fontSize: 12, padding: "8px 10px", border: `1.5px solid ${C.line}`, borderRadius: 8, background: C.card, color: C.ink }}>
          {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n} cards</option>)}
        </select>
        <button
          style={{ ...S.btn("ghost"), opacity: notes.trim().startsWith("[") ? 1 : 0.5 }}
          disabled={!notes.trim().startsWith("[") || !!busy}
          onClick={() => {
            setErr("");
            try {
              const parsed = JSON.parse(notes.trim());
              if (!Array.isArray(parsed)) throw new Error("not an array");
              const imported = parsed
                .filter((c) => c && c.front && c.back)
                .map((c, i) => normalizeCard({
                  id: Date.now() + "-imp-" + i,
                  front: String(c.front),
                  back: String(c.back),
                }));
              if (!imported.length) throw new Error("no valid cards found");
              setCards(imported);
            } catch (e) {
              setErr(`JSON import failed: ${e.message}. Expected [{"front":"...","back":"..."}]`);
            }
          }}
        >
          Import JSON
        </button>
      </div>
      <div style={{ ...S.mono, fontSize: 10, color: C.inkSoft, marginTop: 8 }}>
        Tip: if AI generation fails on this device, paste a JSON card array above and tap Import JSON.
      </div>

      {err && <div style={{ color: C.danger, fontSize: 13, marginTop: 10, wordBreak: "break-word" }}>{err}</div>}
      <button
        style={{ ...S.mono, fontSize: 11, color: C.inkSoft, background: "none", border: "none", cursor: "pointer", padding: 0, marginTop: 10, textDecoration: "underline" }}
        disabled={!!busy}
        onClick={async () => {
          setErr(""); setBusy("test");
          try {
            const r = await callClaude("Reply with exactly: OK");
            setErr(`AI connection test passed — model replied: "${r.slice(0, 60)}"`);
          } catch (e) {
            setErr(`AI connection test FAILED: ${e.message || e}`);
          }
          setBusy("");
        }}
      >
        {busy === "test" ? "testing…" : "test AI connection"}
      </button>

      {summary && (
        <div style={{ ...S.panel, marginTop: 20, borderLeft: `4px solid ${C.brass}` }}>
          <div style={{ ...S.label, marginBottom: 8 }}>Summary</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{summary}</div>
        </div>
      )}

      {cards.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...S.label, marginBottom: 10 }}>Cards ({cards.length}) — tap a field to edit</div>
          {cards.map((c) => (
            <CardEditor
              key={c.id}
              card={c}
              onChange={(nc) => setCards(cards.map((x) => (x.id === c.id ? nc : x)))}
              onRemove={() => setCards(cards.filter((x) => x.id !== c.id))}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
        <button
          style={{ ...S.btn("brass"), opacity: cards.length && title.trim() ? 1 : 0.5 }}
          disabled={!cards.length || !title.trim()}
          onClick={() => onSave({ id: String(Date.now()), title: title.trim(), notes, summary, cards, created: Date.now() })}
        >
          Save deck
        </button>
        <button style={S.btn("ghost")} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ── STUDY (v3: swipe deck — tap to flip, swipe up = got it, swipe down = again) ── */
function Study({ deck, onFinish, onExit }) {
  const [queue, setQueue] = useState(() => {
    const due = deck.cards.filter(isDue);
    const pool = due.length ? due : [...deck.cards];
    return pool.sort((a, b) => a.streak - b.streak || Math.random() - 0.5).map((c) => c.id);
  });
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [missed, setMissed] = useState({});
  const [cleared, setCleared] = useState({});
  const [reviews, setReviews] = useState(0);

  // swipe state
  const [dragY, setDragY] = useState(0);
  const [startY, setStartY] = useState(null);
  const [flying, setFlying] = useState(null); // 'up' | 'down' while card animates out

  const cardId = queue[idx];
  const card = deck.cards.find((c) => c.id === cardId);
  const done = idx >= queue.length;
  const SWIPE_THRESHOLD = 90;

  const answer = (r) => {
    setReviews((n) => n + 1);
    if (r === "again") {
      setMissed((m) => ({ ...m, [cardId]: true }));
      setQueue((q) => {
        const next = [...q];
        next.splice(Math.min(idx + 4, next.length), 0, cardId);
        return next;
      });
    } else {
      setCleared((c2) => ({ ...c2, [cardId]: true }));
    }
    // fly-out animation, then advance
    setFlying(r === "got" ? "up" : "down");
    setTimeout(() => {
      setFlying(null);
      setDragY(0);
      setFlipped(false);
      setIdx((i) => i + 1);
    }, 220);
  };

  const onTouchStart = (e) => {
    if (flying) return;
    setStartY(e.touches ? e.touches[0].clientY : e.clientY);
  };
  const onTouchMove = (e) => {
    if (startY === null || flying) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    // Only allow swiping once the answer has been seen
    if (flipped) setDragY(y - startY);
  };
  const onTouchEnd = () => {
    if (startY === null || flying) return;
    const moved = Math.abs(dragY) > 8;
    if (flipped && dragY < -SWIPE_THRESHOLD) answer("got");
    else if (flipped && dragY > SWIPE_THRESHOLD) answer("again");
    else {
      if (!moved) setFlipped((f) => !f); // treat as tap
      setDragY(0);
    }
    setStartY(null);
  };

  if (done) {
    const clearedCount = Object.keys(cleared).length;
    const missedCount = Object.keys(missed).length;
    const logLine = `${new Date().toISOString().slice(0, 10)} — Studied "${deck.title}": ${reviews} reviews, ${clearedCount} cards cleared, ${missedCount} needed retries`;
    return (
      <div style={{ textAlign: "center", paddingTop: 24 }}>
        <div style={{ ...S.display, fontSize: 30, fontWeight: 800 }}>Session done</div>
        <div style={{ ...S.mono, fontSize: 13, color: C.inkSoft, marginTop: 8 }}>
          {clearedCount} cards cleared · {reviews} total reviews
        </div>
        <div style={{ ...S.panel, marginTop: 24, textAlign: "left", borderLeft: `4px solid ${C.jade}` }}>
          <div style={{ ...S.label, marginBottom: 8 }}>Evidence log entry</div>
          <div style={{ ...S.mono, fontSize: 12, lineHeight: 1.6 }}>{logLine}</div>
          <button style={{ ...S.btn("ghost"), marginTop: 12 }} onClick={() => navigator.clipboard && navigator.clipboard.writeText(logLine)}>
            Copy for evidence log
          </button>
        </div>
        <button style={{ ...S.btn("primary"), marginTop: 24 }} onClick={() => onFinish({ missed, cleared, reviews })}>
          Save session
        </button>
        <div style={{ ...S.mono, fontSize: 11, color: C.inkSoft, marginTop: 14 }}>
          Once every card has been studied, Quiz mode unlocks in the deck view — typed answers, no retries.
        </div>
      </div>
    );
  }

  const remaining = queue.length - idx;
  // drag-driven visual feedback
  const progress = Math.min(Math.abs(dragY) / SWIPE_THRESHOLD, 1);
  const towardGot = dragY < 0;
  const tint = flipped && Math.abs(dragY) > 10 ? (towardGot ? C.jade : C.danger) : null;
  const flyY = flying === "up" ? -600 : flying === "down" ? 600 : dragY;

  return (
    <div style={{ touchAction: "pan-x", userSelect: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={{ ...S.mono, fontSize: 12, color: C.inkSoft }}>
          {remaining} card{remaining === 1 ? "" : "s"} left{Object.keys(missed).length > 0 ? ` · ${Object.keys(missed).length} recycling` : ""}
        </span>
        <button style={{ ...S.mono, fontSize: 12, color: C.inkSoft, background: "none", border: "none", cursor: "pointer" }} onClick={onExit}>
          exit
        </button>
      </div>

      <div style={{ height: 4, background: C.line, borderRadius: 2, marginBottom: 20 }}>
        <div style={{ height: 4, width: `${(idx / queue.length) * 100}%`, background: C.jade, borderRadius: 2, transition: "width 0.2s" }} />
      </div>

      {/* swipe hints */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, opacity: flipped ? 1 : 0.25, transition: "opacity 0.2s" }}>
        <span style={{ ...S.mono, fontSize: 10, color: C.jadeDeep }}>↑ swipe up = got it</span>
        <span style={{ ...S.mono, fontSize: 10, color: C.danger }}>↓ swipe down = again</span>
      </div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onTouchStart}
        onMouseMove={(e) => startY !== null && onTouchMove(e)}
        onMouseUp={onTouchEnd}
        onMouseLeave={() => startY !== null && onTouchEnd()}
        style={{
          ...S.panel,
          minHeight: "56vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          cursor: "pointer",
          padding: 32,
          borderTop: `4px solid ${tint || (flipped ? C.brass : missed[cardId] ? C.danger : C.jade)}`,
          boxShadow: tint ? `0 0 0 2px ${tint}, 0 12px 32px rgba(14,50,48,0.14)` : "0 6px 20px rgba(14,50,48,0.08)",
          transform: `translateY(${flyY}px) rotate(${flyY * 0.015}deg)`,
          opacity: flying ? 0 : 1 - progress * 0.15,
          transition: startY !== null && !flying ? "none" : "transform 0.22s ease, opacity 0.22s ease",
        }}
      >
        <div style={{ ...S.label, marginBottom: 14, color: tint || (flipped ? C.brass : C.jade) }}>
          {flipped
            ? tint
              ? towardGot ? "Release: got it" : "Release: again"
              : "Answer — swipe to grade"
            : missed[cardId] ? "Retry — tap to flip" : "Question — tap to flip"}
        </div>
        <div style={{ fontSize: flipped ? 16 : 19, fontWeight: flipped ? 400 : 600, lineHeight: 1.5, fontFamily: flipped ? "'Figtree', sans-serif" : "'Bricolage Grotesque', sans-serif" }}>
          {flipped ? card.back : card.front}
        </div>
      </div>

      {flipped && !flying && (
        <div style={{ display: "flex", gap: 12, marginTop: 18, justifyContent: "center" }}>
          <button style={{ ...S.btn("ghost"), borderColor: C.danger, color: C.danger, flex: 1, maxWidth: 200 }} onClick={() => answer("again")}>
            Again
          </button>
          <button style={{ ...S.btn("primary"), flex: 1, maxWidth: 200 }} onClick={() => answer("got")}>
            Got it
          </button>
        </div>
      )}
    </div>
  );
}

/* ── QUIZ (typed recall, one attempt per question, no retries) ── */
function Quiz({ deck, onFinish, onExit }) {
  const [questions] = useState(() => {
    const pool = [...deck.cards].sort(() => Math.random() - 0.5);
    return pool.slice(0, Math.min(10, pool.length));
  });
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState("answer"); // answer | grading | feedback | selfgrade
  const [result, setResult] = useState(null);
  const [results, setResults] = useState([]);

  const q = questions[idx];
  const done = idx >= questions.length;

  const submit = async () => {
    if (!answer.trim()) return;
    setPhase("grading");
    try {
      const r = await gradeAnswer(q.front, q.back, answer.trim());
      setResult(r);
      setPhase("feedback");
    } catch {
      setPhase("selfgrade"); // AI unavailable: reveal answer, self-grade honestly
    }
  };

  const record = (verdict, feedback) => {
    setResults([...results, { front: q.front, back: q.back, answer: answer.trim(), verdict, feedback }]);
    setAnswer("");
    setResult(null);
    setPhase("answer");
    setIdx(idx + 1);
  };

  if (done) {
    const score = results.filter((r) => r.verdict === "correct").length;
    const logLine = `${new Date().toISOString().slice(0, 10)} — Quiz "${deck.title}": ${score}/${results.length} correct (typed recall)`;
    return (
      <div>
        <div style={{ textAlign: "center", paddingTop: 12 }}>
          <div style={{ ...S.display, fontSize: 30, fontWeight: 800 }}>Quiz done</div>
          <div style={{ ...S.display, fontSize: 44, fontWeight: 800, color: score / results.length >= 0.7 ? C.jadeDeep : C.brass, marginTop: 6 }}>
            {score}/{results.length}
          </div>
        </div>
        <div style={{ ...S.panel, marginTop: 20, borderLeft: `4px solid ${C.jade}` }}>
          <div style={{ ...S.label, marginBottom: 8 }}>Evidence log entry</div>
          <div style={{ ...S.mono, fontSize: 12, lineHeight: 1.6 }}>{logLine}</div>
          <button style={{ ...S.btn("ghost"), marginTop: 12 }} onClick={() => navigator.clipboard && navigator.clipboard.writeText(logLine)}>
            Copy for evidence log
          </button>
        </div>
        <div style={{ marginTop: 20 }}>
          <div style={{ ...S.label, marginBottom: 10 }}>Review</div>
          {results.map((r, i) => (
            <div key={i} style={{ ...S.panel, marginBottom: 8, padding: 14, borderLeft: `4px solid ${r.verdict === "correct" ? C.jadeDeep : C.danger}` }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{r.front}</div>
              <div style={{ ...S.mono, fontSize: 11, color: C.inkSoft, marginTop: 6 }}>you: {r.answer || "(blank)"}</div>
              <div style={{ fontSize: 13, color: C.inkSoft, marginTop: 4 }}>answer: {r.back}</div>
              {r.feedback && <div style={{ fontSize: 12, color: r.verdict === "correct" ? C.jadeDeep : C.danger, marginTop: 4 }}>{r.feedback}</div>}
            </div>
          ))}
        </div>
        <button style={{ ...S.btn("primary"), marginTop: 16 }} onClick={() => onFinish(results)}>Save quiz</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={{ ...S.mono, fontSize: 12, color: C.inkSoft }}>Question {idx + 1} / {questions.length} · no retries</span>
        <button style={{ ...S.mono, fontSize: 12, color: C.inkSoft, background: "none", border: "none", cursor: "pointer" }} onClick={onExit}>exit</button>
      </div>
      <div style={{ height: 4, background: C.line, borderRadius: 2, marginBottom: 20 }}>
        <div style={{ height: 4, width: `${(idx / questions.length) * 100}%`, background: C.brass, borderRadius: 2, transition: "width 0.2s" }} />
      </div>

      <div style={{ ...S.panel, borderTop: `4px solid ${C.brass}` }}>
        <div style={{ ...S.label, marginBottom: 10 }}>Recall — type your answer</div>
        <div style={{ ...S.display, fontSize: 18, fontWeight: 600, lineHeight: 1.4 }}>{q.front}</div>
      </div>

      {phase === "answer" || phase === "grading" ? (
        <>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer from memory…"
            rows={4}
            disabled={phase === "grading"}
            style={{ width: "100%", boxSizing: "border-box", padding: 14, fontSize: 15, lineHeight: 1.5, fontFamily: "'Figtree', sans-serif", border: `1.5px solid ${C.line}`, borderRadius: 8, background: C.card, color: C.ink, marginTop: 14, resize: "vertical" }}
          />
          <button
            style={{ ...S.btn("primary"), marginTop: 12, opacity: answer.trim() && phase !== "grading" ? 1 : 0.5 }}
            disabled={!answer.trim() || phase === "grading"}
            onClick={submit}
          >
            {phase === "grading" ? "Grading…" : "Submit — final answer"}
          </button>
        </>
      ) : phase === "feedback" ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...S.panel, borderLeft: `4px solid ${result.verdict === "correct" ? C.jadeDeep : C.danger}` }}>
            <div style={{ ...S.label, color: result.verdict === "correct" ? C.jadeDeep : C.danger, marginBottom: 8 }}>
              {result.verdict === "correct" ? "Correct" : "Incorrect"}
            </div>
            <div style={{ fontSize: 13, color: C.inkSoft }}>{result.feedback}</div>
            <div style={{ fontSize: 13, marginTop: 8 }}><b>Answer:</b> {q.back}</div>
          </div>
          <button style={{ ...S.btn("primary"), marginTop: 12 }} onClick={() => record(result.verdict, result.feedback)}>
            Next
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...S.panel, borderLeft: `4px solid ${C.brass}` }}>
            <div style={{ ...S.label, marginBottom: 8 }}>AI grading unavailable — grade yourself honestly</div>
            <div style={{ fontSize: 13 }}><b>Correct answer:</b> {q.back}</div>
            <div style={{ ...S.mono, fontSize: 11, color: C.inkSoft, marginTop: 6 }}>you wrote: {answer.trim() || "(blank)"}</div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button style={{ ...S.btn("ghost"), borderColor: C.danger, color: C.danger, flex: 1 }} onClick={() => record("incorrect", "")}>I was wrong</button>
            <button style={{ ...S.btn("primary"), flex: 1 }} onClick={() => record("correct", "")}>I was right</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── DECK VIEW (v2: edit mode + generate more) ── */
function DeckView({ deck, quizHistory = [], onStudy, onQuiz, onBack, onUpdate }) {
  const allStudied = deck.cards.length > 0 && deck.cards.every((c) => c.reviews > 0);
  const pct = (s) => Math.round((s.score / s.total) * 100);
  const bestQuiz = quizHistory.length ? quizHistory.reduce((a, b) => (pct(a) >= pct(b) ? a : b)) : null;
  const latestQuiz = quizHistory.length ? quizHistory[quizHistory.length - 1] : null;
  const missCounts = {};
  quizHistory.forEach((s) => (s.missedFronts || []).forEach((f) => { missCounts[f] = (missCounts[f] || 0) + 1; }));
  const weakSpots = Object.entries(missCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [moreNotes, setMoreNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const due = deck.cards.filter(isDue).length;

  const startEdit = () => { setDraft(deck.cards.map((c) => ({ ...c }))); setEditing(true); setErr(""); };
  const saveEdit = () => {
    onUpdate({ ...deck, cards: draft.filter((c) => c.front.trim() && c.back.trim()) });
    setEditing(false); setDraft(null); setMoreNotes("");
  };
  const addBlank = () =>
    setDraft([...draft, normalizeCard({ id: Date.now() + "-m-" + Math.random().toString(36).slice(2, 6), front: "", back: "" })]);
  const generateMore = async () => {
    setErr(""); setBusy(true);
    try {
      const fresh = await generateCards(moreNotes, 10, draft.map((c) => c.front));
      setDraft([...draft, ...fresh]);
      setMoreNotes("");
    } catch (e) { setErr(`Generation failed: ${e.message || e}. Try again.`); }
    setBusy(false);
  };

  return (
    <div>
      <button style={{ ...S.mono, fontSize: 12, color: C.inkSoft, background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 16 }} onClick={onBack}>
        ← all decks
      </button>
      <h2 style={{ ...S.display, fontSize: 24, fontWeight: 800, margin: "0 0 6px" }}>{deck.title}</h2>
      <div style={{ ...S.mono, fontSize: 12, color: C.inkSoft, marginBottom: 20 }}>
        {deck.cards.length} cards · {due} due now · {deck.cards.filter((c) => c.streak >= 3).length} mastered
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button style={S.btn("primary")} onClick={onStudy}>
          {due > 0 ? `Study ${due} due card${due === 1 ? "" : "s"}` : "Study all (nothing due)"}
        </button>
        <button
          style={{ ...S.btn("brass"), opacity: allStudied ? 1 : 0.5 }}
          disabled={!allStudied}
          title={allStudied ? "Typed recall quiz — one attempt per question" : "Study every card at least once to unlock the quiz"}
          onClick={onQuiz}
        >
          {allStudied ? "Quiz mode" : "Quiz (study all cards first)"}
        </button>
        {!editing
          ? <button style={S.btn("ghost")} onClick={startEdit}>Edit deck</button>
          : <>
              <button style={S.btn("brass")} onClick={saveEdit}>Save changes</button>
              <button style={S.btn("ghost")} onClick={() => { setEditing(false); setDraft(null); }}>Discard</button>
            </>
        }
      </div>

      {quizHistory.length > 0 && !editing && (
        <div style={{ ...S.panel, marginTop: 22, borderTop: `4px solid ${C.brass}` }}>
          <div style={{ ...S.label, marginBottom: 12 }}>Quiz results</div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <div style={{ ...S.display, fontSize: 26, fontWeight: 800, lineHeight: 1 }}>{quizHistory.length}</div>
              <div style={{ ...S.mono, fontSize: 10, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 4 }}>Attempts</div>
            </div>
            <div>
              <div style={{ ...S.display, fontSize: 26, fontWeight: 800, lineHeight: 1, color: pct(latestQuiz) >= 70 ? C.jadeDeep : C.brass }}>{pct(latestQuiz)}%</div>
              <div style={{ ...S.mono, fontSize: 10, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 4 }}>Latest</div>
            </div>
            <div>
              <div style={{ ...S.display, fontSize: 26, fontWeight: 800, lineHeight: 1, color: C.jadeDeep }}>{pct(bestQuiz)}%</div>
              <div style={{ ...S.mono, fontSize: 10, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 4 }}>Best</div>
            </div>
          </div>
          {quizHistory.slice(-5).reverse().map((s, i) => (
            <div key={i} style={{ ...S.mono, fontSize: 12, display: "flex", justifyContent: "space-between", padding: "7px 0", borderTop: `1px solid ${C.line}` }}>
              <span style={{ color: C.inkSoft }}>{new Date(s.date).toLocaleDateString()}</span>
              <span style={{ color: pct(s) >= 70 ? C.jadeDeep : C.danger, fontWeight: 600 }}>{s.score}/{s.total} · {pct(s)}%</span>
            </div>
          ))}
          {weakSpots.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...S.label, marginBottom: 6 }}>Most missed</div>
              {weakSpots.map(([front, n]) => (
                <div key={front} style={{ fontSize: 13, color: C.inkSoft, padding: "3px 0" }}>
                  <span style={{ color: C.danger, fontWeight: 600 }}>{n}×</span> {front}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {deck.summary && !editing && (
        <div style={{ ...S.panel, marginTop: 22, borderLeft: `4px solid ${C.brass}` }}>
          <div style={{ ...S.label, marginBottom: 8 }}>Summary</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{deck.summary}</div>
        </div>
      )}

      {editing && (
        <div style={{ ...S.panel, marginTop: 22, borderLeft: `4px solid ${C.jade}` }}>
          <div style={{ ...S.label, marginBottom: 8 }}>Generate more cards from new notes</div>
          <textarea
            value={moreNotes}
            onChange={(e) => setMoreNotes(e.target.value)}
            placeholder="Paste additional notes — new cards will be appended without duplicating existing questions…"
            rows={5}
            style={{ ...S.input, padding: 12, fontSize: 13, resize: "vertical" }}
          />
          <button
            style={{ ...S.btn("ghost"), marginTop: 10, opacity: moreNotes.trim().length > 40 ? 1 : 0.5 }}
            disabled={moreNotes.trim().length <= 40 || busy}
            onClick={generateMore}
          >
            {busy ? "Generating…" : "Generate 10 more cards"}
          </button>
          {err && <div style={{ color: C.danger, fontSize: 13, marginTop: 8 }}>{err}</div>}
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <div style={{ ...S.label, marginBottom: 10 }}>Cards</div>
        {editing ? (
          <>
            {draft.map((c) => (
              <CardEditor
                key={c.id}
                card={c}
                onChange={(nc) => setDraft(draft.map((x) => (x.id === c.id ? nc : x)))}
                onRemove={() => setDraft(draft.filter((x) => x.id !== c.id))}
              />
            ))}
            <button style={S.btn("ghost")} onClick={addBlank}>+ Add card</button>
          </>
        ) : (
          deck.cards.map((c) => (
            <div key={c.id} style={{ ...S.panel, marginBottom: 8, padding: 14, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{c.front}</div>
                <div style={{ fontSize: 13, color: C.inkSoft, marginTop: 4 }}>{c.back}</div>
              </div>
              <div style={{ ...S.mono, fontSize: 11, textAlign: "right", whiteSpace: "nowrap" }}>
                <div style={{ color: c.streak >= 3 ? C.jadeDeep : C.inkSoft }}>streak {c.streak}</div>
                <div style={{ color: isDue(c) ? C.brass : C.inkSoft, marginTop: 2 }}>{dueLabel(c)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── APP ── */
export default function App() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("home");
  const [activeId, setActiveId] = useState(null);

  useEffect(() => { loadDecks().then(setData); }, []);

  const persist = useCallback((next) => { setData(next); saveDecks(next); }, []);

  if (!data) {
    return (
      <div style={S.app}>
        <style>{FONTS}</style>
        <div style={{ ...S.shell, paddingTop: 80, textAlign: "center", ...S.mono, fontSize: 13, color: C.inkSoft }}>
          loading decks…
        </div>
      </div>
    );
  }

  const active = data.decks.find((d) => d.id === activeId);

  return (
    <div style={S.app}>
      <style>{FONTS}</style>
      <div style={S.shell}>
        <Header onHome={() => setView("home")} sub={view === "study" && active ? active.title : null} />

        {view === "home" && (
          <Home
            data={data}
            onNew={() => setView("create")}
            onOpen={(id) => { setActiveId(id); setView("deck"); }}
            onDelete={(id) => persist({ ...data, decks: data.decks.filter((d) => d.id !== id) })}
          />
        )}

        {view === "create" && (
          <Create
            onSave={(deck) => { persist({ ...data, decks: [...data.decks, deck] }); setActiveId(deck.id); setView("deck"); }}
            onCancel={() => setView("home")}
          />
        )}

        {view === "deck" && active && (
          <DeckView
            deck={active}
            quizHistory={data.sessions.filter((s) => s.quiz && (s.deckId === active.id || (!s.deckId && s.deckTitle === active.title)))}
            onStudy={() => setView("study")}
            onQuiz={() => setView("quiz")}
            onBack={() => setView("home")}
            onUpdate={(updated) => persist({ ...data, decks: data.decks.map((d) => (d.id === updated.id ? updated : d)) })}
          />
        )}

        {view === "quiz" && active && (
          <Quiz
            deck={active}
            onExit={() => setView("deck")}
            onFinish={(results) => {
              const score = results.filter((r) => r.verdict === "correct").length;
              const missedFronts = results.filter((r) => r.verdict !== "correct").map((r) => r.front);
              const sessions = [...data.sessions, { date: Date.now(), deckId: active.id, deckTitle: active.title, quiz: true, score, total: results.length, missedFronts }];
              persist({ ...data, sessions });
              setView("deck");
            }}
          />
        )}

        {view === "study" && active && (
          <Study
            deck={active}
            onExit={() => setView("deck")}
            onFinish={({ missed, cleared, reviews }) => {
              const now = Date.now();
              const decks = data.decks.map((d) =>
                d.id !== active.id ? d : {
                  ...d,
                  cards: d.cards.map((c) => {
                    if (!cleared[c.id] && !missed[c.id]) return c;
                    // Missed at any point this session → streak resets, due tomorrow
                    const newStreak = missed[c.id] ? 0 : c.streak + 1;
                    const days = intervalFor(newStreak);
                    return {
                      ...c,
                      reviews: c.reviews + 1,
                      streak: newStreak,
                      interval: days,
                      due: now + days * DAY,
                    };
                  }),
                }
              );
              const sessions = [...data.sessions, {
                date: now,
                deckTitle: active.title,
                reviewed: reviews,
                cleared: Object.keys(cleared).length,
              }];
              persist({ ...data, decks, sessions });
              setView("deck");
            }}
          />
        )}
      </div>
    </div>
  );
}
