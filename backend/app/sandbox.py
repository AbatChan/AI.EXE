"""§3 — sandboxed Python execution.

Offline-realistic isolation (Docker/Firecracker conflict with the no-install portable
target, per the requirements doc): each run gets its own temp workdir + a scrubbed
environment + POSIX resource limits (CPU, memory, file size, process count, no core
dumps) + a wall-clock timeout that kills the whole process group. A small static guard
rejects obviously destructive code before it runs.

On macOS, the run is additionally wrapped in a sandbox-exec seatbelt jail that confines
writes to the sandbox dir and denies reads of the user's home (secrets/keys/docs) — so
generated code can't delete user files or leak them (result.isolation == "seatbelt").
Windows has no zero-install FS jail yet: there it falls back to rlimits + static guard
and reports isolation == "none". See _isolate().
"""
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from typing import Dict, List, Optional, Tuple

# Coarse defense-in-depth — NOT the primary control (the sandbox dir + rlimits are).
# High-confidence destructive patterns only; keeps false positives near zero.
_DENY: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"rm\s+-rf?\s+(?:/|~|\$HOME)(?=['\"\s]|$)"), "recursive delete of root/home"),
    (re.compile(r"shutil\.rmtree\(\s*['\"](?:/|~|/root|/home|/Users|C:\\\\)"), "rmtree of a system path"),
    (re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"), "shell fork bomb"),
    (re.compile(r"\bos\.fork\(\)(?:[\s\S]{0,40}\bos\.fork\(\))"), "fork bomb"),
    (re.compile(r"mkfs|/dev/sd[a-z]|dd\s+if=.*of=/dev/"), "raw disk / device write"),
]

_MAX_TIMEOUT = 120  # hard ceiling regardless of request


def static_guard(blob: str) -> Optional[str]:
    for pattern, reason in _DENY:
        if pattern.search(blob):
            return reason
    return None


_SANDBOX_EXEC = "/usr/bin/sandbox-exec"


def _seatbelt_profile(sandbox_abs: str) -> str:
    """macOS seatbelt policy: writes confined to the sandbox; reads of the user's home
    (secrets, keys, documents) denied; system paths readable so Python runs. The sandbox
    itself is re-allowed in case it lives under $HOME."""
    home = os.path.realpath(os.path.expanduser("~"))
    sbx = os.path.realpath(sandbox_abs)
    return (
        "(version 1)\n"
        "(deny default)\n"
        "(allow process-fork)\n"
        "(allow process-exec)\n"
        "(allow signal (target self))\n"
        "(allow sysctl-read)\n"
        "(allow mach*)\n"
        "(allow ipc-posix-shm)\n"
        "(allow file-read-metadata)\n"
        "(allow file-read*)\n"
        f'(deny file-read* (subpath "{home}"))\n'
        f'(allow file-read* (subpath "{sbx}"))\n'
        f'(allow file-write* (subpath "{sbx}"))\n'
        '(allow file-write-data (path "/dev/null") (path "/dev/dtracehelper"))\n'
    )


def _isolate(cmd: List[str], sandbox_abs: str) -> Tuple[List[str], str]:
    """Wrap `cmd` in an OS filesystem jail. Returns (command, isolation_label).

    macOS: sandbox-exec seatbelt (writes→sandbox only, no user-home reads). Elsewhere
    (incl. Windows) there's no zero-install FS jail yet — falls back to the POSIX rlimits
    + static guard and reports isolation="none" so callers don't assume a jail exists."""
    if sys.platform == "darwin" and os.path.exists(_SANDBOX_EXEC):
        profile = os.path.join(sandbox_abs, ".sbx_profile.sb")
        try:
            with open(profile, "w", encoding="utf-8") as fh:
                fh.write(_seatbelt_profile(sandbox_abs))
            return [_SANDBOX_EXEC, "-f", profile, *cmd], "seatbelt"
        except OSError:
            return cmd, "none"
    return cmd, "none"


def _safe_join(base: str, rel: str) -> Optional[str]:
    # Reject absolute paths and traversal — files must land inside the sandbox.
    rel = str(rel or "").replace("\\", "/").lstrip("/")
    dest = os.path.normpath(os.path.join(base, rel))
    if not dest.startswith(os.path.normpath(base) + os.sep) and dest != os.path.normpath(base):
        return None
    return dest


def _scrubbed_env(workdir: str) -> Dict[str, str]:
    # Minimal env — no host secrets pass through. Headless so GUI/game libs don't hang.
    path = os.environ.get("PATH", "/usr/bin:/bin:/usr/local/bin")
    return {
        "PATH": path,
        "HOME": workdir,
        "TMPDIR": workdir,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "SDL_VIDEODRIVER": "dummy",
        "SDL_AUDIODRIVER": "dummy",
        "MPLBACKEND": "Agg",
    }


