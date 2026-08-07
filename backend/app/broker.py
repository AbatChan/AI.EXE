"""Paper-mode broker adapter for AI.EXE.

Simulation only.  There is no network client in this module and no live venue
behind it: orders fill against prices the CALLER supplies, and nothing leaves
the machine.  Every state change is appended to a hash-chained JSONL ledger,
so the record is tamper-evident rather than merely append-only by convention.

Two deliberate constraints:
  * Money is integer cents and quantities are integer units. Floats are never
    used for balances — a rounding drift in a ledger is not recoverable.
  * Fills model slippage and commission. A paper engine that fills at the
    quoted mid flatters every strategy, which defeats the point of testing one.
"""
import hashlib
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

PAPER = "paper"

# Not a feature flag. Live routing needs a broker credential path, an order
# gateway and a separate signed agreement; none exist here.
LIVE_TRADING_SUPPORTED = False
NETWORK_ENABLED = False

CONFIRMATION_TTL_SECONDS = 900

STATUS_PENDING = "pending_confirmation"
STATUS_FILLED = "filled"
STATUS_CANCELLED = "cancelled"
STATUS_EXPIRED = "expired"

BUY = "buy"
SELL = "sell"

DEFAULT_SETTINGS = {
    "starting_cash_cents": 50000,   # $500 — the seed in the client's own model
    "slippage_bps": 5,
    "commission_cents": 0,
    "allow_short": False,
}


class LiveTradingBlocked(RuntimeError):
    """Raised whenever anything asks this adapter to touch a real venue."""


class ConfirmationRequired(RuntimeError):
    """Raised when a fill is attempted without a valid confirmation token."""


