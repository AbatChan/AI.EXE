"""Smoke test for persistent daily forward paper testing."""
import tempfile
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.broker import PaperBroker
from app.paper_test import PaperTestRunner


class FakeFeed:
    def __init__(self):
        self.rows = []
        price = 3000
        for index in range(120):
            price += 8
            self.rows.append({"date": f"2026-{(index // 28) + 1:02d}-{(index % 28) + 1:02d}",
                              "close_cents": price})

    def history(self, symbol):
        return {"symbol": symbol, "source": "test", "fetched_at": "2026-08-10T00:00:00Z",
                "rows": list(self.rows)}


def main():
    with tempfile.TemporaryDirectory() as data_dir:
        broker = PaperBroker(data_dir)
        feed = FakeFeed()
        runner = PaperTestRunner(data_dir, broker, feed)
        status = runner.start("BAC")
        assert status["session"]["active"] is True
        assert status["report"]["days"] == 1
        assert status["report"]["forward_return_bps"] == 0
        assert status["report"]["benchmark_return_bps"] == 0
        assert broker.performance()["days"] == 1

        duplicate = runner.run_once()
        assert duplicate["status"] == "already_current"
        assert runner.report()["days"] == 1

        feed.rows.append({"date": "2026-08-11", "close_cents": feed.rows[-1]["close_cents"] + 50})
        result = runner.run_once()
        assert result["status"] == "recorded"
        report = runner.report()
        assert report["days"] == 2
        assert "benchmark_return_bps" in report["latest"]
        assert "max_drawdown_bps" in report
        assert report["signal_counts"]["long"] + report["signal_counts"]["cash"] == 2
        assert report["trading_activity"]["filled_orders"] == 0
        assert report["strategy_costs_cents"] == 0

        reopened = PaperTestRunner(data_dir, broker, feed)
        assert reopened.status()["report"]["days"] == 2

        feed.rows.extend([
            {"date": "2026-08-12", "close_cents": feed.rows[-1]["close_cents"] + 20},
            {"date": "2026-08-13", "close_cents": feed.rows[-1]["close_cents"] - 30},
            {"date": "2026-08-14", "close_cents": feed.rows[-1]["close_cents"] + 40},
        ])
        catch_up = reopened.run_once()
        assert catch_up["status"] == "recorded"
        assert catch_up["recorded_count"] == 3
        report = reopened.report()
        assert report["days"] == 5
        assert [row["market_date"] for row in report["records"][-3:]] == [
            "2026-08-12", "2026-08-13", "2026-08-14"
        ]
        assert reopened.run_once()["status"] == "already_current"
        assert reopened.report()["days"] == 5
        marks = [event["data"] for event in broker.audit_log(limit=100)
                 if event["type"] == "marked"]
        assert [row["date"] for row in marks[-3:]] == [
            "2026-08-12", "2026-08-13", "2026-08-14"
        ]
        assert reopened.stop()["session"]["active"] is False
    print("paper test smoke test: ok")


if __name__ == "__main__":
    main()
