"""Monthly token-usage ledger per provider/model, from the usage each API reports.

The UI normalises every provider's usage block (OpenAI, DeepSeek, Venice, Gemini,
Anthropic) to the same fields and posts one record per call; this file only sums.
"""
import json
import os
import threading
import time
from pathlib import Path

FIELDS = ("input", "cached", "cache_write", "output", "reasoning")
_MAX_NAME = 120


def _period(now=None) -> str:
    return time.strftime("%Y-%m", time.localtime(now if now is not None else time.time()))


def _clean_name(value) -> str:
    return str(value or "unknown").strip()[:_MAX_NAME] or "unknown"


def _count(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return n if 0 <= n < 50_000_000 else 0


class TokenUsageLedger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, separators=(",", ":")), "utf-8")
        os.replace(tmp, self.path)

    def record(self, provider, model, usage: dict, now=None, chat_id="") -> dict:
        usage = usage if isinstance(usage, dict) else {}
        with self._lock:
            data = self._load()
            months = data.setdefault("months", {})
            month = months.setdefault(_period(now), {})
            row = month.setdefault(_clean_name(provider), {}).setdefault(_clean_name(model), {"calls": 0})
            row["calls"] = row.get("calls", 0) + 1
            for field in FIELDS:
                row[field] = row.get(field, 0) + _count(usage.get(field))
            day = time.strftime("%Y-%m-%d", time.localtime(now if now is not None else time.time()))
            details = data.setdefault("details", {}).setdefault(_period(now), {"days": {}, "chats": {}})
            daily = details["days"].setdefault(day, {})
            chat = details["chats"].setdefault(str(chat_id or "")[:160], {})
            for bucket in (daily, chat):
                bucket["calls"] = bucket.get("calls", 0) + 1
                for field in FIELDS:
                    bucket[field] = bucket.get(field, 0) + _count(usage.get(field))
            # Keep a year of months.
            for old in sorted(months)[:-12]:
                months.pop(old, None)
                data.get("details", {}).pop(old, None)
            self._save(data)
            return dict(row)

    def summary(self, period: str = "") -> dict:
        with self._lock:
            data = self._load()
        month = (data.get("months") or {}).get(period or _period(), {})
        details = (data.get("details") or {}).get(period or _period(), {})
        return {"period": period or _period(), "providers": month,
                "days": details.get("days", {}), "chats": details.get("chats", {})}
