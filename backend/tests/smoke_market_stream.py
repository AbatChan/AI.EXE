"""Market-stream route stays push-based and paper-only."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers import broker


def run():
    assert broker._crypto_base("BTC-USD") == "BTC"
    assert broker._crypto_base("ETHUSD") == "ETH"
    routes = {getattr(route, "path", ""): route for route in broker.router.routes}
    assert "/broker/live-stream" in routes
    assert routes["/broker/live-stream"].name == "broker_live_stream"
    assert broker.BYBIT_SPOT_STREAM.startswith("wss://")
    assert "*" not in broker.settings.allowed_origins
    assert broker._stream_origin_allowed("file://")
    assert broker._stream_origin_allowed("null")
    assert not broker._stream_origin_allowed("https://malicious.example")
    print("market stream smoke test: ok")


if __name__ == "__main__":
    run()
