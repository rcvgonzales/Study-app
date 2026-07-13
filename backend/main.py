"""Study Forge backend.

Serves the built React frontend and proxies LLM calls so API keys never
reach the browser. Supports two providers, auto-selected by which key is set:

  GEMINI_API_KEY     -> Google Gemini (free tier, no billing required)
                        https://aistudio.google.com/apikey
  ANTHROPIC_API_KEY  -> Anthropic Claude (paid, pennies at this usage)
                        https://console.anthropic.com

If both are set, Gemini wins (it's free). Override with PROVIDER=anthropic.
"""

import os
import re

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
# Aliases, not pinned versions: Google retires pinned models for new projects
# (gemini-2.5-flash already 404s on projects created after its cutoff).
#
# Ordered by free-tier daily quota, most generous first. The flagship flash line
# allows only ~20 requests PER DAY on the free tier — about two decks before a hard
# wall — while flash-lite has far more headroom and is faster. Quota is metered per
# (project x model), so falling back to a second model genuinely buys more capacity
# rather than hitting the same bucket twice.
# Setting GEMINI_MODEL pins one model and disables the fallback.
GEMINI_MODELS = (
    [os.environ["GEMINI_MODEL"]]
    if os.environ.get("GEMINI_MODEL")
    else ["gemini-flash-lite-latest", "gemini-flash-latest"]
)
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")

_forced = os.environ.get("PROVIDER", "").lower()
if _forced in ("gemini", "anthropic"):
    PROVIDER = _forced
elif GEMINI_API_KEY:
    PROVIDER = "gemini"
elif ANTHROPIC_API_KEY:
    PROVIDER = "anthropic"
else:
    PROVIDER = ""

app = FastAPI(title="Study Forge")


class LLMRequest(BaseModel):
    prompt: str
    max_tokens: int = 1000


def _generation_config(model: str, max_tokens: int) -> dict:
    cfg = {"maxOutputTokens": max_tokens}
    # Flash models think by default, and thinking tokens are charged against
    # maxOutputTokens. Left on, reasoning eats the whole budget and the JSON comes
    # back truncated. Card generation needs no reasoning at all.
    # Flash only: pro models must think and reject a 0 budget, and older models
    # don't accept the field — either would 400 on every call.
    if "flash" in model and not any(v in model for v in ("1.5", "2.0")):
        cfg["thinkingConfig"] = {"thinkingBudget": 0}
    return cfg


def _is_daily_quota(resp: httpx.Response) -> bool:
    """A per-DAY exhaustion can't be waited out; a per-minute one can."""
    try:
        details = resp.json()["error"]["details"]
    except Exception:
        return False
    return any(
        "PerDay" in v.get("quotaId", "")
        for d in details
        for v in d.get("violations", [])
    )


def _retry_after(resp: httpx.Response) -> int:
    try:
        details = resp.json()["error"]["details"]
    except Exception:
        return 0
    for d in details:
        m = re.match(r"(\d+)s", str(d.get("retryDelay", "")))
        if m:
            return int(m.group(1))
    return 0


def _gemini_text(data: dict, max_tokens: int) -> str:
    try:
        candidate = data["candidates"][0]
    except (KeyError, IndexError):
        raise HTTPException(502, f"Unexpected Gemini response: {str(data)[:300]}")

    # Truncated output is still 200 OK with parseable-looking text. Fail loudly
    # instead of handing the caller half a JSON array.
    if candidate.get("finishReason") == "MAX_TOKENS":
        raise HTTPException(
            502, f"Gemini truncated its response at the {max_tokens}-token limit."
        )
    try:
        parts = candidate["content"]["parts"]
    except KeyError:
        raise HTTPException(502, f"Unexpected Gemini response: {str(data)[:300]}")
    return "\n".join(p.get("text", "") for p in parts)


async def call_gemini(prompt: str, max_tokens: int) -> str:
    spent = None  # last 429 seen, so we can report the right thing if all models fail
    async with httpx.AsyncClient(timeout=60) as client:
        for model in GEMINI_MODELS:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent?key={GEMINI_API_KEY}",
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": _generation_config(model, max_tokens),
                },
            )
            # 429 = this model's quota is spent; 404 = retired for this project.
            # Either way the next model in the chain has its own quota and may answer.
            if resp.status_code in (404, 429):
                if resp.status_code == 429:
                    spent = resp
                continue
            if resp.status_code != 200:
                raise HTTPException(
                    resp.status_code, f"Gemini API error ({model}): {resp.text[:300]}"
                )
            return _gemini_text(resp.json(), max_tokens)

    if spent is None:
        raise HTTPException(
            502, f"No usable Gemini model (tried {', '.join(GEMINI_MODELS)})"
        )
    # Every model is rate-limited. Say which kind, because the answers differ:
    # a per-minute limit clears on its own, a daily cap does not.
    if _is_daily_quota(spent):
        raise HTTPException(
            429,
            "Daily free-tier quota is used up for every available Gemini model. "
            "It resets at midnight Pacific — or add billing to raise the limit.",
        )
    wait = _retry_after(spent) or 30
    raise HTTPException(
        429, f"Gemini is rate-limiting right now. Wait about {wait}s and try again."
    )


async def call_anthropic(prompt: str, max_tokens: int) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": CLAUDE_MODEL,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, f"Anthropic API error: {resp.text[:300]}")
    data = resp.json()
    # Same trap as Gemini: a truncated reply is still 200 OK, and half a JSON array
    # parses as garbage downstream rather than failing.
    if data.get("stop_reason") == "max_tokens":
        raise HTTPException(
            502, f"Claude truncated its response at the {max_tokens}-token limit."
        )
    return "\n".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )


@app.post("/api/claude")  # endpoint name kept for frontend compatibility
async def llm_proxy(req: LLMRequest):
    if not PROVIDER:
        raise HTTPException(
            500,
            "No API key configured. Set GEMINI_API_KEY (free: aistudio.google.com/apikey) "
            "or ANTHROPIC_API_KEY.",
        )
    if len(req.prompt) > 50_000:
        raise HTTPException(413, "Prompt too long")

    # 20 cards of JSON runs ~700-900 tokens; the ceiling is a cost guard, not a target.
    max_tokens = min(req.max_tokens, 8000)
    if PROVIDER == "gemini":
        text = await call_gemini(req.prompt, max_tokens)
    else:
        text = await call_anthropic(req.prompt, max_tokens)
    return {"text": text, "provider": PROVIDER}


@app.get("/api/health")
async def health():
    return {"ok": True, "provider": PROVIDER or "none"}


static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
