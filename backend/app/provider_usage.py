"""Best-effort read of the provider's REAL balance (Venice), so the UI can show actual
remaining credits instead of only the local 1-per-request estimate.

Venice exposes `GET /api/v1/api_keys/rate_limits`, whose body includes a `balances`
object (VCU / USD / DIEM). We deep-search for it so a schema change degrades gracefully
to "unavailable" rather than crashing. Only attempted for Venice base URLs; other
OpenAI-compatible providers have no standard balance endpoint → the local meter stands.
"""
import httpx

_BALANCE_KEYS = {"VCU", "USD", "DIEM", "USD_EXTERNAL"}


def _find_balances(obj) -> dict:
    found = {}

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if str(k).lower() == "balances" and isinstance(v, dict):
                    for bk, bv in v.items():
                        if isinstance(bv, (int, float)):
                            found[str(bk).upper()] = bv
                elif str(k).upper() in _BALANCE_KEYS and isinstance(v, (int, float)):
                    found[str(k).upper()] = v
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(obj)
    return found


def read_provider_health(base_url: str, kind: str) -> dict:
    """Ping the configured provider so the UI can monitor it. Ollama -> GET /api/tags;
    OpenAI-compatible -> GET /models. Returns {reachable, kind, base_url, models, detail}.
    Never raises."""
    base = (base_url or "").rstrip("/")
    kind = (kind or "openai").lower()
    out = {"reachable": False, "kind": kind, "base_url": base, "models": [], "detail": ""}
    if not base:
        out["detail"] = "no provider configured"
        return out
    url = f"{base}/api/tags" if kind == "ollama" else f"{base}/models"
    try:
        resp = httpx.get(url, timeout=8)
    except httpx.HTTPError as exc:
        out["detail"] = f"unreachable: {exc}"
        return out
    if resp.status_code != 200:
        out["detail"] = f"HTTP {resp.status_code}"
        return out
    try:
        data = resp.json()
    except ValueError:
        out["detail"] = "unparseable response"
        return out
    if kind == "ollama":
        models = [m.get("name", "") for m in data.get("models", []) if isinstance(m, dict)]
    else:
        models = [m.get("id", "") for m in data.get("data", []) if isinstance(m, dict)]
    out["reachable"] = True
    out["models"] = [m for m in models if m]
    if kind == "ollama":
        # Venice adapter extension: which model the Venice page is ACTUALLY on right now
        # (cached adapter-side; instant). Best-effort — plain Ollama has no such endpoint.
        try:
            st = httpx.get(f"{base}/api/aiexe/state", timeout=3)
            if st.status_code == 200:
                state = st.json()
                out["current_model"] = str(state.get("current_model") or "")
                out["credits"] = str(state.get("credits") or "")
                priced = state.get("priced_models") or []
                if isinstance(priced, list):
                    out["priced_models"] = [str(m) for m in priced if m]
                uncensored = state.get("uncensored_models") or []
                if isinstance(uncensored, list):
                    out["uncensored_models"] = [str(m) for m in uncensored if m]
        except Exception:
            pass
    return out


def read_provider_balance(base_url: str, api_key: str) -> dict:
    """Returns {available, source, balances, detail}. Never raises."""
    if not base_url or not api_key:
        return {"available": False, "source": "", "balances": {}, "detail": "no provider/key"}
    if "venice" not in base_url.lower():
        return {"available": False, "source": "other",
                "balances": {}, "detail": "provider has no standard balance endpoint"}
    url = base_url.rstrip("/") + "/api_keys/rate_limits"
    try:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=15)
    except httpx.HTTPError as exc:
        return {"available": False, "source": "venice", "balances": {}, "detail": f"network error: {exc}"}
    if resp.status_code != 200:
        return {"available": False, "source": "venice", "balances": {},
                "detail": f"HTTP {resp.status_code}"}
    try:
        data = resp.json()
    except ValueError:
        return {"available": False, "source": "venice", "balances": {}, "detail": "unparseable response"}
    balances = _find_balances(data)
    return {"available": bool(balances), "source": "venice", "balances": balances,
            "detail": "" if balances else "no balances field found"}
