"""§2 — project/output folder endpoints (save, list, read, download, delete)."""
import io

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..models import (FileContentResponse, ProjectInfo, ProjectListResponse,
                      ProjectSaveRequest)
from ..projects import slugify
from ..services import project_store

router = APIRouter(tags=["projects"])


@router.post("/projects", response_model=ProjectInfo)
def save_project(payload: ProjectSaveRequest) -> ProjectInfo:
    if not payload.files:
        raise HTTPException(status_code=400, detail="No files to save.")
    try:
        info = project_store.save(payload.name, payload.files)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ProjectInfo(**info)


@router.get("/projects", response_model=ProjectListResponse)
def list_projects() -> ProjectListResponse:
    return ProjectListResponse(projects=project_store.list())


@router.get("/projects/{name}", response_model=ProjectInfo)
def get_project(name: str) -> ProjectInfo:
    info = project_store.get(name)
    if not info:
        raise HTTPException(status_code=404, detail="Project not found.")
    return ProjectInfo(**info)


@router.get("/projects/{name}/file", response_model=FileContentResponse)
def get_project_file(name: str, path: str = Query(..., description="relative file path")) -> FileContentResponse:
    content = project_store.read_file(name, path)
    if content is None:
        raise HTTPException(status_code=404, detail="File not found.")
    return FileContentResponse(path=path, content=content)


@router.get("/projects/{name}/download")
def download_project(name: str):
    data = project_store.zip_bytes(name)
    if data is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return StreamingResponse(
        io.BytesIO(data), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{slugify(name)}.zip"'},
    )


@router.delete("/projects/{name}")
def delete_project(name: str):
    if not project_store.delete(name):
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"deleted": True, "name": slugify(name)}
