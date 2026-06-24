"""§4/§5 — POST /api/package (.py | .exe) + GET /api/artifacts/{id}/download.

Stages the source (from a saved project or inline files) into a build dir, runs the
chosen packager, and exposes the artifact for download. Not credit-metered (local build).
"""
import os
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import packager
from ..config import settings
from ..models import PackageRequest, PackageResult
from ..projects import _safe_join
from ..services import project_store

router = APIRouter(tags=["package"])

SUPPORTED = ("py", "exe")


def _stage_source(src_dir: str, payload: PackageRequest) -> None:
    if payload.project:
        info = project_store.get(payload.project)
        if not info:
            raise HTTPException(status_code=404, detail=f"Project '{payload.project}' not found.")
        for rel in info["files"]:
            content = project_store.read_file(payload.project, rel)
            dest = _safe_join(src_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(content or "")
    elif payload.files:
        for rel, content in payload.files.items():
            dest = _safe_join(src_dir, rel)
            if dest is None:
                raise HTTPException(status_code=400, detail=f"unsafe file path: {rel}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(str(content or ""))
    else:
        raise HTTPException(status_code=400, detail="Provide `project` or `files` to package.")


@router.post("/package", response_model=PackageResult)
def package_endpoint(payload: PackageRequest) -> PackageResult:
    target = (payload.target or "").lower()
    if target not in SUPPORTED:
        raise HTTPException(status_code=400,
                            detail=f"Unsupported target '{payload.target}'. Supported now: py, exe (apk/pt later).")

    artifact_id = uuid.uuid4().hex[:12]
    adir = os.path.join(settings.data_dir, "artifacts", artifact_id)
    src = os.path.join(adir, "src")
    os.makedirs(src, exist_ok=True)
    _stage_source(src, payload)

    if not os.path.exists(os.path.join(src, payload.entry)):
        raise HTTPException(status_code=400, detail=f"entry '{payload.entry}' not found in the source.")

    name = packager.slug_name(payload.name or payload.project or os.path.splitext(payload.entry)[0])
    try:
        if target == "py":
            res = packager.package_py(src, payload.entry, adir, name)
        else:
            res = packager.package_exe(settings.data_dir, src, payload.entry, adir, name, payload.timeout_seconds)
    except packager.PackageError as exc:
        return PackageResult(ok=False, target=target, error=str(exc))

    if res["ok"]:
        packager.record_artifact(adir, res["path"], res["artifact"], target)
        res["artifact_id"] = artifact_id
        res["download_path"] = f"/api/artifacts/{artifact_id}/download"

    return PackageResult(
        ok=res["ok"], target=target, artifact=res.get("artifact"),
        artifact_id=res.get("artifact_id"), download_path=res.get("download_path"),
        build_log=res.get("build_log", ""), error=res.get("error"),
    )


@router.get("/artifacts/{artifact_id}/download")
def download_artifact(artifact_id: str):
    info = packager.load_artifact(settings.data_dir, artifact_id)
    if not info:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    return FileResponse(info["path"], filename=info["filename"], media_type="application/octet-stream")
