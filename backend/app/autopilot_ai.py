"""AI entry review for the autopilot. It can only say yes or no."""
from .llm import LLMClient
from .provider import is_local_provider

SYSTEM = (
    "You review one proposed crypto entry for an automated paper-trading account. "
    "Hard rules already found an hourly uptrend with a 24-hour breakout; stops, sizing and exits "
    "are fixed and not yours to change. Veto entries that look like late chases after a spike, "
    "thin one-candle moves, or a market where most coins are falling. Approve clean, broad trends. "
    'Reply with JSON only: {"approve": true|false, "reason": "<one short plain sentence>"}'
)


def make_reviewer(provider_store, api_key_store, usage_manager):
    def review(symbol: str, signal: dict, context: dict) -> dict:
        base_url, model = provider_store.resolve()
        if not base_url:
            raise RuntimeError("no AI provider configured")
        local = is_local_provider(base_url)
        api_key = api_key_store.get_for_internal_use() or ("local" if local else None)
        if not api_key:
            raise RuntimeError("no provider API key")
        if not local:
            usage_manager.consume()
        facts = {
            "coin": symbol,
            "change_1h_pct": round(signal["change_1h"] * 100, 2),
            "change_6h_pct": round(signal["change_6h"] * 100, 2),
            "hourly_volatility_pct": round(signal["volatility"] * 100, 2),
            "trend_strength": signal["score"],
            **context,
        }
        result = LLMClient(base_url, model, api_key, kind=provider_store.kind(), timeout=90).complete_json(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": str(facts)}], max_tokens=400)
        data = result.get("data") or {}
        return {"approve": data.get("approve") is True, "reason": data.get("reason") or ""}

    return review
