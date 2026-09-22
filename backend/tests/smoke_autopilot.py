"""Smoke test for the 24/7 crypto autopilot.

Covers: rules find entries, the AI can only veto, a broken AI blocks new risk
but never exits, stops fire, daily loss pauses, cooldown, ledger replay and
tamper detection, and no network imports.
"""
import ast
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import autopilot as ap  # noqa: E402


def ok(label):
    print(f"PASS: {label}")


def rising(n=150, start=100.0, step=0.4):
    out, price = [], start
    for i in range(n):
        price += step
        out.append({"t": i * 3_600_000, "open": price - step, "high": price + 0.05, "low": price - step - 0.05,
                    "close": price})
    return out


class Market:
    def __init__(self):
        self.series = {s: rising() for s in ap.WATCHLIST}
        self.now = 1_000_000.0

    def fetch(self, symbol):
        return self.series[symbol]

    def crash(self, symbol, pct):
        last = self.series[symbol][-1]
        price = last["close"] * (1 - pct / 100)
        self.series[symbol] = self.series[symbol] + [
            {"t": last["t"] + 3_600_000, "open": last["close"], "high": last["close"],
             "low": price, "close": price, "partial": True}]


def main():
    source = Path(ap.__file__).read_text()
    imported = {n.names[0].name.split(".")[0] for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Import)}
    imported |= {(n.module or "").split(".")[0] for n in ast.walk(ast.parse(source)) if isinstance(n, ast.ImportFrom)}
    assert not imported & {"urllib", "httpx", "requests", "socket", "websockets", "http"}, imported
    ok("autopilot core has no network imports")

    sig = ap.trend_signal(rising())
    assert sig["ok"] and sig["uptrend"] and sig["breakout"] and sig["entry"]
    assert not ap.trend_signal(rising(50))["ok"]
    ok("rules detect an hourly uptrend breakout")

    with tempfile.TemporaryDirectory() as d:
        m = Market()
        bot = ap.Autopilot(d, m.fetch, reviewer=lambda *a: {"approve": False, "reason": "late chase"},
                           clock=lambda: m.now)
        bot.start(100_000, "careful")
        bot.run_cycle()
        s = bot.status()
        assert not s["positions"] and any(e.get("kind") == "skipped" for e in s["events"])
        skipped = sum(e.get("kind") == "skipped" for e in s["events"])
        bot.run_cycle()
        assert sum(e.get("kind") == "skipped" for e in bot.status()["events"]) == skipped
        ok("AI veto blocks entries and is asked once per bar")

    with tempfile.TemporaryDirectory() as d:
        m = Market()
        calls = []
        bot = ap.Autopilot(d, m.fetch, reviewer=lambda sym, *a: calls.append(sym) or {"approve": True, "reason": "clean"},
                           clock=lambda: m.now)
        bot.start(100_000, "careful")
        bot.run_cycle()
        s = bot.status()
        assert len(s["positions"]) == ap.RISK_PRESETS["careful"]["max_open"], s["positions"]
        assert all(9_000 <= p["value_cents"] <= 10_000 for p in s["positions"])  # 10% of $1,000
        assert s["fees_cents"] > 0 and s["ledger"]["ok"]
        ok("approved entries respect max-open and position size, with fees")

        held = s["positions"][0]["symbol"]
        bot._reviewer = lambda *a: (_ for _ in ()).throw(RuntimeError("provider down"))
        m.crash(held, 5)
        bot.run_cycle()
        s = bot.status()
        assert held not in [p["symbol"] for p in s["positions"]]
        assert s["trades"][0]["reason"] == "stop-loss" and s["trades"][0]["pnl_cents"] < 0
        ok("stop-loss exits without asking the AI, even when the AI is down")

        m.series[held] = rising(151)
        bot._reviewer = lambda *a: {"approve": True, "reason": "again"}
        bot.run_cycle()
        assert held not in [p["symbol"] for p in bot.status()["positions"]]
        m.now += ap.COOLDOWN_SECONDS
        bot._verdicts.clear()
        ok("cooldown blocks an immediate re-buy after an exit")

        replay = ap.AutopilotAccount(d)
        assert replay.cash_cents == bot.account.cash_cents
        assert set(replay.positions) == set(bot.account.positions)
        assert len(replay.trades) == len(bot.account.trades)
        ok("ledger replay rebuilds cash, positions and trades")

        path = Path(d) / "autopilot" / "ledger.jsonl"
        lines = path.read_text().splitlines()
        record = json.loads(lines[3])
        record["data"]["note"] = "edited"
        lines[3] = json.dumps(record, sort_keys=True)
        path.write_text("\n".join(lines) + "\n")
        assert ap.AutopilotAccount(d).verify()["ok"] is False
        ok("editing a past record breaks the hash chain")

    with tempfile.TemporaryDirectory() as d:
        m = Market()
        bot = ap.Autopilot(d, m.fetch, reviewer=lambda *a: {"approve": True, "reason": "ok"}, clock=lambda: m.now)
        bot.start(100_000, "bold")
        bot.run_cycle()
        for symbol in list(bot.account.positions):
            m.crash(symbol, 40)
        bot.run_cycle()
        s = bot.status()
        assert s["paused_today"] and not s["positions"]
        assert any(e.get("kind") == "paused" for e in s["events"])
        ok("daily loss limit pauses new trades")

        trades_before = len(bot.status()["trades"])
        bot.clear_activity()
        assert bot.status()["events"] == [] and len(bot.status()["trades"]) == trades_before
        assert ap.AutopilotAccount(bot.account._dir.rsplit("/autopilot", 1)[0]).verify()["ok"]
        bot.account._append("note", {"kind": "started", "note": "after clear"})
        assert [e["note"] for e in bot.status()["events"]] == ["after clear"]
        ok("clearing activity hides old notes, keeps trades and the hash chain")

        bot.stop()
        assert bot.status()["running"] is False
        try:
            bot.start(5_000, "careful")
            raise AssertionError("tiny budget accepted")
        except ValueError:
            pass
        ok("stop works and budget bounds are enforced")

    print("\n11 checks passed.")


if __name__ == "__main__":
    main()
