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
- Miss recycling: "Again" re-queues the card within the same session
- Deck editing: fix cards, add manually, or paste new notes to append non-duplicate cards
- Session ledger + copyable evidence-log line per session

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

Better practice — store the key in Secret Manager instead of an env var:

```bash
echo -n "your-key" | gcloud secrets create gemini-api-key --data-file=-
gcloud run deploy study-forge \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

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
