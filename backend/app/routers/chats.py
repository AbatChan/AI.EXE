"""Durable chat endpoints. Local-only (see the origin guard in main.py)."""
from typing import Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException

from ..services import chat_store

router = APIRouter(tags=["chats"])


def _scope(value: Optional[str]) -> str:
    scope = str(value or "").strip().lower()
    if not scope:
        raise HTTPException(status_code=400, detail="user scope is required")
    return scope


@router.get("/chats/{scope}")
def list_chats(scope: str) -> Dict:
    return {"scope": _scope(scope), "chats": chat_store.list_chats(_scope(scope))}


@router.put("/chats/{scope}")
def save_chats(scope: str, payload: Dict = Body(...)) -> Dict:
    chats = payload.get("chats")
    if not isinstance(chats, list):
        raise HTTPException(status_code=400, detail="chats must be a list")
    written = chat_store.upsert_many(_scope(scope), chats)
    return {"saved": written, "total": chat_store.count(_scope(scope))}


@router.post("/chats/{scope}/import")
def import_chats(scope: str, payload: Dict = Body(...)) -> Dict:
    chats = payload.get("chats")
    if not isinstance(chats, list):
        raise HTTPException(status_code=400, detail="chats must be a list")
    return chat_store.import_chats(_scope(scope), chats, reason=str(payload.get("reason") or "import"))


@router.delete("/chats/{scope}/{chat_id}")
def delete_chat(scope: str, chat_id: str) -> Dict:
    """Explicit user deletion. Storage never deletes on its own to reclaim space."""
    removed = chat_store.delete_chat(_scope(scope), chat_id)
    if not removed:
        raise HTTPException(status_code=404, detail="chat not found")
    return {"deleted": chat_id, "total": chat_store.count(_scope(scope))}


@router.get("/chats-stats")
def stats() -> Dict:
    return chat_store.stats()
