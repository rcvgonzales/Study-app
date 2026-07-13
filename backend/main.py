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

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
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


async def call_gemini(prompt: str, max_tokens: int) -> str:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            url,
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": max_tokens},
            },
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, f"Gemini API error: {resp.text[:300]}")
    data = resp.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
        return "\n".join(p.get("text", "") for p in parts)
    except (KeyError, IndexError):
        raise HTTPException(502, f"Unexpected Gemini response: {str(data)[:300]}")


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

    max_tokens = min(req.max_tokens, 2000)
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
