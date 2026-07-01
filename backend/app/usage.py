"""§8 — rate limiting (20/60s), monthly credit tracking (11k), and secure API-key
storage. All state persists to a local JSON file so counters survive restarts.

Metered endpoints (e.g. /api/generate, built in item 4) call `UsageManager.consume()`.
Read-only endpoints call `snapshot()`. Neither /health, /api/status, nor /api/usage
itself is metered.
"""
import json
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Optional


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        self.retry_after = max(0.0, retry_after)


class CreditExhausted(Exception):
    pass


def _now() -> float:
    return time.time()


def _current_period() -> str:
    # Calendar month (UTC) by default; switch to a billing-cycle date later if Alex wants.
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _atomic_write(path: str, data: dict, mode: int = 0o600) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


class UsageManager:
    def __init__(self, data_dir: str, rate_max: int, rate_window: int,
                 credit_limit: int, cost: int, warn_ratio: float):
        self.data_dir = data_dir
        self.rate_max = rate_max
        self.rate_window = rate_window
        self.credit_limit = credit_limit
        self.cost = cost
        self.warn_ratio = warn_ratio
        self._path = os.path.join(data_dir, "usage.json")
        self._lock = threading.Lock()
        self._timestamps: Deque[float] = deque()  # sliding window (in-memory)
        self._state = self._load()

    # ---- persistence ----
    def _load(self) -> dict:
        try:
            with open(self._path, encoding="utf-8") as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            state = {}
        state.setdefault("period", _current_period())
        state.setdefault("credits_used", 0)
        return state

    def _persist(self) -> None:
        _atomic_write(self._path, self._state)

    # ---- internal ----
    def _maybe_reset_period(self) -> None:
        period = _current_period()
        if self._state.get("period") != period:
            self._state["period"] = period
            self._state["credits_used"] = 0
            self._persist()

    def _prune(self, now: float) -> None:
        cutoff = now - self.rate_window
        while self._timestamps and self._timestamps[0] <= cutoff:
            self._timestamps.popleft()

    def _build_snapshot(self, now: float) -> dict:
        used = self._state["credits_used"]
        remaining = max(0, self.credit_limit - used)
        in_window = len(self._timestamps)
        near_credit = used >= self.credit_limit * self.warn_ratio
        warning = None
        if remaining <= 0:
            warning = "Monthly credit limit reached."
        elif near_credit:
            warning = f"Approaching monthly credit limit ({used}/{self.credit_limit})."
        return {
            "period": self._state["period"],
            "credits_used": used,
            "credits_limit": self.credit_limit,
            "credits_remaining": remaining,
            "credit_cost_per_request": self.cost,
            "requests_in_window": in_window,
            "rate_limit_max": self.rate_max,
            "rate_limit_window_seconds": self.rate_window,
            "requests_remaining_in_window": max(0, self.rate_max - in_window),
            "warning": warning,
        }

    # ---- public ----
    def snapshot(self) -> dict:
        with self._lock:
            self._maybe_reset_period()
            now = _now()
            self._prune(now)
            return self._build_snapshot(now)

    def consume(self) -> dict:
        """Enforce rate + credit limits, then charge one request. Raises on limit."""
        with self._lock:
            self._maybe_reset_period()
            now = _now()
            self._prune(now)
            if len(self._timestamps) >= self.rate_max:
                retry_after = self.rate_window - (now - self._timestamps[0])
                raise RateLimited(retry_after)
            if self._state["credits_used"] + self.cost > self.credit_limit:
                raise CreditExhausted()
            self._timestamps.append(now)
            self._state["credits_used"] += self.cost
            self._persist()
            return self._build_snapshot(now)


class ApiKeyStore:
    """Stores the provider API key server-side (file, 0600) so it is never in the
    frontend. Reads only ever return a masked form."""

    def __init__(self, data_dir: str):
        self._path = os.path.join(data_dir, "apikey.json")
        self._lock = threading.Lock()

    def set(self, key: str) -> None:
        with self._lock:
            _atomic_write(self._path, {"api_key": str(key or "").strip()})

    def _raw(self) -> Optional[str]:
        try:
            with open(self._path, encoding="utf-8") as fh:
                return json.load(fh).get("api_key") or None
        except (OSError, ValueError):
            return None

    def is_set(self) -> bool:
        return bool(self._raw())

    def masked(self) -> Optional[str]:
        key = self._raw()
        if not key:
            return None
        if len(key) <= 8:
            return "*" * len(key)
        return f"{key[:4]}…{key[-4:]}"

    def get_for_internal_use(self) -> Optional[str]:
        """Only the backend's own generate/LLM calls use this — never an endpoint."""
        return self._raw()
