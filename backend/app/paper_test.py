"""Persistent daily forward-testing for the paper broker."""
import json
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .strategy import analyze_history


DAILY_RUN_HOUR_UTC = 22


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value=None) -> str:
    return (value or _now()).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _protect(path: str, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


class PaperTestRunner:
    """Runs once per market day; it records signals but never fills orders."""

    def __init__(self, data_dir: str, broker, quote_feed):
        self._dir = os.path.join(data_dir, "paper_test")
        os.makedirs(self._dir, exist_ok=True)
        _protect(self._dir, 0o700)
        self._state_path = os.path.join(self._dir, "session.json")
        self._records_path = os.path.join(self._dir, "daily.jsonl")
        self._broker = broker
        self._quotes = quote_feed
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._state = self._load_state()

    def _load_state(self) -> dict:
        if not os.path.exists(self._state_path):
            return {"active": False}
        try:
            with open(self._state_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError, TypeError):
            return {"active": False, "last_error": "session state could not be read"}

    def _save_state(self) -> None:
        temp = self._state_path + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(self._state, handle, indent=2, sort_keys=True)
        os.replace(temp, self._state_path)
        _protect(self._state_path, 0o600)

    def _append_record(self, record: dict) -> None:
        with open(self._records_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
        _protect(self._records_path, 0o600)

    def _records(self) -> list:
        if not os.path.exists(self._records_path):
            return []
        session_id = self._state.get("id")
        with open(self._records_path, "r", encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle if line.strip()]
        return [row for row in rows if row.get("session_id") == session_id]

    def start(self, symbol: str) -> dict:
        symbol = (symbol or "").strip().upper()
        if not symbol:
            raise ValueError("symbol is required")
        with self._lock:
            if self._state.get("active") and self._state.get("symbol") == symbol:
                return self.status()
            history = self._quotes.history(symbol)
            report = analyze_history(history["rows"])
            close = int(history["rows"][-1]["close_cents"])
            equity = int(self._broker.current_equity_cents())
            self._state = {
                "id": uuid.uuid4().hex,
                "active": True,
                "symbol": symbol,
                "started_at": _iso(),
                "starting_equity_cents": equity,
                "benchmark_close_cents": close,
                "benchmark_quantity": 0,
                "benchmark_cash_cents": equity,
                "last_market_date": "",
                "last_run_at": "",
                "last_error": "",
                "selected_strategy": report["selected"]["name"],
            }
            self._save_state()
            self.run_once(force=True, prepared=(history, report))
            return self.status()

    def stop(self) -> dict:
        with self._lock:
            self._state["active"] = False
            self._state["stopped_at"] = _iso()
            self._save_state()
            return self.status()

    def run_once(self, force: bool = False, prepared=None) -> dict:
        with self._lock:
            if not self._state.get("active"):
                raise RuntimeError("no daily paper test is active")
            history, report = prepared or (
                self._quotes.history(self._state["symbol"]), None
            )
            rows = sorted(history.get("rows") or [], key=lambda row: row["date"])
            if not rows:
                raise ValueError("price history is empty")

            records = self._records()
            recorded_dates = {row["market_date"] for row in records}
            last_market_date = max(
                [self._state.get("last_market_date", ""), *recorded_dates]
            )
            if force:
                pending = [len(rows) - 1]
            elif last_market_date:
                pending = [index for index, row in enumerate(rows)
                           if row["date"] > last_market_date
                           and row["date"] not in recorded_dates]
            else:
                pending = [len(rows) - 1]

            if not pending:
                return {"status": "already_current", "market_date": rows[-1]["date"]}

            added = []
            for index in pending:
                day_report = report if report and index == len(rows) - 1 else (
                    analyze_history(rows[:index + 1])
                )
                added.append(self._record_day(rows[index], day_report))
                recorded_dates.add(rows[index]["date"])
            return {
                "status": "recorded",
                "record": added[-1],
                "records": added,
                "recorded_count": len(added),
            }

    def _record_day(self, row: dict, report: dict) -> dict:
        symbol = self._state["symbol"]
        close = int(row["close_cents"])
        snapshot = self._broker.mark_to_market({symbol: close}, snapshot_date=row["date"])
        held = next((int(position["quantity"])
                     for position in self._broker.positions()
                     if position["symbol"] == symbol), 0)
        target = report["recommendation"]
        action = "buy" if target == "long" and held == 0 else (
            "sell" if target == "cash" and held > 0 else "hold"
        )
        start = int(self._state["starting_equity_cents"])
        equity = int(snapshot["equity_cents"])
        if not self._records():
            benchmark_quantity = held if held > 0 else min(
                equity // 4, int(self._broker.account()["cash_cents"])
            ) // close
            self._state.update({
                "starting_equity_cents": equity,
                "benchmark_close_cents": close,
                "benchmark_quantity": benchmark_quantity,
                "benchmark_cash_cents": equity - benchmark_quantity * close,
            })
            start = equity
        benchmark = (int(self._state["benchmark_cash_cents"])
                     + int(self._state["benchmark_quantity"]) * close)
        selected = report["selected"]
        activity = self._broker.trading_activity_since(self._state.get("started_at", ""))
        record = {
            "session_id": self._state["id"],
            "run_at": _iso(),
            "market_date": row["date"],
            "symbol": symbol,
            "close_cents": close,
            "equity_cents": equity,
            "forward_return_bps": int(round((equity - start) * 10000 / start)) if start else 0,
            "benchmark_equity_cents": benchmark,
            "benchmark_return_bps": int(round((benchmark - start) * 10000 / start)) if start else 0,
            "strategy": selected["name"],
            "holdout_return_bps": selected["test"]["total_return_bps"],
            "holdout_drawdown_bps": selected["test"]["max_drawdown_bps"],
            "signal": target,
            "action": action,
            "held_quantity": held,
            "strategy_costs_cents": activity["total_costs_cents"],
            "simulated_fills": activity["filled_orders"],
            "benchmark_costs_cents": 0,
        }
        self._append_record(record)
        self._state.update({
            "last_market_date": row["date"],
            "last_run_at": record["run_at"],
            "last_error": "",
            "selected_strategy": selected["name"],
            "latest_signal": target,
            "pending_action": action,
        })
        self._save_state()
        return record

    def report(self) -> dict:
        with self._lock:
            records = self._records()
            start = int(self._state.get("starting_equity_cents") or 0)
            peak = start
            max_drawdown = 0
            for row in records:
                equity = int(row["equity_cents"])
                peak = max(peak, equity)
                if peak:
                    max_drawdown = max(max_drawdown, int(round((peak - equity) * 10000 / peak)))
            latest = records[-1] if records else None
            forward = int(latest["forward_return_bps"]) if latest else 0
            benchmark = int(latest["benchmark_return_bps"]) if latest else 0
            signals = {"long": 0, "cash": 0}
            actions = {"buy": 0, "sell": 0, "hold": 0}
            for row in records:
                signal = row.get("signal")
                action = row.get("action")
                if signal in signals:
                    signals[signal] += 1
                if action in actions:
                    actions[action] += 1
            activity = self._broker.trading_activity_since(self._state.get("started_at", ""))
            return {
                "title": f"{self._state.get('symbol', '')} forward paper-test case study",
                "active": bool(self._state.get("active")),
                "started_at": self._state.get("started_at", ""),
                "days": len(records),
                "forward_return_bps": forward,
                "benchmark_return_bps": benchmark,
                "alpha_bps": forward - benchmark,
                "max_drawdown_bps": max_drawdown,
                "signal_counts": signals,
                "action_counts": actions,
                "trading_activity": activity,
                "strategy_costs_cents": activity["total_costs_cents"],
                "benchmark_costs_cents": 0,
                "benchmark_assumption": "Buy and hold the session's starting exposure; no new entry cost.",
                "latest": latest,
                "records": records,
                "disclaimer": "Paper simulation only. Results do not predict live returns.",
            }

    def status(self) -> dict:
        with self._lock:
            report = self.report()
            return {"session": dict(self._state), "report": report,
                    "next_run_at": self._next_run().isoformat().replace("+00:00", "Z")}

    def _next_run(self) -> datetime:
        now = _now()
        candidate = now.replace(hour=DAILY_RUN_HOUR_UTC, minute=0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        while candidate.weekday() >= 5:
            candidate += timedelta(days=1)
        return candidate

    def _scheduler_loop(self) -> None:
        if self._stop.wait(3):
            return
        if self._state.get("active"):
            self._run_safely()
        while not self._stop.is_set():
            wait = max(1, int((self._next_run() - _now()).total_seconds()))
            if self._stop.wait(wait):
                return
            self._run_safely()

    def _run_safely(self) -> None:
        try:
            self.run_once()
        except Exception as exc:
            with self._lock:
                self._state["last_error"] = str(exc)[:300]
                self._state["last_attempt_at"] = _iso()
                self._save_state()

    def start_scheduler(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._scheduler_loop, daemon=True,
                                            name="paper-test-runner")
            self._thread.start()

    def stop_scheduler(self) -> None:
        self._stop.set()
