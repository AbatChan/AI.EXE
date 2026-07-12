"""Bootstrap the backend uses to launch the Venice Pro adapter.

Adds a parent-death watchdog — the adapter self-exits (and takes its Chrome /
chromedriver down with it) as soon as the backend that spawned it dies, so an app
crash / force-quit can't leave an orphaned adapter running. Then runs the real
adapter script as __main__. Cross-platform, stdlib only.

Usage:  python adapter_boot.py <adapter_script> <port> <headless_flag>
        headless_flag: "1" headless, "0" visible.
"""
import os
import runpy
import subprocess
import sys
import threading
import time
import traceback


def _terminate_group() -> None:
    # POSIX: we're a session leader (spawned with start_new_session) — SIGTERM the
    # whole group so Chrome/chromedriver children die too. Windows does NOT cascade
    # child termination, so taskkill the adapter's process tree explicitly.
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(os.getpid()), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=8, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        return
    try:
        import signal
        os.killpg(os.getpgid(0), signal.SIGTERM)
    except OSError:
        pass


def _watch_parent_and_exit() -> None:
    parent = os.getppid()
    if os.name == "nt":
        _watch_parent_windows(parent)
    else:
        _watch_parent_posix(parent)


def _watch_parent_posix(parent: int) -> None:
    def loop():
        while True:
            time.sleep(2)
            gone = False
            try:
                os.kill(parent, 0)            # signal 0 = harmless existence probe (POSIX only)
            except OSError:
                gone = True
            if not gone and os.getppid() != parent:  # reparented (backend died)
                gone = True
            if gone:
                _terminate_group()
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


def _watch_parent_windows(parent: int) -> None:
    # NEVER os.kill(pid, 0) here: on Windows any non-CTRL signal maps to
    # TerminateProcess, and OpenProcess(PROCESS_ALL_ACCESS) on the backend gets
    # access-denied -> OSError -> the adapter used to os._exit ~2s after launch,
    # before it ever opened Chrome. Wait on a SYNCHRONIZE handle instead.
    import ctypes
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent)
    if not handle:
        return  # can't observe the backend — keep running rather than suicide

    def loop():
        kernel32.WaitForSingleObject(handle, INFINITE)  # blocks until the backend exits
        _terminate_group()
        os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("adapter_boot: need <script> <port> <headless_flag>")
    script, port, headless = sys.argv[1], sys.argv[2], sys.argv[3]
    _watch_parent_and_exit()
    # Rebuild argv exactly as the adapter's argparse expects.
    sys.argv = [script, "--port", str(port), "--ensure-pro",
                "--headless" if headless == "1" else "--no-headless"]
    print("AIEXE_ADAPTER_BOOT loading %s" % script, flush=True)
    try:
        runpy.run_path(script, run_name="__main__")
    except BaseException:
        # taskkill includes this Python process. Emit and flush the real failure first;
        # older builds killed themselves here before the traceback reached adapter.log.
        traceback.print_exc()
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        time.sleep(0.15)
        _terminate_group()
        raise
    else:
        _terminate_group()


if __name__ == "__main__":
    main()
