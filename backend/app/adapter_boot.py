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
import sys
import threading
import time


def _terminate_group() -> None:
    # POSIX: we're a session leader (spawned with start_new_session) — SIGTERM the
    # whole group so Chrome/chromedriver children die too. Windows: best-effort;
    # exiting usually cascades to the driver-launched browser.
    if os.name == "nt":
        return
    try:
        import signal
        os.killpg(os.getpgid(0), signal.SIGTERM)
    except OSError:
        pass


def _watch_parent_and_exit() -> None:
    parent = os.getppid()

    def loop():
        while True:
            time.sleep(2)
            gone = False
            try:
                os.kill(parent, 0)            # backend still alive?
            except OSError:
                gone = True
            if not gone and os.getppid() != parent:  # reparented (backend died)
                gone = True
            if gone:
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
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
