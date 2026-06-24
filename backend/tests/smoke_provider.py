"""Logic tests for §9 provider config store. No deps.

Run:  python backend/tests/smoke_provider.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.provider import ProviderStore, is_local_provider  # noqa: E402

d = tempfile.mkdtemp()
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


# Falls back to env defaults when nothing is stored.
s = ProviderStore(d, "https://env.example/v1", "env-model")
assert s.resolve() == ("https://env.example/v1", "env-model") and s.configured()
ok("resolves to env defaults when unset")

# No env default + nothing stored => not configured.
s2 = ProviderStore(tempfile.mkdtemp(), "", "")
assert s2.resolve() == ("", "") and not s2.configured()
ok("reports not-configured with no env default and no stored value")

# Stored config wins and trims a trailing slash.
s2.set("https://api.venice.ai/api/v1/", "venice-model")
assert s2.resolve() == ("https://api.venice.ai/api/v1", "venice-model") and s2.configured()
ok("stored provider overrides and is normalized")

# Persists across restart.
s3 = ProviderStore(s2._path and os.path.dirname(s2._path), "", "")
assert s3.resolve()[0] == "https://api.venice.ai/api/v1"
ok("provider config persists across restart")

# Local provider detection (no key / no credits path).
assert is_local_provider("http://127.0.0.1:11434/v1")
assert is_local_provider("http://localhost:3000/v1")
assert not is_local_provider("https://api.venice.ai/api/v1")
ok("detects local (Ollama/llama.cpp) vs remote providers")

print(f"\n{passed} checks passed.")
