"""The autopilot's AI is its own choice: chat changes don't move it; the key stays private."""
import os
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import autopilot_ai  # noqa: E402


class Chat:  # stands in for the chat provider/key stores
    def __init__(self, base, model, key):
        self.base, self.model, self.key_value = base, model, key

    def resolve(self):
        return self.base, self.model

    def kind(self):
        return "openai"

    def get_for_internal_use(self):
        return self.key_value


class Usage:
    def consume(self):
        pass


def main():
    seen = []

    class FakeClient:
        def __init__(self, base, model, key, kind="openai", timeout=90):
            seen.append((base, model, key))

        def complete_json(self, messages, max_tokens=400):
            return {"data": {"approve": True, "reason": "ok"}}

    real = autopilot_ai.LLMClient
    autopilot_ai.LLMClient = FakeClient
    try:
        with tempfile.TemporaryDirectory() as d:
            chat = Chat("https://api.openai.com/v1", "gpt-6-luna", "sk-chat")
            store = autopilot_ai.AutopilotAIStore(d)
            review = autopilot_ai.make_reviewer(chat, chat, Usage(), store)
            sig = {"change_1h": 0.01, "change_6h": 0.02, "volatility": 0.01, "score": 1.0}
            review("SOL", sig, {})
            assert seen[-1] == ("https://api.openai.com/v1", "gpt-6-luna", "sk-chat"), seen
            print("PASS: with no own choice, the autopilot follows the chat model")

            store.set("https://api.deepseek.com", "deepseek-flash", "sk-trade", "DeepSeek")
            chat.model = "gpt-6-sol"  # user changes chat model; autopilot must not follow
            review("SOL", sig, {})
            assert seen[-1] == ("https://api.deepseek.com", "deepseek-flash", "sk-trade"), seen
            assert stat.S_IMODE(os.stat(os.path.join(d, "autopilot_ai_key")).st_mode) == 0o600
            assert "sk-trade" not in open(os.path.join(d, "autopilot_ai.json")).read()
            print("PASS: its own choice wins over chat changes; key file is 0600 and kept out of the config")

            for bad in (("http://evil.example", "m", "k"), ("https://api.x.com", "", "k"), ("https://api.x.com", "m", "")):
                try:
                    store.set(*bad)
                    raise AssertionError(f"accepted {bad}")
                except ValueError:
                    pass
            store.clear()
            review("SOL", sig, {})
            assert seen[-1][1] == "gpt-6-sol"
            print("PASS: bad settings are refused; clearing goes back to following chat")
    finally:
        autopilot_ai.LLMClient = real
    print("\n3 checks passed.")


if __name__ == "__main__":
    main()
