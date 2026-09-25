"""Smoke test for the token-usage ledger (monthly sums per provider/model)."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.token_usage import TokenUsageLedger


def main():
    d = Path(tempfile.mkdtemp())
    led = TokenUsageLedger(d / "token_usage.json")
    sep = 1790300000  # 2026-09
    led.record("openai", "gpt-6-luna", {"input": 15000, "cached": 9000, "output": 300}, now=sep)
    row = led.record("openai", "gpt-6-luna", {"input": 16000, "cached": 14000, "output": 200, "reasoning": 50}, now=sep)
    assert row == {"calls": 2, "input": 31000, "cached": 23000, "cache_write": 0, "output": 500, "reasoning": 50}, row
    led.record("deepseek", "deepseek-flash", {"input": "7", "cached": None, "output": -3, "junk": 9}, now=sep)
    s = TokenUsageLedger(d / "token_usage.json").summary("2026-09")  # survives reload
    assert s["providers"]["deepseek"]["deepseek-flash"] == {"calls": 1, "input": 7, "cached": 0, "cache_write": 0, "output": 0, "reasoning": 0}
    assert s["providers"]["openai"]["gpt-6-luna"]["calls"] == 2
    assert TokenUsageLedger(d / "token_usage.json").summary("2026-08")["providers"] == {}
    (d / "bad.json").write_text("{not json")
    assert TokenUsageLedger(d / "bad.json").summary()["providers"] == {}, "corrupt file = empty, not a crash"
    invalid = led.record("fixture", "invalid-counts", {"input": float("inf"), "output": float("nan")}, now=sep)
    assert invalid["input"] == invalid["output"] == 0
    tracked = TokenUsageLedger(d / "tracked.json")
    tracked.record("openai", "model", {"input": 100, "cached": 40, "output": 10}, now=sep, chat_id="chat-a")
    tracked.record("openai", "model", {"input": 50, "output": 20}, now=sep, chat_id="chat-b")
    tracked.record("other", "model", {"input": 25}, now=sep)
    view = TokenUsageLedger(d / "tracked.json").summary("2026-09")
    assert view["chats"]["chat-a"]["input"] == 100
    assert view["chats"]["chat-b"]["output"] == 20
    assert view["chats"][""]["input"] == 25
    assert sum(row["input"] for row in view["days"].values()) == 175
    assert tracked.summary("2026-08")["chats"] == {}
    legacy = d / "legacy.json"
    legacy.write_text('{"months":{"2026-09":{"openai":{"model":{"calls":1,"input":900}}}}}')
    old = TokenUsageLedger(legacy)
    old.record("openai", "model", {"input": 100}, now=sep, chat_id="new")
    assert old.summary("2026-09")["providers"]["openai"]["model"]["input"] == 1000
    assert old.summary("2026-09")["chats"]["new"]["input"] == 100
    print("smoke_token_usage: ok")


if __name__ == "__main__":
    main()
