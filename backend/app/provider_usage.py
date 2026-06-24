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
