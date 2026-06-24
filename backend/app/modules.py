"""§6/§7 — workshop module store. Uploaded software (.exe/.dll/.py/.wasm/.zip/.js/.bin
or a zipped folder) lands under `<workshop>/modules/<id>/`, gets a manifest, and can be
"connected" (a registration handshake) to the AI.EXE core. Statuses track the §6 pipeline:
pending -> connecting -> connected -> live -> error.
"""
import io
import json
import os
import re
import shutil
import time
import uuid
import zipfile
from typing import List, Optional

SUPPORTED_EXT = {".exe", ".dll", ".py", ".wasm", ".zip", ".js", ".bin"}
STATUSES = ("pending", "connecting", "connected", "live", "error")
MANIFEST = "manifest.json"


def detect_type(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return ext.lstrip(".") if ext in SUPPORTED_EXT else "file"


def _safe_extract(zf: zipfile.ZipFile, dest: str) -> None:
    base = os.path.normpath(dest)
    for member in zf.namelist():
        target = os.path.normpath(os.path.join(dest, member))
        if target != base and not target.startswith(base + os.sep):
            raise ValueError(f"unsafe path in zip: {member}")
    zf.extractall(dest)


class ModuleStore:
    def __init__(self, base_dir: str):
        self.base = base_dir

    def _safe_id(self, mid: str) -> str:
        return re.sub(r"[^A-Za-z0-9]", "", str(mid or ""))

    def _dir(self, mid: str) -> str:
        return os.path.join(self.base, self._safe_id(mid))

    def _manifest_path(self, mid: str) -> str:
        return os.path.join(self._dir(mid), MANIFEST)

    def _load(self, mid: str) -> Optional[dict]:
        try:
            with open(self._manifest_path(mid), encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _save(self, mid: str, m: dict) -> None:
        with open(self._manifest_path(mid), "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2)

    def _files(self, mid: str) -> List[str]:
        d = self._dir(mid)
        out = []
        for root, _dirs, names in os.walk(d):
            for n in names:
                if n == MANIFEST:
                    continue
                out.append(os.path.relpath(os.path.join(root, n), d).replace("\\", "/"))
        return sorted(out)

    def create(self, name: str, filename: str, content: bytes) -> dict:
        if not filename:
            raise ValueError("filename required")
        ext = os.path.splitext(filename)[1].lower()
        mid = uuid.uuid4().hex[:12]
        mdir = self._dir(mid)
        os.makedirs(mdir, exist_ok=True)
        if ext == ".zip":
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                _safe_extract(zf, mdir)
        else:
            with open(os.path.join(mdir, os.path.basename(filename)), "wb") as fh:
                fh.write(content)
        files = self._files(mid)
        entry = next((f for f in files if re.search(r"(?:^|/)main\.(py|exe|js)$", f, re.I)),
                     files[0] if files else None)
        m = {
            "id": mid,
            "name": name or os.path.splitext(os.path.basename(filename))[0],
            "type": detect_type(filename),
            "status": "pending",
            "files": files,
            "entry": entry,
            "uploaded_at": time.time(),
            "connected_at": None,
            "registration_token": None,
        }
        self._save(mid, m)
        return m

    def list(self) -> List[dict]:
        if not os.path.isdir(self.base):
            return []
        out = []
        for mid in sorted(os.listdir(self.base)):
            m = self._load(mid)
            if m:
                out.append({"id": m["id"], "name": m["name"], "type": m["type"],
                            "status": m["status"], "file_count": len(self._files(mid))})
        return out

    def get(self, mid: str) -> Optional[dict]:
        m = self._load(mid)
        if not m:
            return None
        m["files"] = self._files(mid)
        return m

    def connect(self, mid: str) -> Optional[dict]:
        m = self._load(mid)
        if not m:
            return None
        files = self._files(mid)
        if not files:
            m["status"] = "error"
        else:
            m["status"] = "connected"
            m["connected_at"] = time.time()
            m["registration_token"] = uuid.uuid4().hex
        self._save(mid, m)
        m["files"] = files
        return m

    def set_status(self, mid: str, status: str) -> Optional[dict]:
        if status not in STATUSES:
            raise ValueError(f"invalid status '{status}'")
        m = self._load(mid)
        if not m:
            return None
        m["status"] = status
        self._save(mid, m)
        m["files"] = self._files(mid)
        return m

    def delete(self, mid: str) -> bool:
        d = self._dir(mid)
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
            return True
        return False
