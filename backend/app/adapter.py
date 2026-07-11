"""Manage the Venice Pro browser adapter (jooray/ollama-like-venice) process.

install (git clone + venv + pip) · start (spawn with the Venice login in env) · stop ·
status. Credentials are passed per start() and NOT persisted server-side — the desktop
keeps them locally and sends them when starting.
"""
import glob
import os
import re
import signal
import subprocess
import sys
import threading
import time

import httpx

ADAPTER_REPO = "https://github.com/jooray/ollama-like-venice.git"

# Venice changed their sign-in since the (abandoned) adapter was written: the email field is
# now id="identifier-field", password id="password-field", submit is "Continue", and both are
# on ONE form. Cloudflare also blocks headless, so we run visible + persist a Chrome profile
# (login/verification code only needed once). This rewrites the adapter's login on install.
_PATCHED_ENSURE = '''def ensure_logged_in(driver):
    import os as _os, time as _t
    # Venice changed the post-login UI; logged-in = we left /sign-in. Wait up to ~3 min so a
    # one-time email verification code (or Cloudflare check) can be done in the visible window.
    for _ in range(180):
        try:
            url = driver.current_url
        except Exception:
            url = ""
        if url and "/sign-in" not in url:
            _t.sleep(2)
            return
        _t.sleep(1)
    try:
        driver.save_screenshot(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "login_stuck.png"))
    except Exception:
        pass
    raise TimeoutException("Still on /sign-in after login - saved login_stuck.png (code prompt? captcha? wrong password?).")

'''
_PATCHED_LOGIN = '''def login_to_venice_with_username(username, password):
    global driver, args
    import time as _t
    print("Logging in to venice with username and password...")
    driver = get_webdriver(headless=args.headless, debug_browser=args.debug_browser, docker=args.docker)
    driver.get("https://venice.ai/sign-in")
    _t.sleep(3)
    _submit = "//button[@type='submit' or contains(., 'Continue') or contains(., 'Sign in') or contains(., 'Log in')]"
    # Already signed in via the saved Chrome profile? Venice redirects off /sign-in.
    try:
        if "/sign-in" not in driver.current_url:
            print("Already logged in (saved session).")
            try:
                driver.minimize_window()
            except Exception:
                pass
            return driver
    except Exception:
        pass
    def _find_visible(cands):
        for by, sel in cands:
            try:
                e = driver.find_element(by, sel)
                if e.is_displayed():
                    return e
            except Exception:
                pass
        return None
    _email_sel = [(By.ID, "identifier-field"), (By.NAME, "identifier"),
                  (By.CSS_SELECTOR, "input[type='email']"),
                  (By.CSS_SELECTOR, "input[autocomplete='username']"),
                  (By.CSS_SELECTOR, "input[name='email']")]
    _pass_sel = [(By.ID, "password-field"), (By.CSS_SELECTOR, "input[type='password']")]
    # Best-effort auto-fill. Venice's sign-in markup changes and Cloudflare can gate it, so
    # NEVER die here — if we can't drive the form, log what's on the page and let the user
    # finish login in the visible window. ensure_logged_in waits for the redirect off /sign-in
    # (a far more stable signal than any field id) either way.
    try:
        email_field = None
        for _ in range(12):
            email_field = _find_visible(_email_sel)
            if email_field or "/sign-in" not in driver.current_url:
                break
            _t.sleep(1)
        if email_field:
            if not (email_field.get_attribute("value") or "").strip():
                email_field.send_keys(username)
            password_input = _find_visible(_pass_sel)
            if not password_input:  # 2-step form: click Continue, then the password appears
                try:
                    (_find_visible([(By.XPATH, _submit)]) or email_field).click()
                except Exception:
                    pass
                for _ in range(8):
                    password_input = _find_visible(_pass_sel)
                    if password_input:
                        break
                    _t.sleep(1)
            if password_input and not (password_input.get_attribute("value") or "").strip():
                password_input.send_keys(password)
            try:
                btn = _find_visible([(By.XPATH, _submit)])
                if btn:
                    btn.click()
            except Exception:
                pass
        else:
            # Couldn't find the email field — dump the sign-in page so the real selectors (or a
            # Cloudflare challenge) are visible in the log, then wait for a manual sign-in.
            try:
                print("AIEXE_DIAG_LOGIN url=%r title=%r" % (driver.current_url, driver.title))
                for _in in driver.find_elements(By.TAG_NAME, "input"):
                    print("AIEXE_DIAG_LOGIN input id=%r name=%r type=%r placeholder=%r" % (
                        _in.get_attribute("id"), _in.get_attribute("name"),
                        _in.get_attribute("type"), _in.get_attribute("placeholder")))
            except Exception:
                pass
            print("Could not auto-fill the login — please sign in manually in the Chrome window.")
    except Exception as _e:
        print("Login auto-fill error (will wait for a manual sign-in): " + str(_e))
    ensure_logged_in(driver)
    try:
        driver.minimize_window()  # out of the way; the adapter keeps using it to serve
    except Exception:
        pass
    print(f"Logged in as {username}")
    return driver

'''


