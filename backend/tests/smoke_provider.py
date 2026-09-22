"""Logic tests for §9 provider config store. No deps.

Run:  python backend/tests/smoke_provider.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.provider import ProviderStore, is_local_provider  # noqa: E402
import app.llm as llm_module  # noqa: E402
from app.llm import LLMClient, parse_ollama_content, parse_openai_content  # noqa: E402
from app.provider_usage import read_provider_health  # noqa: E402

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

# Provider kind (openai default / ollama for the Venice Pro adapter).
sk = ProviderStore(tempfile.mkdtemp(), "", "")
assert sk.kind() == "openai"
sk.set("http://127.0.0.1:9999", "llama-3.1-405b-akash-api", "ollama")
assert sk.kind() == "ollama" and sk.resolve()[0] == "http://127.0.0.1:9999"
ok("provider kind persists (ollama) for the adapter")

# Response parsers for both protocols.
assert parse_openai_content({"choices": [{"message": {"content": "hi"}}]}) == "hi"
assert parse_ollama_content({"message": {"content": "yo"}}) == "yo"      # /api/chat
assert parse_ollama_content({"response": "gen"}) == "gen"               # /api/generate
ok("openai + native-ollama response parsers")


class FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


responses = iter([
    FakeResponse({"choices": [{"message": {"content": ""}}],
                  "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}),
    FakeResponse({"choices": [{"message": {"content": "not json"}}],
                  "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}}),
    FakeResponse({"choices": [{"message": {"content": None, "tool_calls": [{"function": {
        "name": "submit_research_portfolios",
        "arguments": '{"episodes":[{"episode":1,"allocations":{"A":50},"rationale":"ok"}]}'
    }}]}}], "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}),
])
payloads = []
original_post = llm_module.httpx.post
llm_module.httpx.post = lambda _url, json, **_kwargs: (payloads.append(dict(json)) or next(responses))
try:
    structured = LLMClient("https://api.deepseek.com", "deepseek-v4-flash", "test").complete_json(
        [{"role": "user", "content": "JSON portfolio"}])
finally:
    llm_module.httpx.post = original_post
assert structured["data"]["episodes"][0]["episode"] == 1
assert [item["mode"] for item in structured["attempts"]] == [
    "structured-thinking", "structured-plain", "tool-call"]
assert structured["attempts"][1]["invalid_json"] is True
assert structured["usage"]["total_tokens"] == 39
assert "tools" in payloads[2] and "response_format" not in payloads[2]
assert payloads[1]["thinking"] == {"type": "disabled"}
assert payloads[2]["thinking"] == {"type": "disabled"}
ok("structured JSON falls back to a forced tool call")

# Health monitor degrades gracefully when the adapter isn't running.
h = read_provider_health("http://127.0.0.1:1", "ollama")
assert h["reachable"] is False and h["kind"] == "ollama"
ok("provider-health is graceful when the adapter is unreachable")

print(f"\n{passed} checks passed.")
