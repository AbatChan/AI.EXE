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


class LLMClient:
    def __init__(self, base_url: str, model: str, api_key: str, timeout: int = 120):
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def complete(self, messages, temperature: float = 0.2, max_tokens: int = 8192) -> str:
        if not self.api_key:
            raise LLMError("No API key set — POST /api/api-key first.", 401)
        if not self.base_url:
            raise LLMError("No LLM provider configured — set AIEXE_LLM_BASE_URL.", 400)
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
                return resp.json()["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError, ValueError):
                raise LLMError("Unexpected provider response shape.")
        raise last_err or LLMError("Provider call failed after retries.")
