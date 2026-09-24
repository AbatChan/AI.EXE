"""Provider-agnostic LLM client (OpenAI-compatible /chat/completions).

Default shape matches what the existing AI.EXE app already uses (Venice / deepseek /
qwen / OpenAI are all OpenAI-compatible), so the provider is just base_url + model +
key config. Retries transient errors (429/5xx, network) with backoff; surfaces
401/402/403 (bad key / out of credits / forbidden) as clear errors.
"""
import json
import time

import httpx

from .errors import describe_error


class LLMError(Exception):
    def __init__(self, message: str, status: int = None):
        super().__init__(message)
        self.status = status


def parse_openai_content(data: dict) -> str:
    return data["choices"][0]["message"]["content"]


def parse_openai_json_payload(data: dict) -> str:
    message = data["choices"][0]["message"]
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        if function.get("name") == "submit_research_portfolios":
            return function.get("arguments") or ""
    return message.get("content") or ""


def parse_ollama_content(data: dict) -> str:
    # Native Ollama: /api/chat -> {"message": {"content": ...}}; /api/generate -> {"response": ...}
    if isinstance(data, dict):
        if isinstance(data.get("message"), dict) and "content" in data["message"]:
            return data["message"]["content"]
        if "response" in data:
            return data["response"]
    raise LLMError("Unexpected Ollama response shape.")


# Newer models reject some classic settings; the API names the bad one in error.param.
_PARAM_FIXES = {
    "max_tokens": lambda p: p.__setitem__("max_completion_tokens", p.pop("max_tokens")),
    "temperature": lambda p: p.pop("temperature", None),
    "reasoning_effort": lambda p: p.pop("reasoning_effort", None),
    "thinking": lambda p: p.pop("thinking", None),
    "response_format": lambda p: p.pop("response_format", None),
}


def _rejected_param(resp, payload):
    """Which setting we sent did the provider reject? OpenAI names it in error.param;
    others (e.g. Venice) only mention it in their error details."""
    try:
        body = resp.json()
    except ValueError:
        return None
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and error.get("param") in _PARAM_FIXES:
        return error["param"]
    text = json.dumps(body)
    return next((name for name in _PARAM_FIXES if name in payload and name in text), None)


def _post(url, payload, headers, timeout):
    """POST, retrying once per unsupported parameter the provider reports."""
    for _ in range(len(_PARAM_FIXES) + 1):
        resp = httpx.post(url, json=payload, headers=headers, timeout=timeout)
        if resp.status_code != 400:
            return resp
        param = _rejected_param(resp, payload)
        if not param:
            return resp
        _PARAM_FIXES[param](payload)
    return resp


class LLMClient:
    def __init__(self, base_url: str, model: str, api_key: str, timeout: int = 120, kind: str = "openai"):
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.kind = str(kind or "openai").lower()  # "openai" | "ollama"

    def complete(self, messages, temperature: float = 0.2, max_tokens: int = 8192,
                 chat_id: str = "", think: str = "", web_search: str = "",
                 chat_name: str = "", attachments=None) -> str:
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
            if web_search in ("on", "off"):  # adapter extension: Venice live web-search switch
                payload["aiexe_web_search"] = web_search
            if chat_name:  # adapter extension: rename the Venice conversation to match
                payload["aiexe_chat_name"] = str(chat_name)
            if attachments:  # adapter extension: images to upload via Venice's file input
                payload["aiexe_attachments"] = attachments
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
                resp = _post(url, payload, headers, self.timeout)
            except httpx.HTTPError as exc:
                last_err = LLMError(f"Couldn't reach the AI provider: {describe_error(exc, 'the AI provider')}")
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

    def complete_json(self, messages, max_tokens: int = 4096) -> dict:
        """Structured research call with a tool-call fallback."""
        if not self.base_url:
            raise LLMError("No LLM provider configured — set AIEXE_LLM_BASE_URL.", 400)
        if self.kind == "ollama":
            if not self.api_key:
                self.api_key = "local"
            url = f"{self.base_url}/api/chat"
            payload = {"model": self.model, "messages": messages, "stream": False,
                       "format": "json", "options": {"temperature": 0, "num_predict": max_tokens}}
            headers = {"Content-Type": "application/json"}
        else:
            if not self.api_key:
                raise LLMError("No API key set — POST /api/api-key first.", 401)
            url = f"{self.base_url}/chat/completions"
            payload = {"model": self.model, "messages": messages, "temperature": 0,
                       "max_tokens": max_tokens, "response_format": {"type": "json_object"}}
            if "deepseek.com" in self.base_url:
                payload["thinking"] = {"type": "enabled"}
                payload["reasoning_effort"] = "high"
            if "venice.ai" in self.base_url:  # our instructions only, not Venice's house prompt
                payload["venice_parameters"] = {"include_venice_system_prompt": False}
            headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

        started = time.monotonic()
        attempts = []
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        attempt_count = 2 if self.kind == "ollama" else 3
        for structured_attempt in range(attempt_count):
            try:
                response = _post(url, payload, headers, self.timeout)
            except httpx.HTTPError as exc:
                raise LLMError(f"Couldn't reach the AI provider: {describe_error(exc, 'the AI provider')}") from exc
            if response.status_code in (401, 402, 403):
                raise LLMError(f"Provider rejected the request ({response.status_code}): {response.text[:200]}",
                               response.status_code)
            if response.status_code != 200:
                raise LLMError(f"Provider error ({response.status_code}): {response.text[:200]}",
                               response.status_code)
            try:
                data = response.json()
                content = (parse_ollama_content(data) if self.kind == "ollama"
                           else parse_openai_json_payload(data))
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise LLMError("Unexpected provider response shape.") from exc
            provider_usage = data.get("usage") or {}
            for key in usage:
                usage[key] += int(provider_usage.get(key) or 0)
            mode = ("structured-thinking" if structured_attempt == 0 else
                    "structured-plain" if structured_attempt == 1 else "tool-call")
            attempt = {"mode": mode, "empty": not bool(str(content or "").strip())}
            attempts.append(attempt)
            if str(content or "").strip():
                try:
                    parsed = json.loads(content)
                except (TypeError, ValueError):
                    attempt["invalid_json"] = True
                else:
                    return {"data": parsed,
                            "latency_ms": round((time.monotonic() - started) * 1000),
                            "attempts": attempts, "usage": usage,
                            "system_fingerprint": data.get("system_fingerprint") or ""}
            if structured_attempt == 0:
                if "deepseek.com" in self.base_url:
                    payload["thinking"] = {"type": "disabled"}
                else:
                    payload.pop("thinking", None)
                payload.pop("reasoning_effort", None)
            elif structured_attempt == 1 and self.kind != "ollama":
                payload.pop("response_format", None)
                payload["tools"] = [{"type": "function", "function": {
                    "name": "submit_research_portfolios",
                    "description": "Submit every blinded portfolio decision.",
                    "parameters": {"type": "object", "properties": {
                        "episodes": {"type": "array", "items": {"type": "object",
                            "properties": {"episode": {"type": "integer"},
                                "allocations": {"type": "object",
                                    "additionalProperties": {"type": "integer", "enum": [0, 25, 50]}},
                                "rationale": {"type": "string"}},
                            "required": ["episode", "allocations", "rationale"]}}},
                        "required": ["episodes"]}}}]
                payload["tool_choice"] = {"type": "function", "function": {
                    "name": "submit_research_portfolios"}}
        raise LLMError("Provider returned no usable structured result after all fallbacks.")