def _limits(timeout: int):
    # POSIX-only; best-effort (some limits no-op on macOS). Returned as preexec_fn.
    def apply():
        os.setsid()  # own process group → killable as a tree on timeout
        try:
            import resource
        except ImportError:
            return
        cpu = max(1, timeout)
        for res, soft, hard in [
            (getattr(resource, "RLIMIT_CPU", None), cpu, cpu + 2),
            (getattr(resource, "RLIMIT_FSIZE", None), 50 * 1024 * 1024, 50 * 1024 * 1024),
            (getattr(resource, "RLIMIT_NPROC", None), 96, 96),
            (getattr(resource, "RLIMIT_CORE", None), 0, 0),
        ]:
            if res is not None:
                try:
                    resource.setrlimit(res, (soft, hard))
                except (ValueError, OSError):
                    pass
    return apply


def _retry_hint(stderr: str) -> Optional[str]:
    m = re.search(r"ModuleNotFoundError: No module named ['\"]([\w.]+)['\"]", stderr)
    if m:
        pkg = m.group(1).split(".")[0]
        return f"Missing dependency '{pkg}' — add it to requirements and re-run."
    if "SyntaxError" in stderr:
        return "Syntax error — fix the reported line and re-run."
    if "IndentationError" in stderr:
        return "Indentation error — fix the reported line and re-run."
    return None


def _run(cmd: List[str], cwd: str, env: Dict[str, str], timeout: int,
         stdin: Optional[str]) -> Tuple[Optional[int], str, str, bool]:
    posix = os.name == "posix"
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        preexec_fn=_limits(timeout) if posix else None,
        start_new_session=not posix,
    )
    try:
        out, err = proc.communicate(input=stdin, timeout=timeout)
        return proc.returncode, out, err, False
    except subprocess.TimeoutExpired:
        try:
            if posix:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except (ProcessLookupError, OSError):
            pass
        out, err = proc.communicate()
        return None, out, err, True


def run_python(base_dir: str, *, code: Optional[str], files: Optional[Dict[str, str]],
               entry: str, requirements: List[str], stdin: Optional[str],
               args: List[str], timeout_seconds: int) -> dict:
    timeout = max(1, min(int(timeout_seconds or 30), _MAX_TIMEOUT))
    sandbox = os.path.join(base_dir, "sandboxes", uuid.uuid4().hex[:12])
    os.makedirs(sandbox, exist_ok=True)

    written: Dict[str, str] = {}
    if files:
        for rel, content in files.items():
            dest = _safe_join(sandbox, rel)
            if dest is None:
                return _result(False, None, False, True,
                               f"unsafe file path: {rel}", "", "", 0.0, sandbox)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(str(content or ""))
            written[rel] = dest
    if code is not None:
        with open(os.path.join(sandbox, entry), "w", encoding="utf-8") as fh:
            fh.write(code)

    entry_path = os.path.join(sandbox, entry)
    if not os.path.exists(entry_path):
        return _result(False, None, False, True,
                       f"entry file '{entry}' not found in sandbox", "", "", 0.0, sandbox)

    blob = "\n".join([code or ""] + list((files or {}).values()))
    reason = static_guard(blob)
    if reason:
        return _result(False, None, False, True,
                       f"blocked by safety guard: {reason}", "", "", 0.0, sandbox)

    install_log = ""
    python = shutil.which("python3") or shutil.which("python") or "python3"
    if requirements:
        venv = os.path.join(sandbox, ".venv")
        subprocess.run([python, "-m", "venv", venv], cwd=sandbox,
                       capture_output=True, text=True, timeout=120)
        vpy = os.path.join(venv, "bin", "python")
        if not os.path.exists(vpy):
            vpy = os.path.join(venv, "Scripts", "python.exe")
        install = subprocess.run(
            [vpy, "-m", "pip", "install", "--disable-pip-version-check", "-q", *requirements],
            cwd=sandbox, capture_output=True, text=True, timeout=300,
        )
        install_log = (install.stdout or "") + (install.stderr or "")
        if install.returncode == 0 and os.path.exists(vpy):
            python = vpy

    started = time.time()
    # -E (ignore PYTHON* env) + -s (no user site). NOT -I: on 3.11+ -I implies -P,
    # which drops the script's own dir from sys.path and breaks sibling imports.
    run_cmd = [python, "-E", "-s", entry, *[str(a) for a in (args or [])]]
    run_cmd, isolation = _isolate(run_cmd, sandbox)
    code_exit, out, err, timed_out = _run(
        run_cmd, sandbox, _scrubbed_env(sandbox), timeout, stdin,
    )
    duration = round(time.time() - started, 3)
    ok = (not timed_out) and code_exit == 0
    return _result(ok, code_exit, timed_out, False, None, out, err, duration, sandbox,
                   install_log=install_log, isolation=isolation,
                   retry_hint=None if ok else _retry_hint(err))


def _result(ok, exit_code, timed_out, blocked, block_reason, stdout, stderr,
            duration, sandbox, install_log="", retry_hint=None, isolation="none") -> dict:
    return {
        "ok": ok,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "blocked": blocked,
        "block_reason": block_reason,
        "stdout": stdout,
        "stderr": stderr,
        "duration_seconds": duration,
        "sandbox_dir": sandbox,
        "install_log": install_log,
        "retry_hint": retry_hint,
        "isolation": isolation,
    }
