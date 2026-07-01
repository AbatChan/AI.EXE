"""§6/§7 — workshop module endpoints (upload, list, get, connect, delete).

EXE Connect pipeline: workshop running -> upload -> land in workshop folder ->
connect to AI.EXE core -> module active.
"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..models import ModuleInfo, ModuleListResponse
from ..modules import SUPPORTED_EXT
from ..services import module_store

router = APIRouter(tags=["modules"])


@router.post("/modules/upload", response_model=ModuleInfo)
async def upload_module(file: UploadFile = File(...), name: str = Form(None)) -> ModuleInfo:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty upload.")
    import os
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext and ext not in SUPPORTED_EXT:
        raise HTTPException(status_code=400,
                            detail=f"Unsupported type '{ext}'. Allowed: {', '.join(sorted(SUPPORTED_EXT))} (or a zipped folder).")
    try:
        module = module_store.create(name, file.filename, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ModuleInfo(**module)


@router.get("/modules", response_model=ModuleListResponse)
def list_modules() -> ModuleListResponse:
    return ModuleListResponse(modules=module_store.list())


@router.get("/modules/{module_id}", response_model=ModuleInfo)
def get_module(module_id: str) -> ModuleInfo:
    module = module_store.get(module_id)
    if not module:
        raise HTTPException(status_code=404, detail="Module not found.")
    return ModuleInfo(**module)


@router.post("/modules/{module_id}/connect", response_model=ModuleInfo)
def connect_module(module_id: str) -> ModuleInfo:
    module = module_store.connect(module_id)
    if not module:
        raise HTTPException(status_code=404, detail="Module not found.")
    return ModuleInfo(**module)


@router.delete("/modules/{module_id}")
def delete_module(module_id: str):
    if not module_store.delete(module_id):
        raise HTTPException(status_code=404, detail="Module not found.")
    return {"deleted": True, "id": module_id}
