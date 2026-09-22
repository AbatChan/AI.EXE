"""24/7 crypto autopilot on its own paper account.

Network-free: candles and the AI reviewer are injected. Rules find trends and
enforce risk; the AI may veto an entry, never size it or skip an exit.
"""
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone

WATCHLIST = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX"]
FEE_BPS = 10        # exchange taker fee per side
SLIPPAGE_BPS = 5    # per side
QTY_SCALE = 10 ** 8  # fractional coins, stored as integers
MIN_BARS = 120
CYCLE_SECONDS = 60
COOLDOWN_SECONDS = 6 * 3600  # no re-buy right after an exit

# The only user-facing knob besides budget.
RISK_PRESETS = {
    "careful":  {"label": "Careful",  "position_pct": 10, "max_open": 3, "stop_pct": 2.0, "trail_atr": 2.0,
                 "daily_loss_pct": 3.0},
    "balanced": {"label": "Balanced", "position_pct": 20, "max_open": 4, "stop_pct": 3.0, "trail_atr": 2.5,
                 "daily_loss_pct": 5.0},
    "bold":     {"label": "Bold",     "position_pct": 30, "max_open": 5, "stop_pct": 5.0, "trail_atr": 3.0,
                 "daily_loss_pct": 8.0},
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _day(iso: str) -> str:
    return (iso or "")[:10]


def _protect(path: str, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


# ---------- signals (pure) ----------

def ema(values, period):
    if not values:
        return []
    k = 2 / (period + 1)
    out = [float(values[0])]
    for value in values[1:]:
        out.append(value * k + out[-1] * (1 - k))
    return out


def atr(candles, period=14):
    if len(candles) < 2:
        return 0.0
    ranges = []
    for prev, cur in zip(candles, candles[1:]):
        ranges.append(max(cur["high"] - cur["low"], abs(cur["high"] - prev["close"]),
                          abs(cur["low"] - prev["close"])))
    recent = ranges[-period:]
    return sum(recent) / len(recent)


def trend_signal(candles) -> dict:
    """Score one market from closed hourly candles. Higher = stronger uptrend."""
    if len(candles) < MIN_BARS:
        return {"ok": False, "reason": "not enough history"}
    closes = [c["close"] for c in candles]
    fast, slow, base = ema(closes, 20), ema(closes, 50), ema(closes, 100)
    price = closes[-1]
    change_6h = price / closes[-7] - 1
    change_1h = price / closes[-2] - 1
    vol = atr(candles) / price if price else 0.0
    breakout = price >= max(c["high"] for c in candles[-25:-1])  # 24h high
    uptrend = fast[-1] > slow[-1] > base[-1] and price > fast[-1]
    score = (change_6h / vol) if vol else 0.0
    return {
        "ok": True, "price": price, "uptrend": uptrend, "breakout": breakout,
        "trend_broken": price < slow[-1], "atr": atr(candles), "volatility": vol,
        "change_1h": change_1h, "change_6h": change_6h, "score": round(score, 2),
        "entry": bool(uptrend and breakout and change_6h > 0 and change_1h > 0),
    }


def exit_reason(position: dict, price: float, signal: dict, preset: dict):
    """Deterministic exits. The AI is never asked."""
    entry = position["entry_price"]
    if price <= entry * (1 - preset["stop_pct"] / 100):
        return "stop-loss"
    trail = position["peak_price"] - preset["trail_atr"] * position["atr"]
    if price <= trail and position["peak_price"] > entry:
        return "trailing stop"
    if signal.get("ok") and signal["trend_broken"]:
        return "trend ended"
    return None


# ---------- account (hash-chained ledger) ----------

class AutopilotAccount:
    """Fractional paper account. The ledger is the source of truth."""

    def __init__(self, data_dir: str):
        self._dir = os.path.join(data_dir, "autopilot")
        os.makedirs(self._dir, exist_ok=True)
        _protect(self._dir, 0o700)
        self._path = os.path.join(self._dir, "ledger.jsonl")
        self._lock = threading.RLock()
        self._reset_state()
        self._replay()

    def _reset_state(self):
        self.seq = 0
        self.prev_hash = "0" * 64
        self.config = {"running": False, "risk": "careful", "budget_cents": 0}
        self.cash_cents = 0
        self.started_at = ""
        self.positions = {}
        self.trades = []
        self.events = []
        self.benchmark = {}
        self.marks = {}
        self.day_start = {}
        self.fees_cents = 0

    def _replay(self):
        if not os.path.exists(self._path):
            return
        with open(self._path, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    record = json.loads(line)
                    self.seq, self.prev_hash = record["seq"], record["hash"]
                    self._apply(record["type"], record["data"], record["at"])

    def _append(self, event_type: str, data: dict) -> dict:
        with self._lock:
            at = _now()
            body = {"seq": self.seq + 1, "at": at, "type": event_type, "data": data, "prev": self.prev_hash}
            digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()
            record = dict(body, hash=digest)
            with open(self._path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, sort_keys=True) + "\n")
            _protect(self._path, 0o600)
            self.seq, self.prev_hash = record["seq"], digest
            self._apply(event_type, data, at)
            return record

    def _apply(self, event_type, data, at):
        if event_type == "funded":
            self._reset_state_keep_chain()
            self.cash_cents = data["budget_cents"]
            self.config.update(budget_cents=data["budget_cents"], risk=data["risk"])
            self.started_at = at
            self.benchmark = dict(data.get("benchmark") or {})
        elif event_type == "config":
            self.config.update(data)
        elif event_type == "fill":
            self._apply_fill(data, at)
        elif event_type == "note":
            self.events.append({"at": at, "seq": self.seq, **data})
            self.events = self.events[-200:]

    def _reset_state_keep_chain(self):
        seq, prev = self.seq, self.prev_hash
        self._reset_state()
        self.seq, self.prev_hash = seq, prev

    def _apply_fill(self, fill, at):
        symbol, qty, price = fill["symbol"], fill["qty"], fill["price"]
        gross = round(qty * price * 100 / QTY_SCALE)
        fee = fill["fee_cents"]
        self.fees_cents += fee
        if fill["side"] == "buy":
            self.cash_cents -= gross + fee
            self.positions[symbol] = {"qty": qty, "entry_price": price, "peak_price": price,
                                      "atr": fill.get("atr", 0.0), "opened_at": at,
                                      "cost_cents": gross + fee, "reason": fill.get("reason", "")}
        else:
            pos = self.positions.pop(symbol, None)
            self.cash_cents += gross - fee
            pnl = gross - fee - (pos["cost_cents"] if pos else 0)
            self.trades.append({"symbol": symbol, "opened_at": pos["opened_at"] if pos else "",
                                "closed_at": at, "entry": pos["entry_price"] if pos else 0,
                                "exit": price, "pnl_cents": pnl, "reason": fill.get("reason", "")})
        self.marks[symbol] = price
        self.events.append({"at": at, "seq": self.seq, "kind": fill["side"], "symbol": symbol, "price": price,
                            "reason": fill.get("reason", ""), "note": fill.get("note", "")})
        self.events = self.events[-200:]

    # ----- queries -----

    def equity_cents(self) -> int:
        held = sum(round(p["qty"] * self.marks.get(s, p["entry_price"]) * 100 / QTY_SCALE)
                   for s, p in self.positions.items())
        return self.cash_cents + held

    def benchmark_cents(self) -> int:
        """Buy BTC with the whole budget at start and hold."""
        start = self.benchmark.get("BTC")
        now = self.marks.get("BTC")
        if not start or not now or not self.config["budget_cents"]:
            return self.config["budget_cents"]
        return round(self.config["budget_cents"] * now / start)

    def verify(self) -> dict:
        prev, count = "0" * 64, 0
        if os.path.exists(self._path):
            with open(self._path, "r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    record = json.loads(line)
                    body = {k: record[k] for k in ("seq", "at", "type", "data", "prev")}
                    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()
                    if record["prev"] != prev or digest != record["hash"]:
                        return {"ok": False, "broken_at": record.get("seq"), "records": count}
                    prev, count = digest, count + 1
        return {"ok": True, "records": count}


# ---------- runner ----------

class Autopilot:
    """Scans the watchlist every minute, around the clock, while switched on."""

    def __init__(self, data_dir: str, fetch_candles, reviewer=None, clock=time.time):
        self.account = AutopilotAccount(data_dir)
        self._fetch = fetch_candles          # symbol -> list of candle dicts
        self._reviewer = reviewer            # (symbol, signal, context) -> {"approve": bool, "reason": str}
        self._clock = clock
        self._stop = threading.Event()
        self._thread = None
        self._cycle_lock = threading.Lock()
        self.last_cycle_at = ""
        self.last_error = ""
        self.signals = {}
        self._exited_at = {}
        self._verdicts = {}  # one AI review per symbol per closed bar

    # ----- control -----

    def start(self, budget_cents: int, risk: str) -> dict:
        if risk not in RISK_PRESETS:
            raise ValueError("Choose Careful, Balanced or Bold.")
        if not 10_000 <= int(budget_cents) <= 100_000_000:
            raise ValueError("Budget must be between $100 and $1,000,000.")
        acct = self.account
        fresh = not acct.started_at or not acct.config.get("budget_cents")
        if fresh or int(budget_cents) != acct.config["budget_cents"]:
            if acct.positions:
                raise ValueError("Close open positions before changing the budget.")
            btc = self._latest_price("BTC")
            acct._append("funded", {"budget_cents": int(budget_cents), "risk": risk,
                                    "benchmark": {"BTC": btc} if btc else {}})
        acct._append("config", {"running": True, "risk": risk, "paused_reason": ""})
        acct._append("note", {"kind": "started", "note": f"Autopilot on · {RISK_PRESETS[risk]['label']}"})
        return self.status()

    def stop(self, close_positions: bool = False) -> dict:
        acct = self.account
        if close_positions:
            for symbol in list(acct.positions):
                price = self._latest_price(symbol) or acct.marks.get(symbol)
                if price:
                    self._sell(symbol, price, "stopped by you")
        acct._append("config", {"running": False})
        acct._append("note", {"kind": "stopped", "note": "Autopilot off"})
        return self.status()

    def clear_activity(self) -> dict:
        """Hide past notes from the feed. The ledger itself is never edited."""
        self.account._append("config", {"activity_cleared_seq": self.account.seq + 1})
        return self.status()

    def reset(self) -> dict:
        if self.account.config.get("running"):
            raise ValueError("Turn the autopilot off first.")
        if self.account.positions:
            raise ValueError("Close open positions first.")
        self.account._append("funded", {"budget_cents": 0, "risk": self.account.config["risk"]})
        return self.status()

    # ----- scheduler -----

    def start_scheduler(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="autopilot", daemon=True)
        self._thread.start()

    def stop_scheduler(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            if self.account.config.get("running"):
                try:
                    self.run_cycle()
                except Exception as exc:  # keep the loop alive; show the error
                    self.last_error = str(exc)[:300]
            self._stop.wait(CYCLE_SECONDS)

    # ----- one pass -----

    def _latest_price(self, symbol):
        try:
            candles = self._fetch(symbol)
            return candles[-1]["close"] if candles else None
        except Exception:
            return None

    def run_cycle(self) -> dict:
        if not self._cycle_lock.acquire(blocking=False):
            return self.status()
        try:
            return self._run_cycle()
        finally:
            self._cycle_lock.release()

    def _run_cycle(self) -> dict:
        acct = self.account
        preset = RISK_PRESETS[acct.config.get("risk", "careful")]
        signals, errors = {}, []
        for symbol in WATCHLIST:
            try:
                candles = self._fetch(symbol)
            except Exception as exc:
                errors.append(f"{symbol}: {exc}")
                continue
            # Entries judge closed bars; exits and marks use the live price.
            closed = [c for c in candles if not c.get("partial")]
            sig = trend_signal(closed)
            if sig.get("ok") and candles:
                sig["price"] = candles[-1]["close"]
                sig["bar"] = closed[-1].get("t") if closed else None
                acct.marks[symbol] = sig["price"]
            signals[symbol] = sig
        self.signals = signals
        self.last_cycle_at = _now()
        self.last_error = "; ".join(errors)[:300]
        if not acct.benchmark.get("BTC") and signals.get("BTC", {}).get("ok"):
            acct.benchmark["BTC"] = signals["BTC"]["price"]

        # Exits first, always.
        for symbol, pos in list(acct.positions.items()):
            sig = signals.get(symbol) or {}
            price = sig.get("price")
            if not price:
                continue
            pos["peak_price"] = max(pos["peak_price"], price)
            reason = exit_reason(pos, price, sig, preset)
            if reason:
                self._sell(symbol, price, reason)
                self._exited_at[symbol] = self._clock()

        # Daily loss limit pauses new entries until tomorrow (UTC).
        today = _day(_now())
        if acct.day_start.get("day") != today:
            acct.day_start = {"day": today, "equity": acct.equity_cents()}
        day_loss = 1 - acct.equity_cents() / max(1, acct.day_start["equity"])
        if day_loss * 100 >= preset["daily_loss_pct"]:
            if acct.config.get("paused_reason") != today:
                acct._append("config", {"paused_reason": today})
                acct._append("note", {"kind": "paused", "note": f"Daily loss limit hit ({preset['daily_loss_pct']}%). "
                                                                "No new trades until tomorrow."})
            return self.status()

        # Entries: strongest trends first, AI may veto.
        candidates = sorted((s for s, sig in signals.items()
                             if sig.get("ok") and sig["entry"] and s not in acct.positions
                             and self._clock() - self._exited_at.get(s, 0) >= COOLDOWN_SECONDS),
                            key=lambda s: signals[s]["score"], reverse=True)
        for symbol in candidates:
            if len(acct.positions) >= preset["max_open"]:
                break
            size_cents = min(acct.cash_cents, round(acct.equity_cents() * preset["position_pct"] / 100))
            if size_cents < 1_000:
                break
            sig = signals[symbol]
            key = (symbol, sig.get("bar"))
            verdict = self._verdicts.get(key)
            if verdict is None:
                verdict = self._review(symbol, sig, preset)
                self._verdicts = {k: v for k, v in self._verdicts.items() if k[0] != symbol}
                self._verdicts[key] = verdict
                if not verdict["approve"]:
                    acct._append("note", {"kind": "skipped", "symbol": symbol, "note": verdict["reason"]})
            if not verdict["approve"]:
                continue
            self._buy(symbol, sig, size_cents, verdict["reason"])
        return self.status()

    def _review(self, symbol, sig, preset) -> dict:
        if not self._reviewer:
            return {"approve": True, "reason": "Uptrend and breakout (rules only)"}
        context = {"open_positions": list(self.account.positions), "risk": preset["label"],
                   "market": {s: {"change_1h_pct": round(v["change_1h"] * 100, 2),
                                  "change_6h_pct": round(v["change_6h"] * 100, 2)}
                              for s, v in self.signals.items() if v.get("ok")}}
        try:
            verdict = self._reviewer(symbol, sig, context) or {}
        except Exception as exc:
            # No review, no new risk. Exits keep running.
            return {"approve": False, "reason": f"AI review unavailable: {str(exc)[:120]}"}
        return {"approve": bool(verdict.get("approve")),
                "reason": str(verdict.get("reason") or "No reason given")[:200]}

    def _buy(self, symbol, sig, size_cents, reason):
        price = sig["price"] * (1 + SLIPPAGE_BPS / 10_000)
        fee = round(size_cents * FEE_BPS / 10_000)
        qty = int((size_cents - fee) * QTY_SCALE / (price * 100))
        if qty <= 0:
            return
        self.account._append("fill", {"side": "buy", "symbol": symbol, "qty": qty, "price": price,
                                      "fee_cents": fee, "atr": sig["atr"], "reason": reason})

    def _sell(self, symbol, price, reason):
        pos = self.account.positions.get(symbol)
        if not pos:
            return
        fill_price = price * (1 - SLIPPAGE_BPS / 10_000)
        gross = round(pos["qty"] * fill_price * 100 / QTY_SCALE)
        fee = round(gross * FEE_BPS / 10_000)
        self.account._append("fill", {"side": "sell", "symbol": symbol, "qty": pos["qty"], "price": fill_price,
                                      "fee_cents": fee, "reason": reason})

    # ----- view -----

    def status(self) -> dict:
        acct = self.account
        budget = acct.config.get("budget_cents", 0)
        equity = acct.equity_cents()
        wins = [t for t in acct.trades if t["pnl_cents"] > 0]
        positions = []
        for symbol, pos in acct.positions.items():
            mark = acct.marks.get(symbol, pos["entry_price"])
            value = round(pos["qty"] * mark * 100 / QTY_SCALE)
            positions.append({"symbol": symbol, "entry": pos["entry_price"], "price": mark,
                              "value_cents": value, "pnl_cents": value - pos["cost_cents"],
                              "opened_at": pos["opened_at"], "reason": pos.get("reason", "")})
        return {
            "running": bool(acct.config.get("running")),
            "risk": acct.config.get("risk", "careful"),
            "presets": {k: v["label"] for k, v in RISK_PRESETS.items()},
            "paused_today": acct.config.get("paused_reason") == _day(_now()),
            "budget_cents": budget, "equity_cents": equity, "cash_cents": acct.cash_cents,
            "pnl_cents": equity - budget if budget else 0,
            "benchmark_cents": acct.benchmark_cents(), "fees_cents": acct.fees_cents,
            "started_at": acct.started_at, "positions": positions,
            "trades": acct.trades[-50:][::-1],
            "closed_trades": len(acct.trades), "wins": len(wins),
            "events": [e for e in acct.events if e.get("seq", 0) > acct.config.get("activity_cleared_seq", 0)][-40:][::-1],
            "watchlist": [{"symbol": s, "price": v.get("price"), "change_1h": v.get("change_1h"),
                           "trending": bool(v.get("uptrend"))}
                          for s, v in self.signals.items() if v.get("ok")],
            "last_cycle_at": self.last_cycle_at, "last_error": self.last_error,
            "ledger": acct.verify(),
        }
