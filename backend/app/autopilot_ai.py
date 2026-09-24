"""AI entry review for the autopilot. It can only say yes or no."""
import json
import os
from urllib.parse import urlparse

from .llm import LLMClient
from .provider import is_local_provider


# A ceiling, not a target: reasoning models (e.g. gpt-5-mini) think before the short JSON
# and returned nothing at 400 in testing. Only tokens actually used are billed.
REPLY_TOKENS = 1500


class AutopilotAIStore:
    """The autopilot's own AI choice, separate from chat. The key file is 0600 and never returned."""

    def __init__(self, data_dir: str):
        self._cfg = os.path.join(data_dir, "autopilot_ai.json")
        self._key = os.path.join(data_dir, "autopilot_ai_key")

    def get(self) -> dict:
        try:
            with open(self._cfg, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if data.get("base_url") and data.get("model") else {}
        except (OSError, ValueError):
            return {}

    def key(self) -> str:
        try:
            with open(self._key, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            return ""

    def set(self, base_url: str, model: str, api_key: str, label: str = "") -> dict:
        url = urlparse(str(base_url or "").strip())
        local = url.hostname in ("127.0.0.1", "localhost")
        if url.scheme != "https" and not (local and url.scheme == "http"):
            raise ValueError("The AI endpoint must use https.")
        model = str(model or "").strip()
        if not model or len(model) > 120:
            raise ValueError("Choose a model.")
        if not str(api_key or "").strip() and not local:
            raise ValueError("That provider needs an API key.")
        data = {"base_url": base_url.strip().rstrip("/"), "model": model, "label": str(label or "")[:60]}
        with open(self._cfg, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        fd = os.open(self._key, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(str(api_key or "").strip())
        os.chmod(self._key, 0o600)
        return data

    def clear(self) -> None:
        for path in (self._cfg, self._key):
            try:
                os.remove(path)
            except OSError:
                pass


def _connection(provider_store, api_key_store, ai_store):
    """(base_url, model, kind, api_key, local): the autopilot's own choice, else the chat's."""
    own = ai_store.get() if ai_store else {}
    if own:
        base_url, model, api_key, kind = own["base_url"], own["model"], ai_store.key(), "openai"
    else:
        base_url, model = provider_store.resolve()
        api_key, kind = api_key_store.get_for_internal_use(), provider_store.kind()
    if not base_url:
        raise RuntimeError("no AI provider configured")
    local = is_local_provider(base_url)
    api_key = api_key or ("local" if local else None)
    if not api_key:
        raise RuntimeError("no provider API key")
    return base_url, model, kind, api_key, local

SYSTEM = (
    "You review one proposed crypto entry for an automated paper-trading account. "
    "Hard rules already found an hourly uptrend with a 24-hour breakout; stops, sizing and exits "
    "are fixed and not yours to change. What research and our own backtests show: about half of hourly "
    "breakouts fail and reverse; breakouts on below-average volume (volume_ratio < 1) and prices stretched far "
    "above their 20-hour average (above_ema20_pct) fail more often; alt-coin entries do worse while BTC is "
    "falling (btc_trend); and fees make marginal trades lose. Approve only clean, well-supported trends; "
    "veto late chases after a spike, thin one-candle moves, weak-volume breakouts and entries against a falling market. "
    "recent_lessons lists why past losing entries lost; veto setups that repeat those mistakes. "
    "Give a specific reason that names the deciding fact. "
    'Reply with JSON only: {"approve": true|false, "reason": "<one short plain sentence>"}'
)


def make_reviewer(provider_store, api_key_store, usage_manager, ai_store=None):
    def review(symbol: str, signal: dict, context: dict) -> dict:
        base_url, model, kind, api_key, local = _connection(provider_store, api_key_store, ai_store)
        if not local:
            usage_manager.consume()
        facts = {
            "coin": symbol,
            "change_1h_pct": round(signal["change_1h"] * 100, 2),
            "change_6h_pct": round(signal["change_6h"] * 100, 2),
            "hourly_volatility_pct": round(signal["volatility"] * 100, 2),
            "trend_strength": signal["score"],
            "volume_ratio": signal.get("volume_ratio"),
            "above_ema20_pct": signal.get("above_ema20_pct"),
            **context,
        }
        result = LLMClient(base_url, model, api_key, kind=kind, timeout=90).complete_json(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": str(facts)}], max_tokens=REPLY_TOKENS)
        data = result.get("data") or {}
        return {"approve": data.get("approve") is True, "reason": data.get("reason") or ""}

    return review


LESSON_SYSTEM = (
    "A paper-trading autopilot just closed a losing crypto trade. From the facts, explain in ONE short, "
    "specific sentence why it most likely lost and what pattern to avoid next time (e.g. entry conditions, "
    "market breadth, volatility). No hedging, no advice to the user. "
    'Reply with JSON only: {"lesson": "<one sentence>"}'
)


def make_lesson_writer(provider_store, api_key_store, usage_manager, ai_store=None):
    def write(trade: dict) -> str:
        base_url, model, kind, api_key, local = _connection(provider_store, api_key_store, ai_store)
        if not local:
            usage_manager.consume()
        entry, exit_, peak = trade.get("entry") or 0, trade.get("exit") or 0, trade.get("peak") or 0
        facts = {
            "coin": trade.get("symbol"), "why_it_was_bought": trade.get("entry_reason"),
            "entry_setup": trade.get("setup"), "exit_rule": trade.get("reason"),
            "result_pct": round((exit_ / entry - 1) * 100, 2) if entry else None,
            "best_gain_while_held_pct": round((peak / entry - 1) * 100, 2) if entry and peak else None,
            "opened_at": trade.get("opened_at"), "closed_at": trade.get("closed_at"),
        }
        result = LLMClient(base_url, model, api_key, kind=kind, timeout=90).complete_json(
            [{"role": "system", "content": LESSON_SYSTEM}, {"role": "user", "content": str(facts)}], max_tokens=REPLY_TOKENS)
        return str((result.get("data") or {}).get("lesson") or "")

    return write
