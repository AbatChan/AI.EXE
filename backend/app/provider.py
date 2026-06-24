"""§9 — persisted LLM provider config (base_url + model), so Venice/etc. can be set
from the UI Settings instead of only env. Stored server-side next to the API key."""
import json
import os
import threading
from typing import Tuple

from .usage import _atomic_write


def is_local_provider(base_url: str) -> bool:
    """A local model server (Ollama / llama.cpp) — no API key, no credits."""
    b = str(base_url or "").lower()
    return any(h in b for h in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"))


class ProviderStore:
    def __init__(self, data_dir: str, default_base_url: str, default_model: str):
        self._path = os.path.join(data_dir, "provider.json")
        self._lock = threading.Lock()
        self._default = (default_base_url, default_model)

    def _load(self) -> dict:
        try:
            with open(self._path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def set(self, base_url: str, model: str) -> None:
        with self._lock:
            _atomic_write(self._path, {
                "base_url": str(base_url or "").strip().rstrip("/"),
                "model": str(model or "").strip(),
            }, mode=0o600)

    def resolve(self) -> Tuple[str, str]:
        """Stored config wins; fall back to the env defaults."""
        d = self._load()
        return (d.get("base_url") or self._default[0],
                d.get("model") or self._default[1])

    def configured(self) -> bool:
        return bool(self.resolve()[0])
