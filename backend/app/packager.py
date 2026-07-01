"""§4/§5 — packagers. Item 7: .py source bundle. Item 8: native executable via
PyInstaller (.exe on Windows, a unix/Mach-O binary on macOS/Linux).

PyInstaller can only target the OS it runs on (no cross-compile) — the real Windows
.exe is produced when the backend runs on Windows, matching the existing dev-on-mac /
CI-builds-Windows split. PyInstaller is installed lazily into a cached tools venv on
first use so it isn't a hard dependency of the backend.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from typing import List, Optional

ARTIFACT_MANIFEST = "artifact.json"


class PackageError(Exception):
    pass


def slug_name(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "").strip()).strip("-._")
    return (s or "app")[:64]


def _walk(root: str) -> List[str]:
    out = []
    for base, _dirs, names in os.walk(root):
        for n in names:
            out.append(os.path.relpath(os.path.join(base, n), root).replace("\\", "/"))
    return sorted(out)


def _tools_python(data_dir: str):
    venv = os.path.join(data_dir, ".tools")
    py = os.path.join(venv, "bin", "python")
    if not os.path.exists(py):
        py = os.path.join(venv, "Scripts", "python.exe")
    return venv, py


def ensure_pyinstaller(data_dir: str, timeout: int = 600) -> str:
    venv, py = _tools_python(data_dir)
    if not os.path.exists(py):
        subprocess.run([sys.executable, "-m", "venv", venv],
                       capture_output=True, text=True, timeout=120)
        venv, py = _tools_python(data_dir)
    if not os.path.exists(py):
        raise PackageError("could not create the packaging venv")
    if subprocess.run([py, "-c", "import PyInstaller"], capture_output=True).returncode != 0:
        inst = subprocess.run(
            [py, "-m", "pip", "install", "--disable-pip-version-check", "-q", "pyinstaller"],
            capture_output=True, text=True, timeout=timeout,
        )
        if inst.returncode != 0:
            raise PackageError("PyInstaller install failed (offline?): " + (inst.stderr or "")[:300])
    return py


def package_py(src: str, entry: str, out_dir: str, name: str) -> dict:
    """Item 7 — deliver the source: a single .py if that's all there is, else a zip."""
    py_files = [f for f in _walk(src) if f.endswith(".py")]
    if py_files == [entry]:
        dest = os.path.join(out_dir, name if name.endswith(".py") else name + ".py")
        shutil.copyfile(os.path.join(src, entry), dest)
    else:
        dest = os.path.join(out_dir, name + ".zip")
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in _walk(src):
                zf.write(os.path.join(src, rel), arcname=rel)
    return {"ok": True, "artifact": os.path.basename(dest), "path": dest, "build_log": "", "error": None}


def package_exe(data_dir: str, src: str, entry: str, out_dir: str, name: str,
                timeout: int = 300) -> dict:
    """Item 8 — native one-file executable via PyInstaller (OS-native)."""
    py = ensure_pyinstaller(data_dir)
    dist = os.path.join(out_dir, "dist")
    cmd = [py, "-m", "PyInstaller", "--onefile", "--noconfirm", "--clean", "--name", name,
           "--distpath", dist, "--workpath", os.path.join(out_dir, "build"),
           "--specpath", os.path.join(out_dir, "spec"), entry]
    proc = subprocess.run(cmd, cwd=src, capture_output=True, text=True, timeout=timeout)
    log = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    binary = next((c for c in (os.path.join(dist, name), os.path.join(dist, name + ".exe"))
                   if os.path.exists(c)), None)
    if proc.returncode != 0 or not binary:
        return {"ok": False, "artifact": None, "path": None,
                "build_log": log[-4000:], "error": "PyInstaller build failed"}
    return {"ok": True, "artifact": os.path.basename(binary), "path": binary,
            "build_log": log[-2000:], "error": None}


def record_artifact(artifact_dir: str, path: str, filename: str, target: str) -> None:
    with open(os.path.join(artifact_dir, ARTIFACT_MANIFEST), "w", encoding="utf-8") as fh:
        json.dump({"path": path, "filename": filename, "target": target}, fh)


def load_artifact(data_dir: str, artifact_id: str) -> Optional[dict]:
    aid = re.sub(r"[^A-Za-z0-9]", "", str(artifact_id or ""))  # no traversal
    manifest = os.path.join(data_dir, "artifacts", aid, ARTIFACT_MANIFEST)
    try:
        with open(manifest, encoding="utf-8") as fh:
            info = json.load(fh)
    except (OSError, ValueError):
        return None
    return info if info.get("path") and os.path.exists(info["path"]) else None
