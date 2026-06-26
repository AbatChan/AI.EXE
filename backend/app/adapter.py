"""Manage the Venice Pro browser adapter (jooray/ollama-like-venice) process.

install (git clone + venv + pip) · start (spawn with the Venice login in env) · stop ·
status. Credentials are passed per start() and NOT persisted server-side — the desktop
keeps them locally and sends them when starting.
"""
import os
import re
import signal
import subprocess
import sys
import threading

ADAPTER_REPO = "https://github.com/jooray/ollama-like-venice.git"

# Venice changed their sign-in since the (abandoned) adapter was written: the email field is
# now id="identifier-field", password id="password-field", submit is "Continue", and both are
# on ONE form. Cloudflare also blocks headless, so we run visible + persist a Chrome profile
# (login/verification code only needed once). This rewrites the adapter's login on install.
_PATCHED_LOGIN = '''def login_to_venice_with_username(username, password):
    global driver, args
    print("Logging in to venice with username and password...")
    driver = get_webdriver(headless=args.headless, debug_browser=args.debug_browser, docker=args.docker)
    driver.get("https://venice.ai/sign-in")
    wait = WebDriverWait(driver, selenium_timeout)
    email_field = wait.until(EC.visibility_of_element_located((By.ID, "identifier-field")))
    email_field.clear(); email_field.send_keys(username)
    password_input = wait.until(EC.visibility_of_element_located((By.ID, "password-field")))
    password_input.clear(); password_input.send_keys(password)
    button = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@type='submit' or contains(., 'Continue') or contains(., 'Sign in')]")))
    button.click()
    ensure_logged_in(driver)
    print(f"Logged in as {username}")
    return driver

'''


class AdapterManager:
    def __init__(self, data_dir: str, repo: str = ADAPTER_REPO):
        self._dir = os.path.join(data_dir, ".tools", "venice-adapter")
        self._repo = repo
        self._proc = None
        self._port = 9999
        self._lock = threading.Lock()
        self._log = os.path.join(data_dir, "adapter.log")

    def read_log(self, tail: int = 4000) -> str:
        try:
            with open(self._log, "rb") as fh:
                return fh.read()[-tail:].decode("utf-8", "replace")
        except OSError:
            return ""

    @property
    def install_dir(self) -> str:
        return self._dir

    def _venv_python(self) -> str:
        sub = "Scripts" if os.name == "nt" else "bin"
        exe = "python.exe" if os.name == "nt" else "python"
        return os.path.join(self._dir, ".venv", sub, exe)

    def _server_script(self) -> str:
        return os.path.join(self._dir, "ollama_like_server.py")

    def is_installed(self) -> bool:
        return os.path.exists(self._server_script())

    def _patch_adapter(self) -> None:
        """Apply our compatibility patch to the cloned adapter (new Venice selectors +
        persistent profile + non-headless-friendly). Idempotent."""
        p = self._server_script()
        try:
            with open(p, encoding="utf-8") as fh:
                src = fh.read()
        except OSError:
            return
        out = re.sub(r"def login_to_venice_with_username\(username, password\):.*?\n(?=def )",
                     _PATCHED_LOGIN, src, count=1, flags=re.S)
        profile = ('    chrome_options = webdriver.ChromeOptions()\n'
                   '    chrome_options.add_argument("--user-data-dir=" + os.path.join('
                   'os.path.dirname(os.path.abspath(__file__)), ".chrome-profile"))\n'
                   '    try:\n'
                   '        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])\n'
                   '        chrome_options.add_argument("--disable-blink-features=AutomationControlled")\n'
                   '    except Exception:\n        pass\n')
        if '.chrome-profile' not in out:
            out = out.replace('    chrome_options = webdriver.ChromeOptions()\n', profile, 1)
        if out != src:
            try:
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(out)
            except OSError:
                pass

    def install(self, timeout: int = 600) -> dict:
        """git clone + venv + pip install -r requirements.txt. Returns {ok, detail}."""
        try:
            if not os.path.isdir(self._dir):
                os.makedirs(os.path.dirname(self._dir), exist_ok=True)
                r = subprocess.run(["git", "clone", "--depth", "1", self._repo, self._dir],
                                   capture_output=True, text=True, timeout=timeout)
                if r.returncode != 0:
                    return {"ok": False, "detail": f"git clone failed: {r.stderr[-300:]}"}
            if not self.is_installed():
                return {"ok": False, "detail": "clone done but ollama_like_server.py not found"}
            venv_py = self._venv_python()
            if not os.path.exists(venv_py):
                r = subprocess.run([sys.executable, "-m", "venv", os.path.join(self._dir, ".venv")],
                                   capture_output=True, text=True, timeout=120)
                if r.returncode != 0:
                    return {"ok": False, "detail": f"venv failed: {r.stderr[-300:]}"}
            req = os.path.join(self._dir, "requirements.txt")
            if os.path.exists(req):
                r = subprocess.run([venv_py, "-m", "pip", "install", "-r", req],
                                   capture_output=True, text=True, timeout=timeout)
                if r.returncode != 0:
                    return {"ok": False, "detail": f"pip install failed: {r.stderr[-300:]}"}
            self._patch_adapter()  # adapt to Venice's current sign-in
            return {"ok": True, "detail": "installed"}
        except FileNotFoundError as exc:
            return {"ok": False, "detail": f"missing tool (git/python?): {exc}"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "detail": "install timed out"}

    def running(self) -> bool:
        return bool(self._proc and self._proc.poll() is None)

    def start(self, username: str, password: str, port: int = 9999, headless: bool = True,
              python_exe: str = "", script: str = "") -> dict:
        with self._lock:
            if self.running():
                return {"ok": True, "detail": "already running", "pid": self._proc.pid, "port": self._port}
            py = python_exe or self._venv_python()
            srv = script or self._server_script()
            if not os.path.exists(srv):
                return {"ok": False, "detail": "adapter not installed — install first", "port": port}
            env = dict(os.environ)
            if username:
                env["VENICE_USERNAME"] = str(username)
            if password:
                env["VENICE_PASSWORD"] = str(password)
            args = [py, srv, "--port", str(port), "--ensure-pro"]
            if headless:
                args.append("--headless")
            try:
                logf = open(self._log, "wb", buffering=0)  # capture why it lives/dies
                self._proc = subprocess.Popen(
                    args, cwd=os.path.dirname(srv) or None, env=env,
                    stdout=logf, stderr=subprocess.STDOUT,
                    start_new_session=(os.name != "nt"))
                logf.close()
            except (OSError, ValueError) as exc:
                self._proc = None
                return {"ok": False, "detail": f"could not start: {exc}", "port": port}
            self._port = port
            return {"ok": True, "detail": "started", "pid": self._proc.pid, "port": port}

    def stop(self) -> dict:
        with self._lock:
            if not self.running():
                self._proc = None
                return {"ok": True, "detail": "not running", "port": self._port}
            try:
                if os.name == "nt":
                    self._proc.terminate()
                else:
                    os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
                try:
                    self._proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            self._proc = None
            return {"ok": True, "detail": "stopped", "port": self._port}

    def status(self) -> dict:
        return {"installed": self.is_installed(), "running": self.running(),
                "pid": self._proc.pid if self.running() else None,
                "port": self._port, "install_dir": self._dir}
