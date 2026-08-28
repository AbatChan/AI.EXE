"""Small, auditable paper-strategy lab."""
from typing import List


STARTING_CASH_CENTS = 50000
SLIPPAGE_BPS = 5
TRAIN_RATIO = 0.70
SMA_CANDIDATES = ((5, 20), (10, 50), (20, 50))


def _sma(values: List[int], end: int, window: int) -> float:
    return sum(values[end - window:end]) / window


def _metrics(curve: List[int], trades: int, starting_cash: int,
             slippage_cost_cents: int = 0, commission_cents: int = 0) -> dict:
    peak = starting_cash
    max_drawdown = 0
    for equity in curve:
        peak = max(peak, equity)
        if peak:
            max_drawdown = max(max_drawdown, int(round((peak - equity) * 10000 / peak)))
    ending = curve[-1] if curve else starting_cash
    return {
        "starting_equity_cents": starting_cash,
        "ending_equity_cents": ending,
        "total_return_bps": int(round((ending - starting_cash) * 10000 / starting_cash)),
        "max_drawdown_bps": max_drawdown,
        "trades": trades,
        "slippage_cost_cents": int(slippage_cost_cents),
        "commission_cents": int(commission_cents),
        "total_costs_cents": int(slippage_cost_cents) + int(commission_cents),
    }


def backtest_sma(closes: List[int], short: int, long: int, start: int,
                 starting_cash: int = STARTING_CASH_CENTS,
                 slippage_bps: int = SLIPPAGE_BPS) -> dict:
    """Long/cash SMA crossover; yesterday's signal fills at today's close."""
    cash = starting_cash
    quantity = 0
    trades = 0
    slippage_cost = 0
    curve = []
    for index in range(start, len(closes)):
        signal_end = index
        if signal_end < long:
            curve.append(cash + quantity * closes[index])
            continue
        wants_long = _sma(closes, signal_end, short) > _sma(closes, signal_end, long)
        price = closes[index]
        drift = int(round(price * slippage_bps / 10000))
        if wants_long and quantity == 0:
            fill = price + drift
            quantity = cash // fill
            if quantity:
                cash -= quantity * fill
                slippage_cost += quantity * drift
                trades += 1
        elif not wants_long and quantity:
            fill = max(1, price - drift)
            cash += quantity * fill
            slippage_cost += quantity * drift
            quantity = 0
            trades += 1
        curve.append(cash + quantity * price)
    result = _metrics(curve, trades, starting_cash, slippage_cost)
    result.update({"name": f"SMA {short}/{long}", "short_window": short, "long_window": long})
    return result


def backtest_buy_hold(closes: List[int], start: int,
                      starting_cash: int = STARTING_CASH_CENTS,
                      slippage_bps: int = SLIPPAGE_BPS) -> dict:
    price = closes[start]
    fill = price + int(round(price * slippage_bps / 10000))
    quantity = starting_cash // fill
    cash = starting_cash - quantity * fill
    curve = [cash + quantity * close for close in closes[start:]]
    result = _metrics(curve, 1 if quantity else 0, starting_cash, quantity * (fill - price))
    result.update({"name": "Buy and hold"})
    return result


def analyze_history(rows: List[dict]) -> dict:
    if len(rows) < 80:
        raise ValueError("at least 80 daily closes are required")
    closes = [int(row["close_cents"]) for row in rows]
    split = max(55, int(len(closes) * TRAIN_RATIO))
    if len(closes) - split < 20:
        split = len(closes) - 20

    candidates = []
    for short, long in SMA_CANDIDATES:
        train = backtest_sma(closes[:split], short, long, long)
        test = backtest_sma(closes, short, long, split)
        score = train["total_return_bps"] - train["max_drawdown_bps"]
        candidates.append({
            "name": train["name"],
            "short_window": short,
            "long_window": long,
            "training": train,
            "test": test,
            "training_score_bps": score,
        })

    candidates.sort(
        key=lambda row: (row["training_score_bps"], row["training"]["total_return_bps"]),
        reverse=True,
    )
    best = candidates[0]
    short = best["short_window"]
    long = best["long_window"]
    latest_short = _sma(closes, len(closes), short)
    latest_long = _sma(closes, len(closes), long)
    benchmark = backtest_buy_hold(closes, split)
    recommendation = "cash" if best["test"]["total_return_bps"] <= 0 else (
        "long" if latest_short > latest_long else "cash"
    )
    return {
        "observations": len(rows),
        "from_date": rows[0]["date"],
        "to_date": rows[-1]["date"],
        "training_observations": split,
        "test_observations": len(rows) - split,
        "candidates": candidates,
        "benchmark": benchmark,
        "selected": best,
        "latest_short_cents": int(round(latest_short)),
        "latest_long_cents": int(round(latest_long)),
        "recommendation": recommendation,
        "disclaimer": "Research signal only. Paper mode, manual confirmation, no guaranteed return.",
    }