# The cloned adapter's fetch interceptor assumed fetch()'s first arg is always a string and
# called url.includes(...) — which THROWS on the URL/Request objects Venice (and Clerk) pass,
# breaking auth AND the chat request (empty replies). This robust version normalizes the URL,
# reads the method from init or the Request, logs POST URLs, and never lets the override throw.
_PATCHED_INTERCEPTOR = '''def inject_request_interceptor(driver, api_data_json):
    script = f"""
    window.streamComplete = false;
    window.receivedChunks = [];
    window.__aiexe_urls = [];
    (function(original) {{
      const apiData = {api_data_json};
      window.fetch = async function(input, init) {{
        let urlStr = '';
        try {{
          if (typeof input === 'string') urlStr = input;
          else if (input && typeof input.url === 'string') urlStr = input.url;
          else urlStr = String(input);
        }} catch (e) {{ urlStr = ''; }}
        let method = 'GET';
        try {{ method = ((init && init.method) || (input && input.method) || 'GET'); }} catch (e) {{}}
        method = String(method).toUpperCase();
        try {{ if (method === 'POST') {{ window.__aiexe_urls.push(urlStr); }} }} catch (e) {{}}

        if (method === 'POST' && urlStr.indexOf('/api/inference/chat') !== -1) {{
          try {{
          window.fetch = original;
          if (init && init.body) {{
            let body = JSON.parse(init.body);
            if ('requestId' in body) {{ delete apiData.requestId; }}
            Object.assign(body, apiData);
            init.body = JSON.stringify(body);
            try {{ if (init.headers) {{ init.headers['Content-Length'] = new Blob([init.body]).size.toString(); }} }} catch (e) {{}}
          }}
          const response = await original.call(this, input, init);
          const reader = response.body.getReader();
          window.responseStream = new ReadableStream({{
            start(controller) {{
              function push() {{
                reader.read().then(({{ done, value }}) => {{
                  if (done) {{ controller.close(); window.streamComplete = true; return; }}
                  window.receivedChunks.push(value);
                  controller.enqueue(value);
                  push();
                }});
              }}
              push();
            }}
          }});
          return new Response(window.responseStream, {{
            headers: response.headers, status: response.status, statusText: response.statusText
          }});
          }} catch (e) {{ window.fetch = original; return original.apply(this, arguments); }}
        }}
        return original.apply(this, arguments);
      }};
    }})(window.fetch);
    """
    driver.execute_script(script)

'''


