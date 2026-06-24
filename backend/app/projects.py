"""§2 — file output manager: persist generated files to named project folders under
`.data/projects/<slug>/`, with a manifest, listing, single-file read, and zip download.
Path-traversal safe on both save and read.
"""
import io
import json
import os
import re
import shutil
import time
import zipfile
from typing import Dict, List, Optional

MANIFEST = ".aiexe_project.json"


def slugify(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "").strip()).strip("-._")
    return s[:64]


def _safe_join(base: str, rel: str) -> Optional[str]:
    rel = str(rel or "").replace("\\", "/").lstrip("/")
    dest = os.path.normpath(os.path.join(base, rel))
    base_n = os.path.normpath(base)
    if dest != base_n and not dest.startswith(base_n + os.sep):
        return None
    return dest


class ProjectStore:
    def __init__(self, base_dir: str):
        self.base = base_dir

    def _dir(self, slug: str) -> str:
        return os.path.join(self.base, slug)

    def _manifest_path(self, slug: str) -> str:
        return os.path.join(self._dir(slug), MANIFEST)

    def _load_manifest(self, slug: str) -> Optional[dict]:
        try:
            with open(self._manifest_path(slug), encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _list_files(self, slug: str) -> List[str]:
        pdir = self._dir(slug)
        out = []
        for root, _dirs, names in os.walk(pdir):
            for n in names:
                if n == MANIFEST:
                    continue
                rel = os.path.relpath(os.path.join(root, n), pdir).replace("\\", "/")
                out.append(rel)
        return sorted(out)

    def exists(self, name: str) -> bool:
        return os.path.isdir(self._dir(slugify(name)))

    def save(self, name: str, files: Dict[str, str], meta: dict = None) -> dict:
        slug = slugify(name)
        if not slug:
            raise ValueError("invalid project name")
        pdir = self._dir(slug)
        os.makedirs(pdir, exist_ok=True)
        written = []
        for rel, content in (files or {}).items():
            dest = _safe_join(pdir, rel)
            if dest is None:
                raise ValueError(f"unsafe file path: {rel}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(str(content or ""))
            written.append(rel.replace("\\", "/").lstrip("/"))
        manifest = self._load_manifest(slug) or {"name": slug, "created_at": time.time()}
        manifest["name"] = slug
        manifest["updated_at"] = time.time()
        if meta:
            manifest["meta"] = {**(manifest.get("meta") or {}), **meta}
        with open(self._manifest_path(slug), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)
        return self.get(slug)

    def get(self, name: str) -> Optional[dict]:
        slug = slugify(name)
        if not self.exists(slug):
            return None
        manifest = self._load_manifest(slug) or {"name": slug}
        files = self._list_files(slug)
        return {
            "name": slug,
            "file_count": len(files),
            "created_at": manifest.get("created_at"),
            "updated_at": manifest.get("updated_at"),
            "files": files,
            "meta": manifest.get("meta") or {},
            "dir": self._dir(slug),
        }

    def list(self) -> List[dict]:
        if not os.path.isdir(self.base):
            return []
        out = []
        for name in sorted(os.listdir(self.base)):
            if os.path.isdir(os.path.join(self.base, name)):
                info = self.get(name)
                if info:
                    out.append({"name": info["name"], "file_count": info["file_count"],
                                "updated_at": info["updated_at"]})
        return out

    def read_file(self, name: str, relpath: str) -> Optional[str]:
        dest = _safe_join(self._dir(slugify(name)), relpath)
        if dest is None or not os.path.isfile(dest):
            return None
        with open(dest, encoding="utf-8", errors="replace") as fh:
            return fh.read()

    def delete(self, name: str) -> bool:
        pdir = self._dir(slugify(name))
        if os.path.isdir(pdir):
            shutil.rmtree(pdir, ignore_errors=True)
            return True
        return False

    def zip_bytes(self, name: str) -> Optional[bytes]:
        slug = slugify(name)
        pdir = self._dir(slug)
        if not os.path.isdir(pdir):
            return None
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in self._list_files(slug):
                zf.write(os.path.join(pdir, rel), arcname=rel)
        return buf.getvalue()
