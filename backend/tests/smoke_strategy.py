"""Smoke test for the walk-forward paper strategy lab."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.strategy import analyze_history, backtest_sma


def main():
    rows = []
    price = 10000
    for index in range(160):
        price += 25 if index < 90 or index > 120 else -40
        rows.append({"date": f"2026-{(index // 28) + 1:02d}-{(index % 28) + 1:02d}",
                     "close_cents": price})
    report = analyze_history(rows)
    assert report["observations"] == 160
    assert report["test_observations"] > 0
    assert len(report["candidates"]) == 3
    assert report["selected"]["name"].startswith("SMA ")
    assert "training_score_bps" in report["selected"]
    assert report["recommendation"] in ("long", "cash")
    assert report["benchmark"]["name"] == "Buy and hold"
    assert report["selected"]["test"]["total_costs_cents"] >= 0
    assert report["benchmark"]["total_costs_cents"] >= 0

    falling = [20000 - index * 50 for index in range(100)]
    result = backtest_sma(falling, 5, 20, 20)
    assert result["trades"] == 0
    assert result["ending_equity_cents"] == result["starting_equity_cents"]
    assert result["total_costs_cents"] == 0
    print("strategy smoke test: ok")


if __name__ == "__main__":
    main()
