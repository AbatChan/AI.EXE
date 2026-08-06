"""Smoke test for the paper-mode broker adapter.

Covers the five properties the adapter is contracted to have: paper-only mode,
a confirmation gate that cannot be bypassed, one adapter seam, a tamper-evident
append-only ledger, and no network.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import broker as broker_mod
from app.broker import (BUY, PAPER, SELL, STATUS_CANCELLED, STATUS_FILLED, STATUS_PENDING,
                        BrokerAdapter, ConfirmationRequired, LiveTradingBlocked, OrderRejected,
                        PaperBroker)


def main():
    with tempfile.TemporaryDirectory() as data_dir:
        book = PaperBroker(data_dir, {"starting_cash_cents": 50000, "slippage_bps": 10,
                                      "commission_cents": 100})

        # --- mode is paper, and nothing can ask for otherwise -----------------
        account = book.account()
        assert account["mode"] == PAPER
        assert account["live_trading_supported"] is False
        assert account["network_enabled"] is False
        assert broker_mod.LIVE_TRADING_SUPPORTED is False

        class LiveBroker(BrokerAdapter):
            mode = "live"
            name = "some-venue"

        try:
            LiveBroker()
            raise AssertionError("a live-mode adapter must not instantiate")
        except LiveTradingBlocked:
            pass

        # --- an order does not fill on submission ----------------------------
        order = book.submit_order("AAPL", BUY, 2, 10000, strategy="test", memo="entry")
        assert order["status"] == STATUS_PENDING
        assert book.account()["cash_cents"] == 50000, "staging an order must not move cash"
        assert book.positions() == [], "staging an order must not open a position"

        # --- the gate: no token, wrong token, then the real one --------------
        for bad in ("", "0" * 32):
            try:
                book.confirm_order(order["id"], bad)
                raise AssertionError("confirmation must reject a bad token")
            except ConfirmationRequired:
                pass
        assert book.account()["cash_cents"] == 50000

        filled = book.confirm_order(order["id"], order["confirmation_token"], confirmed_by="mathew")
        assert filled["status"] == STATUS_FILLED
        assert filled["fill_price_cents"] == 10010, "buys pay slippage"
        assert filled["confirmed_by"] == "mathew"
        # 50000 - (10010 * 2) - 100 commission
        assert book.account()["cash_cents"] == 29880
        assert book.account()["fees_cents"] == 100

        # confirming twice must not double-fill
        try:
            book.confirm_order(order["id"], order["confirmation_token"])
            raise AssertionError("a filled order must not re-confirm")
        except OrderRejected:
            pass

        position = book.positions()[0]
        assert position["symbol"] == "AAPL" and position["quantity"] == 2
        assert position["avg_cost_cents"] == 10010

        # --- realized P&L on the way out, net of costs -----------------------
        exit_order = book.submit_order("AAPL", SELL, 2, 11000)
        book.confirm_order(exit_order["id"], exit_order["confirmation_token"])
        # sells receive less: 11000 - 11 = 10989
        assert book.positions() == []
        assert book.account()["realized_pnl_cents"] == (10989 - 10010) * 2
        assert book.account()["fees_cents"] == 200

        # --- guards ----------------------------------------------------------
        try:
            book.submit_order("AAPL", SELL, 5, 10000)
            raise AssertionError("shorting is disabled by default")
        except OrderRejected:
            pass
        # Affordability binds at confirm, not submit: a staged sell may free the
        # cash before the operator confirms the buy.
        broke = book.submit_order("AAPL", BUY, 99, 1000000)
        assert broke["status"] == STATUS_PENDING
        try:
            book.confirm_order(broke["id"], broke["confirmation_token"])
            raise AssertionError("an unaffordable order must not fill")
        except OrderRejected:
            pass
        book.cancel_order(broke["id"], "unaffordable")
        for bad_side, bad_qty, bad_price in (("hold", 1, 100), (BUY, 0, 100), (BUY, 1, 0)):
            try:
                book.submit_order("AAPL", bad_side, bad_qty, bad_price)
                raise AssertionError("malformed orders must be rejected")
            except OrderRejected:
                pass

        # --- cancellation ----------------------------------------------------
        doomed = book.submit_order("MSFT", BUY, 1, 5000)
        cancelled = book.cancel_order(doomed["id"], "changed my mind")
        assert cancelled["status"] == STATUS_CANCELLED
        try:
            book.confirm_order(doomed["id"], doomed["confirmation_token"])
            raise AssertionError("a cancelled order must never fill")
        except OrderRejected:
            pass

        # --- marks and measured daily return ---------------------------------
        book.mark_to_market({})
        perf = book.performance()
        assert perf["days"] >= 1
        assert perf["fees_cents"] == 200
        # started at 50000, made 979*2 on the round trip, paid 200 in commission
        assert perf["latest_equity_cents"] == 50000 + (10989 - 10010) * 2 - 200

        # --- ledger is intact, and replay reproduces the state ---------------
        assert book.verify_ledger()["ok"] is True
        ledger_path = Path(data_dir) / "broker" / "ledger.jsonl"
        assert ledger_path.exists()

        reopened = PaperBroker(data_dir)
        assert reopened.account()["cash_cents"] == book.account()["cash_cents"]
        assert reopened.account()["realized_pnl_cents"] == book.account()["realized_pnl_cents"]
        assert reopened.account()["fees_cents"] == book.account()["fees_cents"]
        assert len(reopened.orders()) == len(book.orders())
        assert reopened.verify_ledger()["ok"] is True

    # --- tampering is detectable, not merely discouraged ---------------------
    with tempfile.TemporaryDirectory() as data_dir:
        book = PaperBroker(data_dir, {"starting_cash_cents": 100000})
        staged = book.submit_order("BTC", BUY, 1, 60000)
        book.confirm_order(staged["id"], staged["confirmation_token"])
        path = Path(data_dir) / "broker" / "ledger.jsonl"
        assert book.verify_ledger()["ok"] is True

        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        for index, row in enumerate(rows):
            if row["type"] == "order_filled":
                row["data"]["fill_price_cents"] = 1     # rewrite history: cheaper fill
                rows[index] = row
                break
        path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

        verdict = PaperBroker(data_dir).verify_ledger()
        assert verdict["ok"] is False, "an edited fill must break the hash chain"
        assert verdict["broken_at"] is not None

    print("broker smoke test: ok")


if __name__ == "__main__":
    main()
