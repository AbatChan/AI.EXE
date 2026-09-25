"""POST /api/npm/vet — registry check for packages the agent's code imports."""
from fastapi import APIRouter
from pydantic import BaseModel

from ..npm_vet import vetter

router = APIRouter(tags=["npm"])


class NpmVetRequest(BaseModel):
    names: list[str] = []


@router.post("/npm/vet")
def npm_vet(payload: NpmVetRequest) -> dict:
    return {"results": vetter.vet(payload.names)}
