"""Live model prices for the Usage spend estimate.

Providers don't publish prices through their APIs, so this reads LiteLLM's widely
used price list (per-token rates, including OpenAI Flex/priority/batch tiers), keeps
only the providers AI.EXE uses, and caches it on disk for a day. Offline or on a bad
response the UI falls back to its built-in table.
"""
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

SOURCE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
SOURCE_NAME = "LiteLLM price list"
CACHE_TTL_S = 24 * 3600
MAX_BYTES = 12_000_000
# LiteLLM provider name -> AI.EXE provider id.
PROVIDERS = {
    "openai": "openai",
    "anthropic": "anthropic",
    "gemini": "gemini",
    "vertex_ai-language-models": "gemini",
    "deepseek": "deepseek",
}
# LiteLLM field suffix -> AI.EXE tier name.
TIERS = {"_flex": "flex", "_priority": "fast", "_batches": "batch"}


def fetch_source(url: str = SOURCE_URL, timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "AI.EXE usage prices"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("price list too large")
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("unexpected price list")
    return data


def _per_million(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return round(v * 1_000_000, 6) if 0 <= v < 1 else None


def _rates(entry: dict, suffix: str = "") -> dict:
    out = {}
    for key, field in (("input", "input_cost_per_token"), ("cached", "cache_read_input_token_cost"),
                       ("write", "cache_creation_input_token_cost"), ("output", "output_cost_per_token")):
        v = _per_million(entry.get(field + suffix))
        if v is not None:
            out[key] = v
    return out


def normalize(data: dict) -> dict:
    """{provider: {model: {input, cached, write, output, tiers: {flex: {...}}}}} per 1M tokens."""
    models: dict = {}
    for key, entry in (data or {}).items():
        if not isinstance(entry, dict) or entry.get("mode", "chat") not in ("chat", "responses"):
            continue
        provider = PROVIDERS.get(str(entry.get("litellm_provider") or ""))
        if not provider:
            continue
        name = str(key).split("/")[-1].strip().lower()
        if not name or len(name) > 120:
            continue
        base = _rates(entry)
        if "input" not in base or "output" not in base:
            continue
        tiers = {}
        for suffix, tier in TIERS.items():
            t = _rates(entry, suffix)
            if "input" in t and "output" in t:
                tiers[tier] = t
        if tiers:
            base["tiers"] = tiers
        models.setdefault(provider, {}).setdefault(name, base)
    return models


class ModelPriceCache:
    def __init__(self, path: Path, fetcher=fetch_source):
        self.path = Path(path)
        self._fetch = fetcher
        self._lock = threading.Lock()

    def _load(self):
        try:
            data = json.loads(self.path.read_text("utf-8"))
            return data if isinstance(data, dict) and isinstance(data.get("models"), dict) else None
        except (OSError, ValueError):
            return None

    def get(self, force: bool = False, now=None) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            cached = self._load()
            if cached and not force and now - float(cached.get("fetched_at") or 0) < CACHE_TTL_S:
                return cached
            try:
                models = normalize(self._fetch())
                if not models:
                    raise ValueError("no usable prices")
                fresh = {"source": SOURCE_NAME, "url": SOURCE_URL, "fetched_at": now, "models": models}
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(fresh, separators=(",", ":")), "utf-8")
                os.replace(tmp, self.path)
                return fresh
            except Exception:
                # Stale beats nothing; nothing lets the UI use its built-in table.
                if cached:
                    return {**cached, "stale": True}
                return {"source": "", "fetched_at": 0, "models": {}, "offline": True}
