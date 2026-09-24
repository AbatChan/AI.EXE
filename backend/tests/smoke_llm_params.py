"""Newer models reject classic settings (max_tokens, temperature); the client adapts."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import llm  # noqa: E402


class Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.text = json.dumps(body)

    def json(self):
        return self._body


def main():
    sent = []

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append(dict(json))
        if "max_tokens" in json:
            return Resp(400, {"error": {"param": "max_tokens", "message": "Use 'max_completion_tokens' instead."}})
        if "temperature" in json:
            return Resp(400, {"error": {"param": "temperature", "message": "Unsupported value"}})
        return Resp(200, {"choices": [{"message": {"content": '{"approve": true, "reason": "ok"}'}}], "usage": {}})

    llm.httpx.post, real = fake_post, llm.httpx.post
    try:
        client = llm.LLMClient("https://api.openai.com/v1", "gpt-6-luna", "sk-test", kind="openai", timeout=5)
        out = client.complete_json([{"role": "user", "content": "x"}], max_tokens=50)
    finally:
        llm.httpx.post = real
    assert out["data"] == {"approve": True, "reason": "ok"}, out
    assert sent[-1].get("max_completion_tokens") == 50 and "max_tokens" not in sent[-1] and "temperature" not in sent[-1]
    print("PASS: unsupported max_tokens/temperature are fixed from error.param and retried")

    sent.clear()
    llm.httpx.post = lambda *a, **k: (sent.append(1), Resp(400, {"error": {"param": "messages", "message": "bad"}}))[1]
    try:
        try:
            llm.LLMClient("https://api.openai.com/v1", "m", "sk", kind="openai", timeout=5).complete_json(
                [{"role": "user", "content": "x"}], max_tokens=5)
            raise AssertionError("bad request accepted")
        except llm.LLMError:
            pass
    finally:
        llm.httpx.post = real
    assert len(sent) == 1  # a real client error is not retried blindly
    print("PASS: other 400s are reported, not retried")

    sent.clear()

    def venice_post(url, json=None, headers=None, timeout=None):  # error is a string, no param field
        sent.append(dict(json))
        if "response_format" in json:
            return Resp(400, {"error": "Invalid request parameters",
                              "details": {"_errors": ["response_format is not supported by this model"]}})
        return Resp(200, {"choices": [{"message": {"content": '{"approve": false, "reason": "late"}'}}], "usage": {}})

    llm.httpx.post = venice_post
    try:
        out = llm.LLMClient("https://api.venice.ai/api/v1", "qwen", "k", kind="openai", timeout=5).complete_json(
            [{"role": "user", "content": "x"}], max_tokens=5)
    finally:
        llm.httpx.post = real
    assert out["data"]["approve"] is False and "response_format" not in sent[-1]
    print("PASS: string-shaped errors (Venice) don't crash; the named setting is dropped")
    print("\n3 checks passed.")


if __name__ == "__main__":
    main()
