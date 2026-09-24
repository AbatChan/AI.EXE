"""Paper-mode broker endpoints.

Nothing here reaches a live venue. Order submission only STAGES an order;
/confirm is the single path to a fill and it requires the token handed back at
submission time.
"""
import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import websockets
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .. import access_token, live_data
from ..broker import ConfirmationRequired, LiveTradingBlocked, OrderRejected
from ..ai_portfolio import DEFAULT_SYMBOLS, build_episodes, research_messages, score_research
from ..config import settings
from ..llm import LLMClient, LLMError
from ..prices import QuoteUnavailable, crypto_id
from ..provider import is_local_provider
from ..services import (api_key_store, autopilot, autopilot_ai_store, paper_broker, paper_test_runner, provider_store,
                        quote_feed, usage_manager)
from ..strategy import analyze_history
from ..usage import CreditExhausted, RateLimited

router = APIRouter(tags=["broker"])
BYBIT_SPOT_STREAM = "wss://stream.bybit.com/v5/public/spot"


class OrderCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=24)
    side: str = Field(min_length=3, max_length=4)
    quantity: int = Field(gt=0)
    price_cents: int = Field(gt=0)
    strategy: str = Field(default="manual", max_length=80)
    memo: str = Field(default="", max_length=500)
    origin: str = Field(default="manual", max_length=40)
    instruction: str = Field(default="", max_length=2000)
    quote_source: str = Field(default="manual", max_length=80)
    quote_fetched_at: str = Field(default="", max_length=60)
    quote_stale: bool = False


class OrderConfirm(BaseModel):
    confirmation_token: str = Field(min_length=1, max_length=64)
    confirmed_by: str = Field(default="operator", max_length=80)


class OrderCancel(BaseModel):
    reason: str = Field(default="cancelled by operator", max_length=200)


class MarkRequest(BaseModel):
    marks: dict = Field(default_factory=dict)
    use_live: bool = False


class StrategyStageRequest(BaseModel):
    symbol: str = Field(default="AAPL", min_length=1, max_length=24)


class PaperTestStartRequest(BaseModel):
    symbol: str = Field(default="AAPL", min_length=1, max_length=24)


class AutopilotStart(BaseModel):
    budget_cents: int = Field(ge=10_000, le=100_000_000)
    risk: str = Field(default="careful", max_length=20)


class AutopilotStop(BaseModel):
    close_positions: bool = False


class AIResearchRequest(BaseModel):
    symbols: list[str] = Field(default_factory=lambda: list(DEFAULT_SYMBOLS), min_length=2, max_length=8)
    episodes: int = Field(default=6, ge=3, le=8)


@router.get("/broker/account")
def broker_account():
    return paper_broker.account()


@router.get("/broker/orders")
def broker_orders(status: str = Query(default=None), limit: int = Query(default=50, ge=1, le=200)):
    return {"orders": paper_broker.orders(status=status, limit=limit)}


@router.post("/broker/orders")
def broker_submit_order(payload: OrderCreate):
    try:
        return paper_broker.submit_order(
            symbol=payload.symbol, side=payload.side, quantity=payload.quantity,
            price_cents=payload.price_cents, strategy=payload.strategy, memo=payload.memo,
            origin=payload.origin, instruction=payload.instruction,
            quote_source=payload.quote_source, quote_fetched_at=payload.quote_fetched_at,
            quote_stale=payload.quote_stale,
        )
    except LiveTradingBlocked as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except OrderRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/orders/{order_id}/confirm")
def broker_confirm_order(order_id: str, payload: OrderConfirm):
    try:
        return paper_broker.confirm_order(
            order_id, payload.confirmation_token, confirmed_by=payload.confirmed_by
        )
    except ConfirmationRequired as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except OrderRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/orders/{order_id}/cancel")
def broker_cancel_order(order_id: str, payload: OrderCancel):
    try:
        return paper_broker.cancel_order(order_id, reason=payload.reason)
    except OrderRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/broker/positions")
def broker_positions():
    return {"positions": paper_broker.positions()}