class OrderRejected(ValueError):
    """Raised when an order is malformed or unaffordable."""


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _canonical(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


class BrokerAdapter:
    """The single adapter seam. Subclasses declare a mode; only paper runs.

    Everything upstream talks to this interface, so a future live adapter is a
    new subclass rather than a rewrite — but it cannot be instantiated until
    LIVE_TRADING_SUPPORTED flips, which is a contractual decision, not a code
    one.
    """

    mode = PAPER
    name = "abstract"

    def __init__(self) -> None:
        if self.mode != PAPER and not LIVE_TRADING_SUPPORTED:
            raise LiveTradingBlocked(
                f"adapter '{self.name}' requests mode '{self.mode}'; only paper mode is supported"
            )

    def submit_order(self, **kwargs) -> dict:
        raise NotImplementedError

    def confirm_order(self, order_id: str, token: str, confirmed_by: str) -> dict:
        raise NotImplementedError

    def account(self) -> dict:
        raise NotImplementedError


class PaperBroker(BrokerAdapter):
    """Local simulated broker backed by an append-only JSONL ledger."""

    mode = PAPER
    name = "paper"

    def __init__(self, data_dir: str, settings: Optional[dict] = None):
        super().__init__()
        broker_dir = os.path.join(data_dir, "broker")
        os.makedirs(broker_dir, exist_ok=True)
        self._path = os.path.join(broker_dir, "ledger.jsonl")
        self._lock = threading.RLock()
        self.settings = dict(DEFAULT_SETTINGS)
        if settings:
            self.settings.update({k: v for k, v in settings.items() if k in DEFAULT_SETTINGS})

        self._seq = 0
        self._prev_hash = "0" * 64
        self._orders: Dict[str, dict] = {}
        self._positions: Dict[str, dict] = {}
        self._cash_cents = int(self.settings["starting_cash_cents"])
        self._fees_cents = 0
        self._realized_pnl_cents = 0
        self._marks: List[dict] = []
        self._last_prices: Dict[str, int] = {}
        self._replay()

    # ---------- ledger ----------

    def _replay(self) -> None:
        """Rebuild state from the ledger. The log is the source of truth."""
        if not os.path.exists(self._path):
            self._append("session_opened", {
                "starting_cash_cents": self._cash_cents,
                "settings": dict(self.settings),
            })
            return
        with open(self._path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                self._seq = int(record["seq"])
                self._prev_hash = record["hash"]
                self._apply(record["type"], record["data"])

    def _append(self, event_type: str, data: dict) -> dict:
        with self._lock:
            self._seq += 1
            record = {
                "seq": self._seq,
                "ts": _now(),
                "type": event_type,
                "data": data,
                "prev": self._prev_hash,
            }
            record["hash"] = hashlib.sha256(
                (record["prev"] + _canonical({k: record[k] for k in ("seq", "ts", "type", "data")}))
                .encode("utf-8")
            ).hexdigest()
            with open(self._path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
            self._prev_hash = record["hash"]
            self._apply(event_type, data)
            return record

    def _apply(self, event_type: str, data: dict) -> None:
        """Fold one event into memory. Must stay pure — replay depends on it."""
        if event_type == "session_opened":
            self._cash_cents = int(data["starting_cash_cents"])
            self.settings.update(data.get("settings") or {})
        elif event_type == "settings_changed":
            self.settings.update(data.get("settings") or {})
        elif event_type == "order_submitted":
            self._orders[data["id"]] = dict(data)
        elif event_type == "order_filled":
            order = self._orders.get(data["id"])
            if order is not None:
                order.update(data)
                order["status"] = STATUS_FILLED
            self._apply_fill(data)
        elif event_type in ("order_cancelled", "order_expired"):
            order = self._orders.get(data["id"])
            if order is not None:
                order["status"] = data["status"]
                order["resolution_reason"] = data.get("reason", "")
        elif event_type == "marked":
            self._marks.append(dict(data))
            self._last_prices.update({k: int(v) for k, v in (data.get("prices") or {}).items()})

    def _apply_fill(self, fill: dict) -> None:
        symbol = fill["symbol"]
        signed = int(fill["quantity"]) if fill["side"] == BUY else -int(fill["quantity"])
        price = int(fill["fill_price_cents"])
        commission = int(fill.get("commission_cents", 0))

        position = self._positions.setdefault(
            symbol, {"symbol": symbol, "quantity": 0, "avg_cost_cents": 0, "realized_pnl_cents": 0}
        )
        held = int(position["quantity"])
        avg = int(position["avg_cost_cents"])

        if held == 0 or (held > 0) == (signed > 0):
            # Opening or adding — weighted average cost.
            total = held + signed
            if total != 0:
                position["avg_cost_cents"] = int(
                    round((avg * abs(held) + price * abs(signed)) / abs(total))
                )
            position["quantity"] = total
        else:
            closing = min(abs(signed), abs(held))
            direction = 1 if held > 0 else -1
            realized = (price - avg) * closing * direction
            position["realized_pnl_cents"] = int(position["realized_pnl_cents"]) + realized
            self._realized_pnl_cents += realized
            remaining = abs(signed) - closing
            position["quantity"] = held + signed
            if remaining > 0:
                # Crossed through zero — the residue opens a fresh position.
                position["avg_cost_cents"] = price
            elif position["quantity"] == 0:
                position["avg_cost_cents"] = 0

        notional = price * int(fill["quantity"])
        self._cash_cents += -notional if fill["side"] == BUY else notional
        self._cash_cents -= commission
        self._fees_cents += commission

    def verify_ledger(self) -> dict:
        """Recompute the hash chain. Any edit or deletion breaks it."""
        if not os.path.exists(self._path):
            return {"ok": True, "records": 0, "broken_at": None}
        prev = "0" * 64
        count = 0
        with open(self._path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                expected = hashlib.sha256(
                    (prev + _canonical({k: record[k] for k in ("seq", "ts", "type", "data")}))
                    .encode("utf-8")
                ).hexdigest()
                if record.get("prev") != prev or record.get("hash") != expected:
                    return {"ok": False, "records": count, "broken_at": record.get("seq")}
                prev = record["hash"]
                count += 1
        return {"ok": True, "records": count, "broken_at": None}

    def audit_log(self, limit: int = 200) -> List[dict]:
        if not os.path.exists(self._path):
            return []
        with open(self._path, "r", encoding="utf-8") as handle:
            records = [json.loads(line) for line in handle if line.strip()]
        return records[-limit:]

    # ---------- orders ----------

    def _expire_stale(self) -> None:
        now = datetime.now(timezone.utc)
        for order in list(self._orders.values()):
            if order.get("status") != STATUS_PENDING:
                continue
            created = datetime.fromisoformat(order["created_at"].replace("Z", "+00:00"))
            if (now - created).total_seconds() > CONFIRMATION_TTL_SECONDS:
                self._append("order_expired", {
                    "id": order["id"],
                    "status": STATUS_EXPIRED,
                    "reason": f"unconfirmed for {CONFIRMATION_TTL_SECONDS}s",
                })

    def submit_order(self, symbol: str, side: str, quantity: int, price_cents: int,
                     strategy: str = "manual", memo: str = "") -> dict:
        """Stage an order. It does NOT fill — confirm_order does that."""
        if self.mode != PAPER or LIVE_TRADING_SUPPORTED:
            raise LiveTradingBlocked("paper mode is the only supported operating mode")
        side = (side or "").strip().lower()
        symbol = (symbol or "").strip().upper()
        if side not in (BUY, SELL):
            raise OrderRejected("side must be 'buy' or 'sell'")
        if not symbol:
            raise OrderRejected("symbol is required")
        if int(quantity) <= 0:
            raise OrderRejected("quantity must be a positive whole number of units")
        if int(price_cents) <= 0:
            raise OrderRejected("price_cents must be positive — paper fills need a caller-supplied quote")

        with self._lock:
            self._expire_stale()
            if side == SELL and not self.settings.get("allow_short"):
                held = int(self._positions.get(symbol, {}).get("quantity", 0))
                if int(quantity) > held:
                    raise OrderRejected(
                        f"selling {quantity} {symbol} exceeds the {held} held and shorting is disabled"
                    )
            order = {
                "id": uuid.uuid4().hex,
                "confirmation_token": uuid.uuid4().hex,
                "created_at": _now(),
                "status": STATUS_PENDING,
                "mode": PAPER,
                "symbol": symbol,
                "side": side,
                "quantity": int(quantity),
                "price_cents": int(price_cents),
                "strategy": strategy[:80],
                "memo": memo[:500],
            }
            self._append("order_submitted", order)
            return dict(self._orders[order["id"]])

    def confirm_order(self, order_id: str, token: str, confirmed_by: str = "operator") -> dict:
        """The gate. Without a matching token nothing ever fills."""
        with self._lock:
            self._expire_stale()
            order = self._orders.get(order_id)
            if order is None:
                raise OrderRejected(f"unknown order {order_id}")
            if order["status"] != STATUS_PENDING:
                raise OrderRejected(f"order {order_id} is {order['status']}, not awaiting confirmation")
            if not token or token != order.get("confirmation_token"):
                raise ConfirmationRequired("confirmation token does not match — order not filled")

            slippage = int(self.settings.get("slippage_bps", 0))
            price = int(order["price_cents"])
            drift = int(round(price * slippage / 10000))
            fill_price = price + drift if order["side"] == BUY else price - drift
            fill_price = max(1, fill_price)
            commission = int(self.settings.get("commission_cents", 0))

            if order["side"] == BUY:
                cost = fill_price * int(order["quantity"]) + commission
                if cost > self._cash_cents:
                    raise OrderRejected(
                        f"insufficient paper cash: need {cost} cents, have {self._cash_cents}"
                    )

            fill = {
                "id": order_id,
                "symbol": order["symbol"],
                "side": order["side"],
                "quantity": int(order["quantity"]),
                "quote_price_cents": price,
                "fill_price_cents": fill_price,
                "slippage_cents": abs(fill_price - price) * int(order["quantity"]),
                "commission_cents": commission,
                "confirmed_by": confirmed_by[:80],
                "confirmed_at": _now(),
                "status": STATUS_FILLED,
            }
            self._append("order_filled", fill)
            return dict(self._orders[order_id])

    def cancel_order(self, order_id: str, reason: str = "cancelled by operator") -> dict:
        with self._lock:
            order = self._orders.get(order_id)
            if order is None:
                raise OrderRejected(f"unknown order {order_id}")
            if order["status"] != STATUS_PENDING:
                raise OrderRejected(f"order {order_id} is {order['status']} and cannot be cancelled")
            self._append("order_cancelled", {
                "id": order_id, "status": STATUS_CANCELLED, "reason": reason[:200],
            })
            return dict(self._orders[order_id])

    def orders(self, status: Optional[str] = None, limit: int = 100) -> List[dict]:
        self._expire_stale()
        rows = sorted(self._orders.values(), key=lambda o: o["created_at"], reverse=True)
        if status:
            rows = [o for o in rows if o["status"] == status]
        return [dict(o) for o in rows[:limit]]

    def positions(self) -> List[dict]:
        return [dict(p) for p in self._positions.values() if int(p["quantity"]) != 0]

    # ---------- reporting ----------

    def mark_to_market(self, marks: Dict[str, int]) -> dict:
        """Snapshot equity against caller-supplied prices. No quotes are fetched."""
        with self._lock:
            used = {}
            holdings = 0
            for position in self._positions.values():
                qty = int(position["quantity"])
                if qty == 0:
                    continue
                symbol = position["symbol"]
                price = int(marks.get(symbol, self._last_prices.get(symbol, position["avg_cost_cents"])))
                used[symbol] = price
                holdings += qty * price
            equity = self._cash_cents + holdings
            snapshot = {
                "date": _now()[:10],
                "cash_cents": self._cash_cents,
                "holdings_cents": holdings,
                "equity_cents": equity,
                "prices": used,
            }
            self._append("marked", snapshot)
            return dict(snapshot)

    def current_equity_cents(self) -> int:
        """Cash plus holdings at the last known price, else cost. Always live —
        a stale snapshot would read a fresh buy as losing what it just spent."""
        holdings = 0
        for position in self._positions.values():
            qty = int(position["quantity"])
            if qty == 0:
                continue
            price = int(self._last_prices.get(position["symbol"], position["avg_cost_cents"]))
            holdings += qty * price
        return self._cash_cents + holdings

    def account(self) -> dict:
        return {
            "mode": PAPER,
            "live_trading_supported": LIVE_TRADING_SUPPORTED,
            "network_enabled": NETWORK_ENABLED,
            "starting_cash_cents": int(self.settings["starting_cash_cents"]),
            "cash_cents": self._cash_cents,
            "realized_pnl_cents": self._realized_pnl_cents,
            "fees_cents": self._fees_cents,
            "open_positions": len(self.positions()),
            "pending_orders": len([o for o in self._orders.values() if o["status"] == STATUS_PENDING]),
            "settings": dict(self.settings),
        }

    def performance(self) -> dict:
        """Daily returns from the mark series — the number that settles whether
        an assumed daily rate survives costs."""
        by_date: Dict[str, int] = {}
        for mark in self._marks:
            by_date[mark["date"]] = int(mark["equity_cents"])   # last mark of each day wins
        dates = sorted(by_date)
        series = []
        previous = None
        for date in dates:
            equity = by_date[date]
            change_bps = None if previous in (None, 0) else int(round((equity - previous) * 10000 / previous))
            series.append({"date": date, "equity_cents": equity, "change_bps": change_bps})
            previous = equity
        moves = [row["change_bps"] for row in series if row["change_bps"] is not None]
        start = int(self.settings["starting_cash_cents"])
        latest = self.current_equity_cents()
        return {
            "days": len(series),
            "starting_equity_cents": start,
            "latest_equity_cents": latest,
            "total_return_bps": int(round((latest - start) * 10000 / start)) if start else 0,
            "mean_daily_bps": int(round(sum(moves) / len(moves))) if moves else 0,
            "best_daily_bps": max(moves) if moves else 0,
            "worst_daily_bps": min(moves) if moves else 0,
            "fees_cents": self._fees_cents,
            "series": series,
        }
