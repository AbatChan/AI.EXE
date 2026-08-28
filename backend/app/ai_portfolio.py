"""Blinded, paper-only AI portfolio evaluator."""
import math
from statistics import pstdev


DEFAULT_SYMBOLS = ("BAC", "AAPL", "MSFT", "JPM", "XOM", "JNJ")
ALLOWED_WEIGHTS = {0, 25, 50}


def _return_bps(start: int, end: int) -> int:
    return round((end / start - 1) * 10000) if start else 0


def _features(prices: list[int]) -> dict:
    returns = [(prices[i] / prices[i - 1] - 1) for i in range(1, len(prices))]
    peak = prices[0]
    drawdown = 0.0
    for price in prices:
        peak = max(peak, price)
        drawdown = min(drawdown, price / peak - 1)
    return {
        "momentum_20d_bps": _return_bps(prices[-21], prices[-1]),
        "momentum_60d_bps": _return_bps(prices[-61], prices[-1]),
        "volatility_20d_bps": round(pstdev(returns[-20:]) * math.sqrt(252) * 10000),
        "drawdown_60d_bps": round(drawdown * 10000),
    }


def build_episodes(histories: dict, count: int = 6, horizon: int = 20) -> list[dict]:
    by_symbol = {symbol: {row["date"]: int(row["close_cents"]) for row in rows}
                 for symbol, rows in histories.items()}
    common = sorted(set.intersection(*(set(rows) for rows in by_symbol.values())))
    minimum = 61 + count * horizon
    if len(common) < minimum:
        raise ValueError(f"Need at least {minimum} common market days; received {len(common)}.")
    assets = list(histories)
    episodes = []
    for number in range(count):
        end = len(common) - (count - number - 1) * horizon - 1
        start = end - horizon
        lookback = common[start - 60:start + 1]
        episode_assets = []
        realized = {}
        for index, symbol in enumerate(assets):
            alias = chr(65 + index)
            prices = [by_symbol[symbol][day] for day in lookback]
            episode_assets.append({"id": alias, **_features(prices)})
            realized[alias] = _return_bps(by_symbol[symbol][common[start]], by_symbol[symbol][common[end]])
        episodes.append({"id": number + 1, "assets": episode_assets, "realized_bps": realized})
    return episodes


def research_messages(episodes: list[dict]) -> list[dict]:
    visible = [{"episode": item["id"], "assets": item["assets"]} for item in episodes]
    return [
        {"role": "system", "content": (
            "You are a cautious portfolio research model. This is a blinded historical evaluation, not live trading. "
            "Return JSON only with an 'episodes' array. For every episode return: episode integer, allocations object "
            "mapping every asset ID to one of 0, 25, or 50, and rationale under 160 characters. Hold at most two assets; "
            "weights may total at most 100. Do not infer identities, dates, prices, or promise returns.")},
        {"role": "user", "content": f"Evaluate these independent episodes using only their supplied factors: {visible}"},
    ]


def _validated_decision(raw: object, episode: dict) -> tuple[dict, bool, str]:
    aliases = [asset["id"] for asset in episode["assets"]]
    cash = {alias: 0 for alias in aliases}
    if not isinstance(raw, dict) or raw.get("episode") != episode["id"]:
        return cash, False, "missing or mismatched episode"
    allocations = raw.get("allocations")
    if not isinstance(allocations, dict) or set(allocations) != set(aliases):
        return cash, False, "allocation keys do not match"
    if any(type(allocations[key]) is not int or allocations[key] not in ALLOWED_WEIGHTS for key in aliases):
        return cash, False, "weights must be 0, 25, or 50"
    if sum(allocations.values()) > 100 or sum(value > 0 for value in allocations.values()) > 2:
        return cash, False, "portfolio exceeds limits"
    return allocations, True, str(raw.get("rationale") or "")[:160]


def score_research(episodes: list[dict], response: object, cost_bps: int = 10) -> dict:
    rows = response.get("episodes") if isinstance(response, dict) else None
    rows = rows if isinstance(rows, list) else []
    indexed = {row.get("episode"): row for row in rows if isinstance(row, dict)}
    wealth = {"ai": 1.0, "momentum": 1.0, "equal_weight": 1.0}
    details = []
    valid = 0
    for episode in episodes:
        allocation, ok, note = _validated_decision(indexed.get(episode["id"]), episode)
        valid += int(ok)
        realized = episode["realized_bps"]
        ai_gross = sum(allocation[key] / 100 * realized[key] for key in allocation)
        ai_cost = sum(allocation.values()) / 100 * cost_bps
        ranked = sorted(realized, key=lambda key: next(
            asset["momentum_20d_bps"] for asset in episode["assets"] if asset["id"] == key), reverse=True)[:2]
        momentum = sum(realized[key] * .5 for key in ranked) - cost_bps
        equal = sum(realized.values()) / len(realized) - cost_bps
        returns = {"ai": round(ai_gross - ai_cost), "momentum": round(momentum), "equal_weight": round(equal)}
        for key, value in returns.items():
            wealth[key] *= 1 + value / 10000
        details.append({"episode": episode["id"], "valid": ok, "note": note,
                        "allocations": allocation, "returns_bps": returns})
    totals = {key: round((value - 1) * 10000) for key, value in wealth.items()}
    leader = max(totals, key=totals.get)
    return {"episodes": details, "valid_decisions": valid, "total_decisions": len(episodes),
            "returns_bps": totals, "leader": leader,
            "verdict": "research_only" if valid == len(episodes) else "model_output_unreliable"}