class AdapterManager:
    def __init__(self, data_dir: str, repo: str = ADAPTER_REPO, port: int = 9999):
        self._dir = os.path.join(data_dir, ".tools", "venice-adapter")
        self._repo = repo
        self._proc = None
        self._port = port
        self._lock = threading.Lock()
        self._log = os.path.join(data_dir, "adapter.log")

    def read_log(self, tail: int = 4000) -> str:
        try:
            with open(self._log, "rb") as fh:
                return fh.read()[-tail:].decode("utf-8", "replace")
        except OSError:
            return ""

    def _append_log(self, line: str) -> None:
        try:
            with open(self._log, "ab") as fh:
                fh.write((str(line or "").rstrip() + "\n").encode("utf-8", "replace"))
        except OSError:
            pass

    @property
    def install_dir(self) -> str:
        return self._dir

    def _venv_python(self) -> str:
        sub = "Scripts" if os.name == "nt" else "bin"
        exe = "python.exe" if os.name == "nt" else "python"
        return os.path.join(self._dir, ".venv", sub, exe)

    @staticmethod
    def _uses_frozen_backend() -> bool:
        return bool(getattr(sys, "frozen", False))

    def _server_script(self) -> str:
        return os.path.join(self._dir, "ollama_like_server.py")

    def is_installed(self) -> bool:
        return os.path.exists(self._server_script())

    def _canonical_server(self) -> str:
        # Fully-patched server we ship — replaces the fragile string-patch chain when present.
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "venice_adapter_server.py")

    def _patch_adapter(self) -> None:
        """Make the cloned adapter our known-good version. Preferred path: copy the canonical
        fully-patched server over the clone (robust, one file we control). Falls back to the
        legacy in-place string patches if the canonical file is missing. Idempotent."""
        canonical = self._canonical_server()
        p = self._server_script()
        if os.path.exists(canonical):
            try:
                # Copy the config file next to the server so it can `import venice_config`
                # (all the editable Venice selectors/URLs live there).
                cfg_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venice_config.py")
                if os.path.exists(cfg_src):
                    try:
                        with open(cfg_src, encoding="utf-8") as fh:
                            cfg_want = fh.read()
                        cfg_dst = os.path.join(self._dir, "venice_config.py")
                        cfg_have = ""
                        try:
                            with open(cfg_dst, encoding="utf-8") as fh:
                                cfg_have = fh.read()
                        except OSError:
                            pass
                        if cfg_want != cfg_have:
                            with open(cfg_dst, "w", encoding="utf-8") as fh:
                                fh.write(cfg_want)
                    except OSError:
                        pass
                with open(canonical, encoding="utf-8") as fh:
                    want = fh.read()
                try:
                    with open(p, encoding="utf-8") as fh:
                        have = fh.read()
                except OSError:
                    have = ""
                if want != have:
                    with open(p, "w", encoding="utf-8") as fh:
                        fh.write(want)
                return
            except OSError:
                pass  # fall through to legacy string patches
        try:
            with open(p, encoding="utf-8") as fh:
                src = fh.read()
        except OSError:
            return
        out = re.sub(r"def ensure_logged_in\(driver\):.*?\n(?=def )",
                     _PATCHED_ENSURE, src, count=1, flags=re.S)
        out = re.sub(r"def login_to_venice_with_username\(username, password\):.*?\n(?=def )",
                     _PATCHED_LOGIN, out, count=1, flags=re.S)
        # Robust fetch interceptor (handles URL/Request objects; was throwing url.includes).
        out = re.sub(r"def inject_request_interceptor\(driver, api_data_json\):.*?\n    driver\.execute_script\(script\)\n",
                     _PATCHED_INTERCEPTOR, out, count=1, flags=re.S)
        profile = ('    chrome_options = webdriver.ChromeOptions()\n'
                   '    chrome_options.add_argument("--user-data-dir=" + os.path.join('
                   'os.path.dirname(os.path.abspath(__file__)), ".chrome-profile"))\n'
                   '    try:\n'
                   '        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])\n'
                   '        chrome_options.add_argument("--disable-blink-features=AutomationControlled")\n'
                   '    except Exception:\n        pass\n')
        if '.chrome-profile' not in out:
            out = out.replace('    chrome_options = webdriver.ChromeOptions()\n', profile, 1)
        # Close Chrome when the adapter is stopped (SIGTERM from Stop / provider-switch /
        # app-close) so no browser window is left behind and the profile lock is released.
        if '_aiexe_close_browser' not in out:
            cleanup = (
                'import atexit as _aiexe_atexit, signal as _aiexe_signal\n'
                'def _aiexe_close_browser(*_a):\n'
                '    try:\n'
                '        _d = globals().get("driver")\n'
                '        if _d and not isinstance(_d, dict):\n'
                '            _d.quit()\n'
                '    except Exception:\n        pass\n'
                '_aiexe_atexit.register(_aiexe_close_browser)\n'
                'try:\n'
                '    _aiexe_signal.signal(_aiexe_signal.SIGTERM, lambda *_a: (_aiexe_close_browser(), os._exit(0)))\n'
                'except Exception:\n    pass\n'
            )
            out = re.sub(r"(?m)^driver = login_to_venice\(\)$",
                         cleanup + "driver = login_to_venice()", out, count=1)
        # Venice's chat composer no longer uses the placeholder "Ask a question" (placeholders
        # rotate), which is why the chat times out at the input wait. Match ANY editable
        # textarea instead — structural, survives copy changes.
        out = out.replace("//textarea[contains(@placeholder, 'Ask a question')]",
                          "//textarea[not(@readonly)]")
        # Diagnostics: log the real composer placeholders + submit-button candidates on each
        # chat attempt, so stale selectors are visible in the adapter log (AIEXE_DIAG lines).
        if 'AIEXE_DIAG' not in out:
            diag = (
                '        try:\n'
                '            print("AIEXE_DIAG url=" + str(driver.current_url))\n'
                '            for _i, _t in enumerate(driver.find_elements(By.TAG_NAME, "textarea")):\n'
                '                print("AIEXE_DIAG textarea[%d] placeholder=%r displayed=%s" % (_i, _t.get_attribute("placeholder"), _t.is_displayed()))\n'
                '            for _b in driver.find_elements(By.XPATH, "//button[@type=\'submit\' or @aria-label]"):\n'
                '                print("AIEXE_DIAG button aria=%r type=%r text=%r" % (_b.get_attribute("aria-label"), _b.get_attribute("type"), (_b.text or "")[:30]))\n'
                '        except Exception as _e:\n'
                '            print("AIEXE_DIAG error " + str(_e))\n'
            )
            out = out.replace(
                "    api_data_json = json.dumps(api_data)\n    try:\n",
                "    api_data_json = json.dumps(api_data)\n    try:\n" + diag, 1)
        # Submit is stale (@aria-label='submit' no longer matches). Try a few send-button
        # variants, then fall back to pressing Enter in the composer — the most reliable
        # submit, survives markup changes.
        _old_submit = (
            "        inject_request_interceptor(driver, api_data_json)\n\n"
            "        button = WebDriverWait(driver, selenium_timeout).until(\n"
            "            EC.element_to_be_clickable((By.XPATH, \"//button[@type='submit' and @aria-label='submit']\"))\n"
            "        )\n\n"
            "        button.click()\n"
        )
        # Venice's real send button (from live DOM): type=submit, aria-label="Send message",
        # data-testid="minds-chat-send-button" — and it only renders once the composer has text.
        _new_submit = (
            "        inject_request_interceptor(driver, api_data_json)\n\n"
            "        _sent = False  # AIEXE_SUBMIT2\n"
            "        for _try in range(20):  # send button only appears once the composer has text\n"
            "            for _xp in [\"//button[@data-testid='minds-chat-send-button']\", \"//button[@aria-label='Send message']\", \"//button[@type='submit']\"]:\n"
            "                try:\n"
            "                    _b = driver.find_element(By.XPATH, _xp)\n"
            "                    if _b.is_displayed() and _b.is_enabled():\n"
            "                        _b.click(); _sent = True; break\n"
            "                except Exception:\n                    pass\n"
            "            if _sent:\n                break\n"
            "            time.sleep(0.25)\n"
            "        if not _sent:\n"
            "            try:\n"
            "                element.send_keys(Keys.RETURN)\n"
            "            except Exception:\n                pass\n"
        )
        if 'AIEXE_SUBMIT2' not in out:
            out = out.replace(_old_submit, _new_submit, 1)
        # Upgrade the stale send-button selectors if an older patch already ran. Classic mode's
        # send button is aria-label="Submit chat"; agent mode's is data-testid=minds-chat-send-button.
        out = out.replace(
            "for _xp in [\"//button[@type='submit' and @aria-label='submit']\", \"//button[@aria-label='Send']\", \"//button[@aria-label='send']\", \"//button[@type='submit']\"]:",
            "for _xp in [\"//button[@type='submit' and @aria-label='Submit chat']\", \"//button[@data-testid='minds-chat-send-button']\", \"//button[@aria-label='Send message']\", \"//button[@type='submit']\"]:")
        out = out.replace(
            "for _xp in [\"//button[@data-testid='minds-chat-send-button']\", \"//button[@aria-label='Send message']\", \"//button[@type='submit']\"]:",
            "for _xp in [\"//button[@type='submit' and @aria-label='Submit chat']\", \"//button[@data-testid='minds-chat-send-button']\", \"//button[@aria-label='Send message']\", \"//button[@type='submit']\"]:")
        # Force classic text mode — Venice's default /chat now redirects to agent mode, whose
        # response stream the interceptor can't read. Classic mode is the interceptable one.
        out = out.replace(
            "        if not driver.current_url.startswith('https://venice.ai/chat'):\n            driver.get('https://venice.ai/chat')\n",
            "        if 'venice.ai/chat/classic' not in driver.current_url:\n            driver.get('https://venice.ai/chat/classic')\n")
        out = out.replace(
            "            driver.get('https://venice.ai/chat')  # keep the session; no re-login/recursion\n",
            "            driver.get('https://venice.ai/chat/classic')  # keep the session; no re-login/recursion\n")
        # Recovery: the original quits + re-logs-in + recurses on any chat error — that corrupts
        # the logged-in session and can hang for minutes. Fail cleanly instead (session stays;
        # next request re-navigates to /chat).
        _old_recover = (
            "        print(f\"Error occurred during chat: {e}\")\n"
            "        try:\n"
            "            driver.quit()\n"
            "        except WebDriverException as e:\n"
            "            print(f\"Error occurred while quitting WebDriver: {e}\")\n\n"
            "        driver = login_to_venice()\n"
            "        if driver:\n"
            "            yield from generate_selenium_streamed_response(data, driver, response_format)\n"
        )
        _new_recover = (
            "        print(f\"Error occurred during chat: {e}\", flush=True)  # AIEXE_RECOVER\n"
            "        try:\n"
            "            driver.get('https://venice.ai/chat')  # keep the session; no re-login/recursion\n"
            "        except Exception:\n            pass\n"
        )
        if 'AIEXE_RECOVER' not in out:
            out = out.replace(_old_recover, _new_recover, 1)
        if out != src:
            try:
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(out)
            except OSError:
                pass

    def install(self, timeout: int = 600) -> dict:
        """git clone + venv + pip install -r requirements.txt. Returns {ok, detail}."""
        try:
            self._append_log("AIEXE_INSTALL starting")
            if not os.path.isdir(self._dir):
                os.makedirs(os.path.dirname(self._dir), exist_ok=True)
                self._append_log("AIEXE_INSTALL downloading adapter from GitHub")
                r = subprocess.run(["git", "clone", "--depth", "1", self._repo, self._dir],
                                   capture_output=True, text=True, timeout=timeout)
                if r.returncode != 0:
                    self._append_log("AIEXE_INSTALL network_or_git_failed " + (r.stderr[-500:] or r.stdout[-500:]))
                    return {"ok": False, "detail": f"git clone failed: {r.stderr[-300:]}"}
            if not self.is_installed():
                self._append_log("AIEXE_INSTALL clone_missing_server")
                return {"ok": False, "detail": "clone done but ollama_like_server.py not found"}
            if self._uses_frozen_backend():
                # The release backend already carries Selenium and its dependencies.
                self._patch_adapter()
                self._append_log("AIEXE_INSTALL installed")
                return {"ok": True, "detail": "installed"}
            venv_py = self._venv_python()
            if not os.path.exists(venv_py):
                self._append_log("AIEXE_INSTALL creating Python environment")
                r = subprocess.run([sys.executable, "-m", "venv", os.path.join(self._dir, ".venv")],
                                   capture_output=True, text=True, timeout=120)
                if r.returncode != 0:
                    self._append_log("AIEXE_INSTALL venv_failed " + (r.stderr[-500:] or r.stdout[-500:]))
                    return {"ok": False, "detail": f"venv failed: {r.stderr[-300:]}"}
            req = os.path.join(self._dir, "requirements.txt")
            if os.path.exists(req):
                self._append_log("AIEXE_INSTALL installing Python dependencies")
                r = subprocess.run([venv_py, "-m", "pip", "install", "-r", req],
                                   capture_output=True, text=True, timeout=timeout)
                if r.returncode != 0:
                    self._append_log("AIEXE_INSTALL dependency_network_failed " + (r.stderr[-500:] or r.stdout[-500:]))
                    return {"ok": False, "detail": f"pip install failed: {r.stderr[-300:]}"}
            self._patch_adapter()  # adapt to Venice's current sign-in
            self._append_log("AIEXE_INSTALL installed")
            return {"ok": True, "detail": "installed"}
        except FileNotFoundError as exc:
            self._append_log("AIEXE_INSTALL missing_tool " + str(exc))
            return {"ok": False, "detail": f"missing tool (git/python?): {exc}"}
        except subprocess.TimeoutExpired:
            self._append_log("AIEXE_INSTALL timeout")
            return {"ok": False, "detail": "install timed out"}

    def _port_alive(self, port: int = 0) -> bool:
        try:
            return httpx.get(f"http://127.0.0.1:{port or self._port}/api/tags", timeout=2).status_code == 200
        except httpx.HTTPError:
            return False

    def running(self) -> bool:
        # Tracked process alive, OR already serving (survives a backend restart that lost the handle).
        if self._proc and self._proc.poll() is None:
            return True
        return self._port_alive()

    def start(self, username: str, password: str, port: int = 9999, headless: bool = True,
              python_exe: str = "", script: str = "", hide_prompt: bool = False, model: str = "") -> dict:
        with self._lock:
            if self.running():
                return {"ok": True, "detail": "already running",
                        "pid": self._proc.pid if self._proc else None, "port": self._port}
            srv = script or self._server_script()
            if not os.path.exists(srv):
                return {"ok": False, "detail": "adapter not installed — install first", "port": port}
            if not script:
                self._patch_adapter()  # keep an existing install's patches current (idempotent)
            env = dict(os.environ)
            env["PYTHONUNBUFFERED"] = "1"  # so adapter prints (incl. AIEXE_DIAG) hit the log live
            env["AIEXE_HIDE_PROMPT"] = "1" if hide_prompt else "0"
            if str(model or "").strip():
                # Preselect at boot (window still visible) so the first send never needs
                # the minimized-picker fallback that restores a corner window.
                env["AIEXE_PRESELECT_MODEL"] = str(model).strip()
            user = str(username or "").strip()
            passwd = str(password or "")
            profile = os.path.join(self._dir, ".chrome-profile")
            if (not user or not passwd) and os.path.isdir(profile):
                # The adapter exits before opening Chrome unless both env vars exist. When a
                # persistent Chrome profile already has the Venice session, these values are
                # only a startup guard bypass: Venice redirects off /sign-in before autofill.
                user = user or "saved-session@venice.local"
                passwd = passwd or "__AIEXE_SAVED_CHROME_SESSION__"
            if user:
                env["VENICE_USERNAME"] = user
            if passwd:
                env["VENICE_PASSWORD"] = passwd
            # Launch via adapter_boot so the adapter self-exits if this backend dies
            # (no orphaned adapter/Chrome after an app crash or force-quit). The boot
            # wrapper passes --headless/--no-headless through to the adapter's argparse;
            # its --headless DEFAULTS to True, so visible mode needs --no-headless
            # explicitly (Cloudflare blocks headless on Venice's sign-in).
            boot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "adapter_boot.py")
            if self._uses_frozen_backend() and not python_exe:
                args = [sys.executable, "--adapter-boot", srv, str(port), "1" if headless else "0"]
            else:
                py = python_exe or self._venv_python()
                args = [py, boot, srv, str(port), "1" if headless else "0"]
            # A killed adapter leaves webdriver-manager's download lock behind and
            # every later start times out on it; no adapter runs here, so any lock
            # is stale by definition.
            for stale_lock in glob.glob(os.path.expanduser("~/.wdm/.wdm-lock-*")):
                try:
                    os.remove(stale_lock)
                except OSError:
                    pass
            try:
                logf = open(self._log, "wb", buffering=0)  # capture why it lives/dies
                logf.write(("AIEXE_ADAPTER_START launching %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())).encode("utf-8", "replace"))
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
            proc = self._proc
            if proc is None:
                # Serving but we lost the handle (backend restarted). Its own
                # parent-watch retires it within ~2s now that the old backend is gone.
                self._proc = None
                return {"ok": True, "detail": "released (adapter self-exits via parent-watch)",
                        "port": self._port}
            try:
                if os.name == "nt":
                    proc.terminate()
                else:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            self._proc = None
            return {"ok": True, "detail": "stopped", "port": self._port}

    def status(self) -> dict:
        proc_alive = bool(self._proc and self._proc.poll() is None)
        serving = self._port_alive()  # port bound = login done + server up (ready)
        log = self.read_log(6000)
        lower = log.lower()
        network_issue = bool(re.search(
            r"(network|internet|connection (?:reset|refused|timed out|timeout)|temporary failure|name or service not known|"
            r"nodename nor servname|could not resolve|dns|ssl|proxy|github\.com|pypi|read timed out|"
            r"err_internet_disconnected|err_network_changed|err_name_not_resolved|err_connection_timed_out|err_timed_out)",
            lower))
        stage = "ready" if serving else ("starting" if proc_alive else ("stopped" if self.is_installed() else "not_installed"))
        detail = ""
        retry_hint = ""
        if serving:
            # Port bound = login done + server up. The log-tail matchers below are
            # STARTUP narration only — normal chats also emit AIEXE_MODEL/AIEXE_CREDITS
            # lines, so matching them while serving pinned the status on "syncing"
            # (or a stale "Waiting for Venice sign-in") forever.
            detail = "Venice Pro is ready."
        elif "AIEXE_INSTALL starting".lower() in lower and "AIEXE_INSTALL installed".lower() not in lower and not self.is_installed():
            stage = "installing"
            detail = "Downloading the adapter and dependencies."
        elif network_issue:
            stage = "network"
            detail = "Network looks slow or unavailable while reaching Venice or installing dependencies."
            retry_hint = "Try a stronger internet connection if this keeps retrying."
        elif re.search(r"sign in manually|sign in - venice|still on /sign-in|verification code|email code", lower):
            stage = "login"
            detail = "Waiting for Venice sign-in in the Chrome window."
        elif re.search(r"logging in to venice|already logged in", lower):
            stage = "login"
            detail = "Logging in to Venice."
        elif re.search(r"AIEXE_MODELS|AIEXE_PRICED|AIEXE_CREDITS|AIEXE_MODEL ", log):
            stage = "syncing"
            detail = "Reading models and credits from Venice."
        elif proc_alive and not serving:
            detail = "Chrome is opening and the adapter is getting ready."
        return {"installed": self.is_installed(), "running": proc_alive or serving,
                "serving": serving,
                "pid": self._proc.pid if proc_alive else None,
                "port": self._port, "install_dir": self._dir,
                "stage": stage, "detail": detail,
                "network_issue": network_issue, "retry_hint": retry_hint}
