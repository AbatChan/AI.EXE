"""Price errors read like sentences, judged by exception type, never raw repr."""
import socket
import ssl
import sys
import tempfile
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import autopilot as ap  # noqa: E402
from app.prices import describe_network_error  # noqa: E402


def main():
    cases = [
        (urllib.error.URLError(TimeoutError("_ssl.c:1063: The handshake operation timed out")), "the price service timed out"),
        (TimeoutError("read timed out"), "the price service timed out"),
        (urllib.error.URLError(socket.gaierror(8, "nodename nor servname provided")), "no internet connection"),
        (urllib.error.URLError(ssl.SSLError(1, "CERTIFICATE_VERIFY_FAILED")), "secure connection to the price service failed"),
        (urllib.error.HTTPError("u", 429, "Too Many", {}, None), "the price service is busy right now"),
        (urllib.error.HTTPError("u", 503, "Down", {}, None), "the price service is having problems"),
        (ValueError("Expecting value"), "the price service sent an unreadable reply"),
    ]
    for exc, want in cases:
        got = describe_network_error(exc)
        assert got == want, (exc, got)
        assert "_ssl" not in got and "<" not in got
    print("PASS: network errors map to plain sentences by type")

    import httpx
    from app.errors import describe_error

    def implicit(outer, inner):  # libraries often chain via __context__, not __cause__
        try:
            try:
                raise inner
            except Exception:
                raise outer
        except Exception as exc:
            return exc

    ai_cases = [
        (httpx.ReadTimeout("The read operation timed out"), "the AI provider timed out"),
        (implicit(httpx.ConnectError("[SSL: RECORD_LAYER_FAILURE]"), ssl.SSLError(1, "RECORD_LAYER_FAILURE")),
         "secure connection to the AI provider failed"),
        (httpx.RemoteProtocolError("Server disconnected"), "connection to the AI provider dropped"),
    ]
    for exc, want in ai_cases:
        assert describe_error(exc, "the AI provider") == want, (exc, describe_error(exc, "the AI provider"))
    print("PASS: AI provider (httpx) failures read as plain sentences")

    def fetch(symbol):
        if symbol in ("ETH", "SOL"):
            raise RuntimeError(f"{symbol}: price service timed out")
        return []

    with tempfile.TemporaryDirectory() as d:
        bot = ap.Autopilot(d, fetch)
        bot.start(100_000, "careful")
        bot.run_cycle()
        s = bot.status()
        assert s["problems"] == [{"coins": ["ETH", "SOL"], "reason": "price service timed out"}], s["problems"]
        assert "ETH: ETH" not in s["last_error"] and s["last_error"] == "ETH, SOL: price service timed out", s["last_error"]
    print("PASS: autopilot groups failed coins by reason without doubling the symbol")
    print("\n3 checks passed.")


if __name__ == "__main__":
    main()
