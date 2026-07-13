# Study Forge

Cert-prep study tool: paste notes → AI summary → flashcards → spaced-repetition sessions.

- **Frontend:** React (Vite) — teal/jade/brass, Bricolage Grotesque / Figtree / JetBrains Mono
- **Backend:** FastAPI LLM proxy (Gemini free tier or Anthropic — key stays server-side) + static file server
- **Storage:** browser localStorage (single-user, per-browser)
- **Deploy target:** Google Cloud Run (single container)

## Features

- Paste raw notes → exam-oriented AI summary
- Generate 5–20 flashcards per deck (editable before saving)
- Spaced repetition: 1d → 3d → 7d → 21d → 50d interval ladder with per-card due dates
- Miss recycling: cards you answer "Again" come back in the next round, so every card is
  seen once before any repeats and the session always terminates
- Deck editing: fix cards, add manually, or paste new notes to append non-duplicate cards
- Session ledger + copyable evidence-log line, opt-out per session, individually deletable
  (card scheduling always saves; the ledger row is the only optional part)

## API key (pick one)

- **Free — Google Gemini:** get a key at https://aistudio.google.com/apikey (no credit card). Set `GEMINI_API_KEY`.
- **Paid — Anthropic Claude:** get a key at https://console.anthropic.com. Set `ANTHROPIC_API_KEY`.

The backend auto-selects: Gemini if its key is present, otherwise Anthropic.
Force a provider with `PROVIDER=gemini` or `PROVIDER=anthropic`.

## Local development

Requires Node 20+ and Python 3.11+.

```bash
# 1. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY=your-key-here   # free at aistudio.google.com/apikey
uvicorn main:app --reload --port 8000

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — Vite proxies `/api/*` to the backend automatically.

## Docker (production-style, one container)

```bash
docker build -t study-forge .
docker run -p 8080:8080 -e GEMINI_API_KEY=your-key study-forge
```

Open http://localhost:8080.

## Deploy to Cloud Run

```bash
gcloud run deploy study-forge \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your-key
```

Better practice — store the key in Secret Manager instead of an env var. **All three steps are
required**; skipping the IAM grant is the most common way this deploy fails:

```bash
# 1. Store the key. -n matters: a trailing newline becomes part of the secret and
#    corrupts the ?key= query param, producing a confusing 400 from Google later.
echo -n "your-key" | gcloud secrets create gemini-api-key --data-file=-

# 2. Let Cloud Run's service account actually READ it.
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:$(gcloud projects describe "$(gcloud config get-value project)" \
      --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# 3. Deploy.
gcloud run deploy study-forge \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

**Step 2 is not optional, and `roles/editor` does not cover it.** Secret Manager deliberately
excludes secret-payload access from the legacy basic roles, so a service account with Editor still
gets `Permission denied on secret ... versions/latest` and the revision never starts.

### Gemini free-tier quotas

The free tier meters **requests per day**, not just per minute, and the limit on the flagship flash
line is roughly **20 requests/day** — about two decks before a hard wall. Quota is metered per
(project × model), so `backend/main.py` walks a fallback chain: `gemini-flash-lite-latest` first
(far more daily headroom, and noticeably faster), falling back to `gemini-flash-latest`.

- **Don't set `GEMINI_MODEL` in production** — it pins one model and *disables* the fallback chain.
  It exists for local testing.
- A `429` after the whole chain is exhausted means the daily quota is genuinely gone; it resets at
  midnight Pacific. Retrying or waiting will not help.
- Linking a billing account to the project moves it **off** the free tier onto a paid/prepay plan.
  If that plan has a zero balance, every call returns `429 RESOURCE_EXHAUSTED` even though the key
  is perfectly valid. A key authenticates against *its own* project, so a key issued from an
  unbilled project keeps the free tier regardless of where Cloud Run runs.

**Cost note:** the app is public if `--allow-unauthenticated` is set, meaning anyone with the URL can trigger LLM calls on your key/quota. For a personal tool, either keep the URL private, put it behind Cloud Run's IAM auth (`--no-allow-unauthenticated` + `gcloud run services proxy`), or add a simple shared-password check to the proxy.

## Data portability

All decks and sessions live in one localStorage key: `study-forge-decks-v1`.
Back up from the browser console:

```js
copy(localStorage.getItem("study-forge-decks-v1"))
```

Restore by pasting into `localStorage.setItem("study-forge-decks-v1", "<json>")`.

## Structure

```
study-forge/
├── Dockerfile            # multi-stage: node build → python runtime
├── backend/
│   ├── main.py           # FastAPI: /api/claude proxy + static serving
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js    # dev proxy /api → :8000
    └── src/
        ├── main.jsx
        └── App.jsx       # entire app (single component file)
```
