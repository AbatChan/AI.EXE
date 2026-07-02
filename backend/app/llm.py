"""Provider-agnostic LLM client (OpenAI-compatible /chat/completions).

Default shape matches what the existing AI.EXE app already uses (Venice / deepseek /
qwen / OpenAI are all OpenAI-compatible), so the provider is just base_url + model +
key config. Retries transient errors (429/5xx, network) with backoff; surfaces
401/402/403 (bad key / out of credits / forbidden) as clear errors.
"""
import time

import httpx


class LLMError(Exception):
    def __init__(self, message: str, status: int = None):
        super().__init__(message)
        self.status = status


def parse_openai_content(data: dict) -> str:
    return data["choices"][0]["message"]["content"]


def parse_ollama_content(data: dict) -> str:
    # Native Ollama: /api/chat -> {"message": {"content": ...}}; /api/generate -> {"response": ...}
    if isinstance(data, dict):
        if isinstance(data.get("message"), dict) and "content" in data["message"]:
            return data["message"]["content"]
        if "response" in data:
            return data["response"]
    raise LLMError("Unexpected Ollama response shape.")


class LLMClient:
    def __init__(self, base_url: str, model: str, api_key: str, timeout: int = 120, kind: str = "openai"):
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.kind = str(kind or "openai").lower()  # "openai" | "ollama"

    def complete(self, messages, temperature: float = 0.2, max_tokens: int = 8192,
                 chat_id: str = "", think: str = "") -> str:
        if not self.base_url:
            raise LLMError("No LLM provider configured — set AIEXE_LLM_BASE_URL.", 400)
        if self.kind == "ollama":
            # Native Ollama API (e.g. the Venice Pro browser adapter on :9999). No key.
            url = f"{self.base_url}/api/chat"
            payload = {"model": self.model, "messages": messages, "stream": False,
                       "options": {"temperature": temperature, "num_predict": max_tokens}}
            if chat_id:  # adapter extension: one Venice conversation per AI.EXE chat
                payload["aiexe_chat_id"] = str(chat_id)
            if think in ("on", "off"):  # adapter extension: Venice per-chat Reasoning switch
                payload["aiexe_think"] = think
            headers = {"Content-Type": "application/json"}
        else:
            if not self.api_key:
                raise LLMError("No API key set — POST /api/api-key first.", 401)
            url = f"{self.base_url}/chat/completions"
            payload = {"model": self.model, "messages": messages,
                       "temperature": temperature, "max_tokens": max_tokens}
            headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        last_err = None
        for attempt in range(3):
            try:
                resp = httpx.post(url, json=payload, headers=headers, timeout=self.timeout)
            except httpx.HTTPError as exc:
                last_err = LLMError(f"Network error calling provider: {exc}")
                time.sleep(1.0 * (attempt + 1))
                continue
            if resp.status_code in (401, 402, 403):
                raise LLMError(
                    f"Provider rejected the request ({resp.status_code}): {resp.text[:200]}",
                    resp.status_code,
                )
            if resp.status_code == 429 or resp.status_code >= 500:
                last_err = LLMError(f"Provider transient error ({resp.status_code}).", resp.status_code)
                time.sleep(1.5 * (attempt + 1))
                continue
            if resp.status_code != 200:
                raise LLMError(f"Provider error ({resp.status_code}): {resp.text[:200]}", resp.status_code)
            try:
                data = resp.json()
                return parse_ollama_content(data) if self.kind == "ollama" else parse_openai_content(data)
            except (KeyError, IndexError, TypeError, ValueError):
                raise LLMError("Unexpected provider response shape.")
        raise last_err or LLMError("Provider call failed after retries.")