@router.post("/broker/mark")
def broker_mark(payload: MarkRequest):
    """Live prices are fetched HERE and handed to the broker — the broker never
    reaches the network itself."""
    marks = {str(k).upper(): int(v) for k, v in (payload.marks or {}).items()}
    errors = {}
    sources: dict = {}
    if payload.use_live:
        held = [p["symbol"] for p in paper_broker.positions()]
        wanted = [s for s in held if s not in marks]
        if wanted:
            fetched = quote_feed.quotes(wanted)
            marks.update({s: q["price_cents"] for s, q in fetched["quotes"].items()})
            errors = fetched["errors"]
            # A snapshot is a record: it must say which prices were actually live.
            sources = {s: {"source": q.get("source") or "", "as_of": q.get("as_of") or q.get("fetched_at") or "",
                           "stale": bool(q.get("stale"))}
                       for s, q in fetched["quotes"].items()}
    snapshot = paper_broker.mark_to_market(marks, sources)
    snapshot["quote_errors"] = errors
    return snapshot


@router.get("/prices/quote")
def price_quote(symbols: str = Query(min_length=1, max_length=200),
                fresh: bool = Query(default=False)):
    """fresh=1 refuses a cached price — anything that becomes an order price
    must be a real quote, not the last one we happen to remember."""
    wanted = [s.strip().upper() for s in symbols.split(",") if s.strip()][:12]
    if not wanted:
        raise HTTPException(status_code=400, detail="at least one symbol is required")
    result = quote_feed.quotes(wanted, allow_stale=not fresh)
    if fresh:
        for symbol, quote in list(result["quotes"].items()):
            if quote.get("stale"):
                result["errors"][symbol] = "only a cached price is available — type the price manually"
                result["quotes"].pop(symbol)
    return result


@router.get("/prices/search")
def price_search(q: str = Query(default="", max_length=80),
                 limit: int = Query(default=10, ge=1, le=12)):
    return {"results": quote_feed.search(q, limit=limit)}


def _portfolio_for_quote(quote: dict) -> dict:
    positions = paper_broker.positions()
    account = paper_broker.account()
    symbol = quote["symbol"]
    marks = {symbol: int(quote["price_cents"])}
    errors = {}
    others = [p["symbol"] for p in positions if p["symbol"] not in marks]
    if others:
        fetched = quote_feed.quotes(others)
        marks.update({key: int(value["price_cents"])
                      for key, value in fetched["quotes"].items()})
        errors = fetched["errors"]
    holdings = 0
    unrealized = 0
    selected = None
    for position in positions:
        price = marks.get(position["symbol"], int(position["avg_cost_cents"]))
        quantity = int(position["quantity"])
        value = price * quantity
        pnl = (price - int(position["avg_cost_cents"])) * quantity
        holdings += value
        unrealized += pnl
        if position["symbol"] == symbol:
            selected = {**position, "live_price_cents": price,
                        "market_value_cents": value, "unrealized_pnl_cents": pnl}
    return {
        "starting_cash_cents": int(account["starting_cash_cents"]),
        "cash_cents": int(account["cash_cents"]),
        "holdings_cents": holdings,
        "equity_cents": int(account["cash_cents"]) + holdings,
        "unrealized_pnl_cents": unrealized,
        "realized_pnl_cents": int(account["realized_pnl_cents"]),
        "selected_position": selected,
        "quote_errors": errors,
    }


def _merge_equity(intraday: dict, spot: dict) -> dict:
    intraday.update({
        "price_cents": int(spot.get("price_cents", intraday.get("price_cents") or 0)),
        "market_status": spot.get("market_status") or intraday.get("market_status"),
        "is_realtime": bool(spot.get("is_realtime", intraday.get("is_realtime"))),
        "as_of": spot.get("as_of") or intraday.get("as_of"),
        "net_change_cents": int(spot.get("net_change_cents") if spot.get("net_change_cents") is not None
                                 else (intraday.get("net_change_cents") or 0)),
        "percentage_change_bps": int(spot.get("percentage_change_bps")
                                     if spot.get("percentage_change_bps") is not None
                                     else (intraday.get("percentage_change_bps") or 0)),
        "delta": spot.get("delta") or intraday.get("delta"),
        "stale": bool(spot.get("stale") or intraday.get("stale") or not spot),
        "stream_type": "equity_bridge",
    })
    return {"quote": intraday, "portfolio": _portfolio_for_quote(intraday),
            "display_only": True}


