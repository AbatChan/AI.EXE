"""A web page must not drive the local backend, even via a forged `Origin: null`."""
import os
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["AIEXE_BACKEND_DATA_DIR"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402

from app import access_token  # noqa: E402
from app.main import BACKEND_TOKEN, app  # noqa: E402


def ok(label):
    print(f"PASS: {label}")


def main():
    path = Path(os.environ["AIEXE_BACKEND_DATA_DIR"]) / access_token.TOKEN_FILE
    assert path.read_text().strip() == BACKEND_TOKEN and len(BACKEND_TOKEN) >= 32
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert access_token.load_or_create(os.environ["AIEXE_BACKEND_DATA_DIR"]) == BACKEND_TOKEN
    ok("token is persisted owner-only and stable across restarts")

    client = TestClient(app)
    url = "/api/broker/autopilot"
    assert client.get(url).status_code == 200
    ok("local processes (no Origin) still work")

    assert client.get(url, headers={"Origin": "null"}).status_code == 403
    assert client.get(url, headers={"Origin": "null", access_token.HEADER: "guess"}).status_code == 403
    assert client.post("/api/api-key", json={"api_key": "attacker"}, headers={"Origin": "null"}).status_code == 403
    ok("forged Origin: null without the token is blocked (incl. API-key overwrite)")

    assert client.get(url, headers={"Origin": "https://evil.example", access_token.HEADER: BACKEND_TOKEN}).status_code == 403
    ok("unknown real origins are blocked even with a stolen token")

    assert client.get(url, headers={"Origin": "null", access_token.HEADER: BACKEND_TOKEN}).status_code == 200
    assert client.get(f"{url}?aiexe_token={BACKEND_TOKEN}", headers={"Origin": "null"}).status_code == 403  # never via URL
    assert access_token.from_subprotocols(f"chat, aiexe.{BACKEND_TOKEN}") == f"aiexe.{BACKEND_TOKEN}"
    assert client.options(url, headers={"Origin": "null", "Access-Control-Request-Method": "GET"}).status_code in (200, 400)
    ok("the desktop UI with the token works via header or WebSocket subprotocol, never the URL")
    print("\n5 checks passed.")


if __name__ == "__main__":
    main()
