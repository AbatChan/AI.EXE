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
            for day in range(181)
        ]
    episodes = build_episodes(histories, count=6)
    assert len(episodes) == 6
    prompt = str(research_messages(episodes))
    assert all(symbol not in prompt for symbol in histories)
    assert "D060" not in prompt

    decisions = {"episodes": [
        {"episode": item["id"], "allocations": {"A": 50, "B": 50, "C": 0}, "rationale": "test"}
        for item in episodes
    ]}
    scored = score_research(episodes, decisions)
    assert scored["valid_decisions"] == 6
    assert set(scored["returns_bps"]) == {"ai", "momentum", "equal_weight"}

    decisions["episodes"][0]["allocations"] = {"A": 50, "B": 50, "C": 50}
    rejected = score_research(episodes, decisions)
    assert rejected["valid_decisions"] == 5
    assert rejected["episodes"][0]["allocations"] == {"A": 0, "B": 0, "C": 0}
    assert rejected["verdict"] == "model_output_unreliable"
    print("AI portfolio research smoke test: ok")


if __name__ == "__main__":
    main()