def _equity_live_payload(symbol: str) -> dict:
    """Chart and spot price are two upstream calls — run them side by side so a
    symbol switch costs one round trip, not two."""
    normalized = (symbol or "").strip().upper()
    with ThreadPoolExecutor(max_workers=2) as pool:
        chart = pool.submit(quote_feed.intraday, normalized)
        price = pool.submit(quote_feed.quote, normalized)
        intraday = chart.result()
        try:
            spot = price.result()
        except QuoteUnavailable:
            spot = {}
    return _merge_equity(intraday, spot)


def _cached_equity_payload(symbol: str):
    """Whatever we already know, sent before the network is touched."""
    intraday = quote_feed.cached_intraday(symbol)
    if not intraday:
        return None
    return _merge_equity(intraday, {})


@router.get("/broker/live")
def broker_live(symbol: str = Query(default="AAPL", min_length=1, max_length=24)):
    """Compatibility snapshot; the UI uses /live-stream."""
    try:
        return _equity_live_payload(symbol)
    except QuoteUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _crypto_base(symbol: str) -> str:
    value = (symbol or "").strip().upper()
    for suffix in ("-USD", "/USD", "USD"):
        if value.endswith(suffix) and len(value) > len(suffix):
            return value[:-len(suffix)]
    return value


def _stream_origin_allowed(origin: str, presented: str = "") -> bool:
    allowed = {item.strip() for item in settings.allowed_origins if item.strip()}
    token = access_token.load_or_create(settings.data_dir)
    return access_token.origin_allowed(origin, presented, token, allowed)


async def _stream_bybit(websocket: WebSocket, symbol: str) -> None:
    base = _crypto_base(symbol)
    pair = f"{base}USDT"
    try:
        points = await asyncio.to_thread(quote_feed.crypto_intraday_points, symbol)
    except QuoteUnavailable:
        points = []
    # Draw the seed chart now rather than sitting blank until the first tick.
    if points:
        seed_price = points[-1]["price_mills"] / 1000
        first = points[0]["price_mills"] / 1000
        seed = {
            "symbol": symbol, "company": f"{base}/USDT spot", "source": "bybit_kline",
            "market_status": "OPEN", "is_realtime": False,
            "as_of": datetime.fromtimestamp(points[-1]["ts_ms"] / 1000, timezone.utc).isoformat(),
            "price_cents": int(round(seed_price * 100)),
            "previous_close_cents": int(round(first * 100)),
            "net_change_cents": int(round((seed_price - first) * 100)),
            "percentage_change_bps": int(round((seed_price - first) / first * 10000)) if first else 0,
            "delta": "up" if seed_price >= first else "down",
            "volume": "", "points": list(points),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "stale": True, "stream_type": "exchange_websocket",
        }
        portfolio = await asyncio.to_thread(_portfolio_for_quote, seed)
        await websocket.send_json({"quote": seed, "portfolio": portfolio, "display_only": True})
    last_sent = 0.0
    async with websockets.connect(BYBIT_SPOT_STREAM, ping_interval=20, ping_timeout=12,
                                  close_timeout=2) as upstream:
        await upstream.send(json.dumps({"op": "subscribe", "args": [f"tickers.{pair}"]}))
        async for raw in upstream:
            message = json.loads(raw)
            if message.get("topic") != f"tickers.{pair}":
                continue
            data = message.get("data") or {}
            if isinstance(data, list):
                data = data[0] if data else {}
            if not data.get("lastPrice"):
                continue
            now = time.monotonic()
            price = float(data["lastPrice"])
            timestamp = int(message.get("ts") or time.time() * 1000)
            points.append({"ts_ms": timestamp, "price_mills": int(round(price * 1000))})
            points = points[-720:]
            if now - last_sent < 0.10:
                continue
            last_sent = now
            previous = float(data.get("prevPrice24h") or price)
            change_fraction = float(data.get("price24hPcnt") or 0)
            quote = {
                "symbol": symbol,
                "company": f"{base}/USDT spot",
                "source": "bybit_websocket",
                "market_status": "OPEN",
                "is_realtime": True,
                "as_of": datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat(),
                "price_cents": int(round(price * 100)),
                "previous_close_cents": int(round(previous * 100)),
                "net_change_cents": int(round((price - previous) * 100)),
                "percentage_change_bps": int(round(change_fraction * 10000)),
                "delta": "up" if price >= previous else "down",
                "volume": str(data.get("volume24h") or ""),
                "points": points,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "stale": False,
                "stream_type": "exchange_websocket",
            }
            portfolio = await asyncio.to_thread(_portfolio_for_quote, quote)
            await websocket.send_json({"quote": quote, "portfolio": portfolio,
                                       "display_only": True})


