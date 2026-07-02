"""Backend settings. Local-only by default — the desktop UI runs on the same machine."""
import os
import time

BACKEND_VERSION = "0.19.2"


class Settings:
    backend_version = BACKEND_VERSION
    host = os.environ.get("AIEXE_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("AIEXE_BACKEND_PORT", "8765"))
    # CORS: the existing desktop UI + any future separate frontend.
    allowed_origins = os.environ.get("AIEXE_BACKEND_ORIGINS", "*").split(",")
    started_at = time.time()

    # Local persisted state (usage counters, API key). Gitignored.
    data_dir = os.environ.get(
        "AIEXE_BACKEND_DATA_DIR",
        os.path.join(os.path.dirname(os.path.dirname(__file__)), ".data"),
    )

    # §8 — API constraints (env-overridable). Default credits = Venice Pro+ ($60/mo =
    # 7,500 credits). NOTE: Venice may meter per-model/per-token, so the local counter is
    # an approximation — set AIEXE_CREDIT_COST or read Venice's real balance to be exact.
    rate_limit_max = int(os.environ.get("AIEXE_RATE_LIMIT_MAX", "20"))            # requests/min
    rate_limit_window_seconds = int(os.environ.get("AIEXE_RATE_LIMIT_WINDOW", "60"))
    credit_limit_monthly = int(os.environ.get("AIEXE_CREDIT_LIMIT", "7500"))      # Venice Pro+
    credit_cost_per_request = int(os.environ.get("AIEXE_CREDIT_COST", "1"))       # 1 req = 1 credit (assumption)
    credit_warn_ratio = float(os.environ.get("AIEXE_CREDIT_WARN_RATIO", "0.9"))   # warn at 90%

    # §2 — LLM provider (OpenAI-compatible). base_url empty => /api/generate returns a
    # clear "no provider configured" error until Alex confirms the provider (§14).
    llm_base_url = os.environ.get("AIEXE_LLM_BASE_URL", "")       # e.g. https://api.openai.com/v1
    llm_model = os.environ.get("AIEXE_LLM_MODEL", "gpt-4o-mini")  # placeholder default

    # §6/§7 — uploaded workshop modules land under <workshop_dir>/modules/.
    workshop_dir = os.environ.get("AIEXE_WORKSHOP_DIR", os.path.join(data_dir, "workshop"))

    # Per-request HTTP budget for the Venice Pro adapter (browser automation + reasoning
    # models take minutes) vs. a normal API provider. Env-overridable, used in one place.
    adapter_http_timeout = int(os.environ.get("AIEXE_ADAPTER_HTTP_TIMEOUT", "300"))
    provider_http_timeout = int(os.environ.get("AIEXE_PROVIDER_HTTP_TIMEOUT", "120"))


settings = Settings()
