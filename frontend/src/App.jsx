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

/* Quota exhaustion is not a transient failure — retrying it just burns time and
   more quota. Tagged so callers can bail out instead of grinding. */
class QuotaError extends Error {}

/* ── Claude API (instrumented: errors carry status + raw body so failures are diagnosable) ── */
async function callClaude(prompt, maxRetries = 1) {
  let lastErr = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, max_tokens: 4000 }),
      });
      const rawBody = await res.text();
      let data = null;
      try { data = JSON.parse(rawBody); } catch { /* non-JSON body handled below */ }
      const detail = data && data.detail ? String(data.detail) : "";

      // The backend already walked its whole model fallback chain before it gave up,
      // so a 429 here means every model is spent. Sleeping cannot fix that — a daily
      // cap doesn't clear for hours. Surface the backend's explanation verbatim.
      if (res.status === 429) throw new QuotaError(detail || "Rate limited by Gemini.");
      if (!res.ok) throw new Error(detail || `API HTTP ${res.status}: ${rawBody.slice(0, 160)}`);
      if (!data) throw new Error(`Proxy returned non-JSON (${res.status}): ${rawBody.slice(0, 160)}`);
      if (detail) throw new Error(detail.slice(0, 200));
      if (data.text) return data.text;
      throw new Error(`Proxy gave empty text. Body: ${rawBody.slice(0, 160)}`);
    } catch (e) {
      lastErr = e;
      if (e instanceof QuotaError || i === maxRetries) throw e;
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

/* Returns { cards, shortfall } — shortfall is the reason we came up short, or null.
   The caller needs the reason: "the model returned junk" and "you are out of quota"
   deserve very different messages. */
async function generateCards(notes, count, existingFronts = []) {
  // One request covers the largest deck the UI offers. Batches of 5 were a workaround
  // for a token cap that thinking tokens were quietly eating; with thinking disabled,
  // 20 cards fit comfortably in a single call. Fewer calls matters a lot on the free
  // tier, where the daily request quota — not tokens — is the binding constraint.
  const BATCH = 20;
  const collected = [];
  const avoid = [...existingFronts];
  // Consecutive, not cumulative: one flaky batch shouldn't doom a 20-card run
  // that is otherwise going fine.
  let misses = 0;
  let lastErr = null;
  while (collected.length < count && misses < 2) {
    const need = Math.min(BATCH, count - collected.length);
    try {
      const batch = await generateCardBatch(notes, need, avoid.slice(-40));
      // An empty batch makes no progress; without this it spins forever.
      if (batch.length === 0) throw new Error("Batch returned no usable cards");
      misses = 0;
      for (const c of batch) {
        collected.push(c);
        avoid.push(c.front);
      }
    } catch (e) {
      if (e instanceof QuotaError) throw e; // more attempts cannot help
      lastErr = e;
      misses += 1;
      if (collected.length === 0 && misses >= 2) throw e;
    }
  }
  if (collected.length === 0) throw new Error("Generation produced no cards");
  const cards = collected.slice(0, count).map((c, i) =>
    normalizeCard({
      id: Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 6),
      front: String(c.front),
      back: String(c.back),
    })
  );
  return { cards, shortfall: cards.length < count && lastErr ? lastErr.message : null };
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
function Home({ data, onNew, onOpen, onDelete, onDeleteSession, onClearSessions }) {
  const [confirmId, setConfirmId] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const totalCards = data.decks.reduce((a, d) => a + d.cards.length, 0);
  const totalDue = data.decks.reduce((a, d) => a + d.cards.filter(isDue).length, 0);
  const totalReviews = data.sessions.reduce((a, s) => a + s.reviewed, 0);
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
                  {d.cards.length} cards · {mastered} mastered · {new Date(d.created).toLocaleDateString()}
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

      {data.sessions.length > 0 && (() => {
        // Split the ledger by type. A row's position in these filtered lists is NOT its
        // index in data.sessions — deleting by that would remove the wrong entry, so each
        // row carries its real index (i) for onDeleteSession.
        const withIdx = data.sessions.map((s, i) => ({ s, i }));
        const studyAll = withIdx.filter(({ s }) => !s.quiz);
        const quizAll = withIdx.filter(({ s }) => s.quiz);

        // One labeled sub-section, newest first. Hidden entirely when empty. renderMeta
        // draws the type-specific right-hand cell; the row chrome + delete stays shared.
        const section = (title, all, renderMeta) => {
          if (all.length === 0) return null;
          const rows = all.slice(-6).reverse();
          return (
            <div style={{ marginTop: 18 }}>
              <div style={{ ...S.label, marginBottom: 8 }}>{title}</div>
              <div style={{ ...S.panel, padding: 0, overflow: "hidden" }}>
                {rows.map(({ s, i }, n) => (
                  <div key={i} style={{ ...S.mono, fontSize: 12, padding: "10px 16px", borderBottom: n < rows.length - 1 ? `1px solid ${C.line}` : "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>{new Date(s.date).toLocaleDateString()} · {s.deckTitle}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      {renderMeta(s)}
                      <button
                        aria-label={`Remove ${s.deckTitle} entry`}
                        title="Remove this entry"
                        onClick={() => onDeleteSession(i)}
                        style={{ ...S.mono, fontSize: 15, lineHeight: 1, color: C.inkSoft, background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {all.length > rows.length && (
                <div style={{ ...S.mono, fontSize: 11, color: C.inkSoft, marginTop: 6 }}>
                  showing the {rows.length} most recent of {all.length}
                </div>
              )}
            </div>
          );
        };

        return (
          <div style={{ marginTop: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={S.label}>Session ledger</div>
              {confirmClear ? (
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ ...S.mono, fontSize: 11, color: C.danger }}>
                    Clear all {data.sessions.length} entr{data.sessions.length === 1 ? "y" : "ies"}?
                  </span>
                  <button style={{ ...S.btn("danger"), background: C.danger, color: "#fff" }} onClick={() => { onClearSessions(); setConfirmClear(false); }}>
                    Yes, clear
                  </button>
                  <button style={S.btn("ghost")} onClick={() => setConfirmClear(false)}>Cancel</button>
                </span>
              ) : (
                <button style={S.btn("ghost")} onClick={() => setConfirmClear(true)}>Clear ledger</button>
              )}
            </div>
            {section("Reviewed", studyAll, (s) => (
              <span style={{ color: C.jadeDeep }}>{s.reviewed} reviews · {s.cleared} cleared</span>
            ))}
            {section("Quiz results", quizAll, (s) => {
              const percent = s.total ? Math.round((s.score / s.total) * 100) : 0;
              return (
                <span style={{ color: percent >= 70 ? C.jadeDeep : C.danger }}>{s.score}/{s.total} · {percent}%</span>
              );
            })}
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
    try {
      const { cards: made, shortfall } = await generateCards(notes, count);
      setCards(made);
      if (shortfall) {
        setErr(`Only got ${made.length} of ${count} cards (${shortfall}). The cards below are good — generate again to top up.`);
      }
    } catch (e) {
      setErr(e instanceof QuotaError ? e.message : `Card generation failed: ${e.message || e}. Try again or use fewer cards.`);
    }
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
/* Card scheduling saves either way; this only controls the ledger row + Reviews stat. */
function LedgerToggle({ record, onChange }) {
  return (
    <label
      style={{
        ...S.mono, fontSize: 12, marginTop: 16, display: "inline-flex", alignItems: "center",
        gap: 8, cursor: "pointer", color: record ? C.ink : C.inkSoft,
      }}
    >
      <input
        type="checkbox"
        checked={record}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 15, height: 15, accentColor: C.jade, cursor: "pointer" }}
      />
      Record this session in the ledger
      <span style={{ color: C.inkSoft }}>· card progress saves either way</span>
    </label>
  );
}

function Study({ deck, onFinish, onExit, onRestart }) {
  const [queue, setQueue] = useState(() => {
    const due = deck.cards.filter(isDue);
    const pool = due.length ? due : [...deck.cards];
    return pool.sort((a, b) => a.streak - b.streak || Math.random() - 0.5).map((c) => c.id);
  });
  // Cards answered "again" go into the NEXT round rather than being spliced back a
  // few places ahead. Splicing let missed cards cut in front of cards not yet seen,
  // so a run of wrong answers pushed the tail of the deck back indefinitely — you
  // could cycle the same handful forever and never reach the rest, and the session
  // could never end. Rounds guarantee every card is seen once before any repeats.
  const [retry, setRetry] = useState([]);
  const [round, setRound] = useState(1);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [missed, setMissed] = useState({});
  const [cleared, setCleared] = useState({});
  const [reviews, setReviews] = useState(0);
  // Card scheduling always saves — that's the spaced-repetition engine. The ledger row
  // is a separate, optional record of the sitting, so a quick re-skim doesn't have to
  // pad the history or inflate the Reviews stat.
  const [record, setRecord] = useState(true);

  // swipe state
  const [dragY, setDragY] = useState(0);
  const [startY, setStartY] = useState(null);
  const [flying, setFlying] = useState(null); // 'up' | 'down' while card animates out

  const cardId = queue[idx];
  const card = deck.cards.find((c) => c.id === cardId);
  const roundOver = idx >= queue.length;
  const done = roundOver && retry.length === 0;
  const SWIPE_THRESHOLD = 90;
  const progressPayload = { missed, cleared, reviews, record };

  const startNextRound = () => {
    setQueue(retry);
    setRetry([]);
    setIdx(0);
    setRound((r) => r + 1);
    setFlipped(false);
  };

  const answer = (r) => {
    setReviews((n) => n + 1);
    if (r === "again") {
      setMissed((m) => ({ ...m, [cardId]: true }));
      setRetry((q) => [...q, cardId]);
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

  // An empty deck would otherwise satisfy `done` on the first render and write a
  // zero-review row into the session ledger.
  if (!queue.length && round === 1 && !reviews) {
    return (
      <div style={{ textAlign: "center", paddingTop: 40 }}>
        <div style={{ ...S.display, fontSize: 22, fontWeight: 700 }}>This deck has no cards</div>
        <div style={{ ...S.mono, fontSize: 13, color: C.inkSoft, marginTop: 8 }}>
          Add some in the deck editor first.
        </div>
        <button style={{ ...S.btn("primary"), marginTop: 24 }} onClick={() => onExit(null)}>
          Back to deck
        </button>
      </div>
    );
  }

  // Round finished, but some cards were answered "again" — they come back now.
  if (roundOver && retry.length > 0) {
    return (
      <div style={{ textAlign: "center", paddingTop: 24 }}>
        <div style={{ ...S.display, fontSize: 28, fontWeight: 800 }}>Round {round} done</div>
        <div style={{ ...S.mono, fontSize: 13, color: C.inkSoft, marginTop: 8 }}>
          {retry.length} card{retry.length === 1 ? "" : "s"} you missed{retry.length === 1 ? " comes" : " come"} back now
        </div>
        <button style={{ ...S.btn("primary"), marginTop: 24 }} onClick={startNextRound}>
          Retry {retry.length} card{retry.length === 1 ? "" : "s"}
        </button>
        <LedgerToggle record={record} onChange={setRecord} />
        <div>
          <button style={{ ...S.btn("ghost"), marginTop: 6 }} onClick={() => onExit(progressPayload)}>
            Stop here
          </button>
        </div>
      </div>
    );
  }

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
        <div style={{ ...S.panel, marginTop: 24, textAlign: "left", borderLeft: `4px solid ${record ? C.jade : C.line}`, opacity: record ? 1 : 0.55, transition: "opacity 0.15s" }}>
          <div style={{ ...S.label, marginBottom: 8 }}>Evidence log entry</div>
          <div style={{ ...S.mono, fontSize: 12, lineHeight: 1.6 }}>{logLine}</div>
          <button style={{ ...S.btn("ghost"), marginTop: 12 }} onClick={() => navigator.clipboard && navigator.clipboard.writeText(logLine)}>
            Copy for evidence log
          </button>
        </div>

        <LedgerToggle record={record} onChange={setRecord} />

        <div style={{ display: "flex", gap: 12, marginTop: 18, justifyContent: "center", flexWrap: "wrap" }}>
          <button style={{ ...S.btn("primary"), flex: 1, maxWidth: 220 }} onClick={() => onFinish(progressPayload)}>
            Save &amp; finish
          </button>
          <button style={{ ...S.btn("brass"), flex: 1, maxWidth: 220 }} onClick={() => onRestart(progressPayload)}>
            Study this deck again
          </button>
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
          {remaining} left{round > 1 ? ` · round ${round}` : ""}
          {/* retry.length is what's actually still pending, so this counts down as you
              clear cards. The old counter read from `missed`, which is never unset. */}
          {retry.length > 0 ? ` · ${retry.length} to retry` : ""}
        </span>
        <button style={{ ...S.mono, fontSize: 12, color: C.inkSoft, background: "none", border: "none", cursor: "pointer" }} onClick={() => onExit(progressPayload)}>
          save &amp; exit
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

/* ── DECK VIEW (v2: edit mode + generate more) ── */
function DeckView({ deck, onStudy, onBack, onUpdate }) {
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
      const { cards: fresh } = await generateCards(moreNotes, 10, draft.map((c) => c.front));
      setDraft([...draft, ...fresh]);
      setMoreNotes("");
    } catch (e) {
      setErr(e instanceof QuotaError ? e.message : `Generation failed: ${e.message || e}. Try again.`);
    }
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
        {!editing
          ? <button style={S.btn("ghost")} onClick={startEdit}>Edit deck</button>
          : <>
              <button style={S.btn("brass")} onClick={saveEdit}>Save changes</button>
              <button style={S.btn("ghost")} onClick={() => { setEditing(false); setDraft(null); }}>Discard</button>
            </>
        }
      </div>

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
  const [studyRun, setStudyRun] = useState(0); // bump to remount Study with a fresh queue

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

  // Grades a session and writes it through. Called on finish, on restart, and on exit
  // — exiting used to drop every card you had already graded on the floor.
  const saveSession = ({ missed, cleared, reviews, record = true }) => {
    if (!active || !reviews) return;
    const now = Date.now();
    const decks = data.decks.map((d) =>
      d.id !== active.id ? d : {
        ...d,
        cards: d.cards.map((c) => {
          if (!cleared[c.id] && !missed[c.id]) return c;
          // Missed at any point this session → streak resets, due tomorrow.
          if (missed[c.id]) {
            const days = intervalFor(0);
            return { ...c, reviews: c.reviews + 1, streak: 0, interval: days, due: now + days * DAY };
          }
          // Cleared. Only advance the ladder if the card was actually due — otherwise
          // re-studying a deck for extra practice would march cards 1d → 3d → 7d in a
          // single sitting and bury them for weeks.
          if (!isDue(c)) return { ...c, reviews: c.reviews + 1 };
          const streak = c.streak + 1;
          const days = intervalFor(streak);
          return { ...c, reviews: c.reviews + 1, streak, interval: days, due: now + days * DAY };
        }),
      }
    );
    // Opted out: keep the spaced-repetition progress, skip the history row so a quick
    // re-skim doesn't pad the ledger or inflate the Reviews stat.
    const sessions = record
      ? [...data.sessions, {
          date: now,
          deckTitle: active.title,
          reviewed: reviews,
          cleared: Object.keys(cleared).length,
        }]
      : data.sessions;
    persist({ ...data, decks, sessions });
  };

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
            onDeleteSession={(i) => persist({ ...data, sessions: data.sessions.filter((_, n) => n !== i) })}
            onClearSessions={() => persist({ ...data, sessions: [] })}
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
            onStudy={() => setView("study")}
            onBack={() => setView("home")}
            onUpdate={(updated) => persist({ ...data, decks: data.decks.map((d) => (d.id === updated.id ? updated : d)) })}
          />
        )}

        {view === "study" && active && (
          <Study
            // Remounting on restart is what resets the queue, index and grading state.
            key={`${active.id}-${studyRun}`}
            deck={active}
            onExit={(payload) => { if (payload) saveSession(payload); setView("deck"); }}
            onFinish={(payload) => { saveSession(payload); setView("deck"); }}
            onRestart={(payload) => { saveSession(payload); setStudyRun((n) => n + 1); }}
          />
        )}
      </div>
    </div>
  );
}