async def _stream_equity(websocket: WebSocket, symbol: str) -> None:
    previous = None
    warm = await asyncio.to_thread(_cached_equity_payload, symbol)
    if warm:
        await websocket.send_json(warm)
    while True:
        payload = await asyncio.to_thread(_equity_live_payload, symbol)
        fingerprint = json.dumps(payload.get("quote", {}), sort_keys=True)
        if fingerprint != previous:
            await websocket.send_json(payload)
            previous = fingerprint
        await asyncio.sleep(2)


@router.get("/prices/crypto-chart")
def price_crypto_chart(symbol: str = Query(min_length=1, max_length=24),
                       range: str = Query(default="1D", max_length=4)):
    try:
        return quote_feed.crypto_chart(symbol, range)
    except QuoteUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/prices/stock-chart")
def price_stock_chart(symbol: str = Query(min_length=1, max_length=12),
                      range: str = Query(default="1D", max_length=4)):
    try:
        return quote_feed.stock_chart(symbol, range)
    except QuoteUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/fx")
def fx_rate(base: str = Query(min_length=3, max_length=3), quote: str = Query(min_length=3, max_length=3),
            range: str = Query(default="1M", max_length=3)):
    try:
        return live_data.fx(base, quote, range)
    except QuoteUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/weather")
def weather_now(place: str = Query(min_length=1, max_length=80), units: str = Query(default="metric", max_length=8)):
    try:
        return live_data.weather(place, units)
    except QuoteUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.websocket("/broker/ticker-stream")
async def broker_ticker_stream(websocket: WebSocket, symbol: str = "BTC"):
    """Light live price for chat cards: any Bybit USDT pair, at most 4 updates/s."""
    protocol = access_token.from_subprotocols(websocket.headers.get("sec-websocket-protocol") or "")
    if not _stream_origin_allowed(websocket.headers.get("origin") or "",
                                  protocol[len(access_token.SUBPROTOCOL_PREFIX):]):
        await websocket.close(code=1008)
        return
    await websocket.accept(subprotocol=protocol or None)
    base = "".join(ch for ch in _crypto_base(symbol) if ch.isalnum())[:20]
    pair = f"{base}USDT"
    try:
        async with websockets.connect(BYBIT_SPOT_STREAM, ping_interval=20, ping_timeout=12,
                                      close_timeout=2) as upstream:
            await upstream.send(json.dumps({"op": "subscribe", "args": [f"tickers.{pair}"]}))
            last_sent = 0.0
            async for raw in upstream:
                message = json.loads(raw)
                if message.get("topic") != f"tickers.{pair}":
                    continue
                data = message.get("data") or {}
                if isinstance(data, list):
                    data = data[0] if data else {}
                if not data.get("lastPrice") or time.monotonic() - last_sent < 0.25:
                    continue
                last_sent = time.monotonic()
                await websocket.send_json({
                    "symbol": base, "ts": int(message.get("ts") or time.time() * 1000),
                    "price": float(data["lastPrice"]),
                    "open_24h": float(data.get("prevPrice24h") or 0) or None,
                    "high_24h": float(data.get("highPrice24h") or 0) or None,
                    "low_24h": float(data.get("lowPrice24h") or 0) or None,
                    "volume_24h_usd": float(data.get("turnover24h") or 0) or None,
                })
    except (WebSocketDisconnect, websockets.exceptions.WebSocketException, OSError):
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass


@router.websocket("/broker/live-stream")
async def broker_live_stream(websocket: WebSocket, symbol: str = "AAPL"):
    """Push-only local stream. Crypto is exchange WebSocket; equities use the
    approved Nasdaq source until a licensed equity WebSocket is configured."""
    protocol = access_token.from_subprotocols(websocket.headers.get("sec-websocket-protocol") or "")
    if not _stream_origin_allowed(websocket.headers.get("origin") or "",
                                  protocol[len(access_token.SUBPROTOCOL_PREFIX):]):
        await websocket.close(code=1008)
        return
    await websocket.accept(subprotocol=protocol or None)
    symbol = (symbol or "AAPL").strip().upper()[:24]
    try:
        if crypto_id(symbol):
            await _stream_bybit(websocket, symbol)
        else:
            await _stream_equity(websocket, symbol)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        try:
            await websocket.send_json({"error": str(exc)})
            await websocket.close(code=1011)
        except Exception:
            pass


