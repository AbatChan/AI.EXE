"""Vet npm package names the agent's code imports before they reach package.json.

A name is trusted only if the public registry shows it is real, established and
in wide use — the bar a hallucinated or typo-squatted name can't clear.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MIN_WEEKLY_DOWNLOADS = 5000
MIN_AGE_DAYS = 90
CACHE_TTL_S = 24 * 3600
MAX_NAMES = 25

_NAME_RE = re.compile(r"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")
_UA = "AI.EXE package check (+https://github.com)"


def valid_name(name: str) -> bool:
    return bool(name) and len(name) <= 214 and bool(_NAME_RE.match(name))


def _http_json(url: str, timeout: float = 8.0):
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        raise


def fetch_latest(name: str):
    # /latest is one small version doc; the full packument of big packages is huge.
    return _http_json("https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@") + "/latest")


def fetch_download_history(name: str) -> list:
    data = _http_json("https://api.npmjs.org/downloads/range/last-year/" + urllib.parse.quote(name, safe="@"))
    return [int(d.get("downloads") or 0) for d in ((data or {}).get("downloads") or [])]


def vet_one(name: str, latest_doc=fetch_latest, history=fetch_download_history) -> dict:
    out = {"name": name, "trusted": False, "version": "", "reason": ""}
    if not valid_name(name):
        out["reason"] = "not a valid npm package name"
        return out
    try:
        doc = latest_doc(name)
    except Exception:  # network: unknown, never trusted
        out.update({"reason": "npm registry unreachable", "offline": True})
        return out
    if not doc:
        out["reason"] = "does not exist on npm"
        return out
    latest = str(doc.get("version") or "")
    if not latest:
        out["reason"] = "has no published release"
        return out
    if doc.get("deprecated"):
        out["reason"] = "latest release is deprecated"
        return out
    try:
        days = history(name)
    except Exception:
        out.update({"reason": "npm download stats unreachable", "offline": True})
        return out
    first = next((i for i, n in enumerate(days) if n > 0), None)
    age = 0 if first is None else len(days) - first
    weekly = sum(days[-7:])
    out.update({"weeklyDownloads": weekly, "ageDays": age, "latest": latest})
    if age < MIN_AGE_DAYS:
        out["reason"] = f"only about {age} days old"
        return out
    if weekly < MIN_WEEKLY_DOWNLOADS:
        out["reason"] = f"only {weekly} downloads last week"
        return out
    out.update({"trusted": True, "version": "^" + latest})
    return out


class NpmVetter:
    """Small TTL cache in front of vet_one; offline results aren't cached."""

    def __init__(self, latest_doc=fetch_latest, history=fetch_download_history):
        self._latest_doc = latest_doc
        self._history = history
        self._cache: dict = {}
        self._lock = threading.Lock()

    def vet(self, names) -> list:
        results = []
        for raw in list(dict.fromkeys(str(n or "").strip().lower() for n in names or []))[:MAX_NAMES]:
            if not raw:
                continue
            with self._lock:
                hit = self._cache.get(raw)
            if hit and time.time() - hit[0] < CACHE_TTL_S:
                results.append(hit[1])
                continue
            res = vet_one(raw, self._latest_doc, self._history)
            if not res.get("offline"):
                with self._lock:
                    self._cache[raw] = (time.time(), res)
            results.append(res)
        return results


vetter = NpmVetter()
