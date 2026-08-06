"""Paper-mode broker endpoints.

Nothing here reaches a live venue. Order submission only STAGES an order;
/confirm is the single path to a fill and it requires the token handed back at
submission time.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..broker import ConfirmationRequired, LiveTradingBlocked, OrderRejected
from ..services import paper_broker

router = APIRouter(tags=["broker"])


class OrderCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=24)
    side: str = Field(min_length=3, max_length=4)
    quantity: int = Field(gt=0)
    price_cents: int = Field(gt=0)
    strategy: str = Field(default="manual", max_length=80)
    memo: str = Field(default="", max_length=500)


class OrderConfirm(BaseModel):
    confirmation_token: str = Field(min_length=1, max_length=64)
    confirmed_by: str = Field(default="operator", max_length=80)


class OrderCancel(BaseModel):
    reason: str = Field(default="cancelled by operator", max_length=200)


class MarkRequest(BaseModel):
    marks: dict = Field(default_factory=dict)


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
    marks = {str(k).upper(): int(v) for k, v in (payload.marks or {}).items()}
    return paper_broker.mark_to_market(marks)


@router.get("/broker/performance")
def broker_performance():
    return paper_broker.performance()


@router.get("/broker/ledger/verify")
def broker_verify_ledger():
    return paper_broker.verify_ledger()


@router.get("/broker/audit")
def broker_audit(limit: int = Query(default=50, ge=1, le=200)):
    return {"events": paper_broker.audit_log(limit=limit)}
