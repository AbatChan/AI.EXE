"""FastAPI dependency that meters a request (rate limit + credit charge).

Attach to any credit-consuming endpoint:

    @router.post("/generate")
    def generate(payload: ..., usage: dict = Depends(meter)):
        ...

It raises 429 (rate) / 402 (credits) with clear messages — satisfying §8's
"show clear errors when rate limit or credit limit is reached".
"""
from fastapi import HTTPException

from .services import usage_manager
from .usage import CreditExhausted, RateLimited


def meter() -> dict:
    try:
        return usage_manager.consume()
    except RateLimited as exc:
        retry_after = int(exc.retry_after) + 1
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit reached ({usage_manager.rate_max} requests / "
                f"{usage_manager.rate_window}s). Retry in ~{retry_after}s."
            ),
            headers={"Retry-After": str(retry_after)},
        )
    except CreditExhausted:
        raise HTTPException(
            status_code=402,
            detail=(
                f"Monthly credit limit reached ({usage_manager.credit_limit}). "
                "Usage resets next billing period."
            ),
        )
