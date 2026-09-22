"""Per-install secret for browser-originated calls.

A sandboxed iframe on any website sends `Origin: null`, the same as our desktop
WebView, so origin alone can't tell them apart. The desktop app reads this file
(owner-only) and sends the token; a web page cannot.
"""
import hmac
import os
import secrets

TOKEN_FILE = "backend_token"
HEADER = "x-aiexe-token"
# WebSockets can't set headers; the token rides in the subprotocol (never the URL,
# which lands in access logs).
SUBPROTOCOL_PREFIX = "aiexe."


def load_or_create(data_dir: str) -> str:
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, TOKEN_FILE)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            token = handle.read().strip()
        if len(token) >= 32:
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token


def origin_allowed(origin: str, presented: str, token: str, allowed: set) -> bool:
    """No Origin = local process; a real listed origin can't be forged by a page;
    'null' (or file://) is forgeable, so it must carry the token."""
    origin = (origin or "").strip()
    if not origin:
        return True
    if origin != "null" and not origin.startswith("file://"):
        return origin in allowed
    return bool(presented) and hmac.compare_digest(presented, token)


def from_subprotocols(header: str) -> str:
    for item in (header or "").split(","):
        item = item.strip()
        if item.startswith(SUBPROTOCOL_PREFIX):
            return item
    return ""
