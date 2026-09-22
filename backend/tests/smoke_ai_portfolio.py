"""Smoke tests for the blinded AI portfolio research boundary."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ai_portfolio import build_episodes, research_messages, score_research


def main():
    histories = {}
    for offset, symbol in enumerate(("BAC", "AAPL", "MSFT")):
        histories[symbol] = [
            {"date": f"D{day:03d}", "close_cents": 10000 + offset * 500 + day * (8 + offset)}
            for day in range(182)
        ]
    episodes = build_episodes(histories, count=6)
    assert len(episodes) == 6
    prompt = str(research_messages(episodes))
    assert all(symbol not in prompt for symbol in histories)
    assert "D060" not in prompt
    assert "price_path" not in prompt and "realized_bps" not in prompt
    assert all(item["signal_date"] < item["from_date"] for item in episodes)

    decisions = {"episodes": [
        {"episode": item["id"], "allocations": {"A": 50, "B": 50, "C": 0}, "rationale": "test"}
        for item in episodes
    ]}
    scored = score_research(episodes, decisions)
    assert scored["valid_decisions"] == 6
    assert set(scored["returns_bps"]) == {"ai", "momentum", "equal_weight"}
    assert scored["positive_periods"]["ai"] == 6
    assert scored["costs_bps_of_initial_equity"]["ai"] >= 60
    # Intraperiod losses must survive a positive ending return.
    stressed = [dict(episodes[0], price_path=[{"A": 1, "B": 1, "C": 1},
                                            {"A": .5, "B": .5, "C": .5},
                                            {"A": 1.1, "B": 1.1, "C": 1.1}])]
    assert score_research(stressed, decisions)["max_drawdown_bps"]["ai"] == 5000
    for bad_price in (0, -100, float("nan"), True):
        broken = {key: [dict(row) for row in rows] for key, rows in histories.items()}
        broken["BAC"][0]["close_cents"] = bad_price
        try:
            build_episodes(broken)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid price accepted")
    duplicated = {**histories, "BAC": histories["BAC"] + [histories["BAC"][0]]}
    try:
        build_episodes(duplicated)
    except ValueError:
        pass
    else:
        raise AssertionError("Duplicate date accepted")
    changed = {key: [dict(row) for row in rows] for key, rows in histories.items()}
    for rows in changed.values():
        rows[62]["close_cents"] *= 2
    assert build_episodes(changed)[0]["assets"] == episodes[0]["assets"]

    decisions["episodes"][0]["allocations"] = {"A": 50, "B": 50, "C": 50}
    rejected = score_research(episodes, decisions)
    assert rejected["valid_decisions"] == 5
    assert rejected["episodes"][0]["allocations"] == {"A": 0, "B": 0, "C": 0}
    assert rejected["verdict"] == "model_output_unreliable"
    print("AI portfolio research smoke test: ok")


if __name__ == "__main__":
    main()