@router.get("/broker/performance")
def broker_performance():
    return paper_broker.performance()


@router.get("/broker/strategy-lab")
def broker_strategy_lab(symbol: str = Query(default="AAPL", min_length=1, max_length=24)):
    try:
        history = quote_feed.history(symbol)
        report = analyze_history(history["rows"])
        report.update({"symbol": history["symbol"], "source": history["source"],
                       "fetched_at": history["fetched_at"]})
        return report
    except (QuoteUnavailable, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/ai-research")
def broker_ai_research(payload: AIResearchRequest):
    """Blinded model benchmark. It has no broker or order path."""
    symbols = []
    for value in payload.symbols:
        symbol = str(value or "").strip().upper()[:24]
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    if len(symbols) < 2:
        raise HTTPException(status_code=400, detail="Choose at least two unique symbols.")
    base_url, model = provider_store.resolve()
    if not base_url:
        raise HTTPException(status_code=400, detail="Configure a DeepSeek or local provider first.")
    local = is_local_provider(base_url)
    api_key = api_key_store.get_for_internal_use() or ("local" if local else None)
    if not api_key:
        raise HTTPException(status_code=400, detail="Set the provider API key first.")
    try:
        histories = {symbol: quote_feed.history(symbol)["rows"] for symbol in symbols}
        episodes = build_episodes(histories, count=payload.episodes)
        if not local:
            usage_manager.consume()
        result = LLMClient(base_url, model, api_key, kind=provider_store.kind(), timeout=180).complete_json(
            research_messages(episodes), max_tokens=4096)
        scored = score_research(episodes, result["data"])
        scored.update({"provider": {"kind": provider_store.kind(), "model": model,
                                     "local": local, "latency_ms": result["latency_ms"],
                                     "attempts": result["attempts"], "usage": result["usage"],
                                     "system_fingerprint": result["system_fingerprint"]},
                       "universe": symbols, "modeled_round_trip_cost_bps": 10,
                       "disclaimer": "Blinded historical research only. No order was created or staged."})
        return scored
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail=f"Rate limit reached. Retry in ~{int(exc.retry_after) + 1}s.")
    except CreditExhausted:
        raise HTTPException(status_code=402, detail="Monthly credit limit reached.")
    except (QuoteUnavailable, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMError as exc:
        status = exc.status if exc.status in (401, 402, 403) else 502
        raise HTTPException(status_code=status, detail=str(exc))


@router.post("/broker/strategy-lab/stage")
def broker_strategy_stage(payload: StrategyStageRequest):
    try:
        history = quote_feed.history(payload.symbol)
        report = analyze_history(history["rows"])
        quote = quote_feed.quote(history["symbol"], allow_stale=False)
        held = next((int(p["quantity"]) for p in paper_broker.positions()
                     if p["symbol"] == history["symbol"]), 0)
        target = report["recommendation"]
        if target == "long" and held == 0:
            allocation = min(paper_broker.account()["cash_cents"],
                             max(0, paper_broker.current_equity_cents() // 4))
            quantity = allocation // int(quote["price_cents"])
            if quantity <= 0:
                return {"status": "no_action", "reason": "25% allocation cannot buy one whole unit",
                        "report": report}
            side = "buy"
        elif target == "cash" and held > 0:
            side, quantity = "sell", held
        else:
            return {"status": "no_action", "reason": f"portfolio already matches {target} signal",
                    "report": report}
        selected = report["selected"]
        order = paper_broker.submit_order(
            history["symbol"], side, quantity, int(quote["price_cents"]),
            strategy=selected["name"], origin="strategy_lab",
            memo=(f"Out-of-sample return {selected['test']['total_return_bps'] / 100:.2f}%; "
                  f"drawdown {selected['test']['max_drawdown_bps'] / 100:.2f}%"),
            instruction=f"Paper proposal: move portfolio to {target}; operator must confirm.",
            quote_source=quote["source"], quote_fetched_at=quote.get("fetched_at", ""),
            quote_stale=bool(quote.get("stale")),
        )
        return {"status": "staged", "order": order, "report": report}
    except (QuoteUnavailable, ValueError, OrderRejected) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/broker/paper-test")
def broker_paper_test_status():
    return paper_test_runner.status()


@router.post("/broker/paper-test/start")
def broker_paper_test_start(payload: PaperTestStartRequest):
    try:
        return paper_test_runner.start(payload.symbol)
    except (QuoteUnavailable, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/paper-test/run")
def broker_paper_test_run():
    try:
        result = paper_test_runner.run_once()
        return {"result": result, **paper_test_runner.status()}
    except (QuoteUnavailable, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/paper-test/stop")
def broker_paper_test_stop():
    return paper_test_runner.stop()


@router.get("/broker/paper-test/report")
def broker_paper_test_report():
    return paper_test_runner.report()


@router.get("/broker/autopilot")
def broker_autopilot_status():
    return autopilot.status()


@router.post("/broker/autopilot/start")
def broker_autopilot_start(payload: AutopilotStart):
    try:
        status = autopilot.start(payload.budget_cents, payload.risk)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    executor = ThreadPoolExecutor(max_workers=1)
    executor.submit(autopilot.run_cycle)  # first scan now, not in a minute
    executor.shutdown(wait=False)
    return status


@router.post("/broker/autopilot/stop")
def broker_autopilot_stop(payload: AutopilotStop):
    return autopilot.stop(close_positions=payload.close_positions)


@router.post("/broker/autopilot/clear-activity")
def broker_autopilot_clear_activity():
    return autopilot.clear_activity()


@router.get("/broker/autopilot/coin")
def broker_autopilot_coin(symbol: str = Query(min_length=1, max_length=24)):
    try:
        return autopilot.coin_check(symbol)
    except (ValueError, QuoteUnavailable) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class AutopilotWatch(BaseModel):
    symbol: str = Field(min_length=1, max_length=24)
    watch: bool = True


@router.post("/broker/autopilot/watch")
def broker_autopilot_watch(payload: AutopilotWatch):
    try:
        return autopilot.watch(payload.symbol, payload.watch)
    except (ValueError, QuoteUnavailable) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class AutopilotCoin(BaseModel):
    symbol: str = Field(min_length=1, max_length=24)


class AutopilotRisk(BaseModel):
    risk: str = Field(max_length=20)


@router.post("/broker/autopilot/buy")
def broker_autopilot_buy(payload: AutopilotCoin):
    try:
        return autopilot.buy_now(payload.symbol)
    except (ValueError, QuoteUnavailable) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/autopilot/sell")
def broker_autopilot_sell(payload: AutopilotCoin):
    try:
        return autopilot.sell_now(payload.symbol)
    except (ValueError, QuoteUnavailable) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/broker/autopilot/risk")
def broker_autopilot_risk(payload: AutopilotRisk):
    try:
        return autopilot.set_risk(payload.risk)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class AutopilotAI(BaseModel):
    base_url: str = Field(min_length=8, max_length=300)
    model: str = Field(min_length=1, max_length=120)
    api_key: str = Field(default="", max_length=500)
    label: str = Field(default="", max_length=60)


@router.get("/broker/autopilot/ai")
def broker_autopilot_ai():
    """Which AI reviews autopilot entries. Never returns the key."""
    own = autopilot_ai_store.get()
    chat_base, chat_model = provider_store.resolve()
    return {"custom": bool(own), "base_url": own.get("base_url") or chat_base, "model": own.get("model") or chat_model,
            "label": own.get("label") or "", "chat_model": chat_model}


@router.post("/broker/autopilot/ai")
def broker_autopilot_ai_set(payload: AutopilotAI):
    try:
        autopilot_ai_store.set(payload.base_url, payload.model, payload.api_key, payload.label)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return broker_autopilot_ai()


@router.delete("/broker/autopilot/ai")
def broker_autopilot_ai_clear():
    autopilot_ai_store.clear()  # back to following the chat model
    return broker_autopilot_ai()


@router.post("/broker/autopilot/reset")
def broker_autopilot_reset():
    try:
        return autopilot.reset()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/broker/ledger/verify")
def broker_verify_ledger():
    return paper_broker.verify_ledger()


@router.get("/broker/audit")
def broker_audit(limit: int = Query(default=50, ge=1, le=200)):
    return {"events": paper_broker.audit_log(limit=limit)}
