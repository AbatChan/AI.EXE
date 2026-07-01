from selenium import webdriver
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from webdriver_manager.core.os_manager import ChromeType
from selenium.webdriver.common.by import By
from selenium.webdriver.common.desired_capabilities import DesiredCapabilities
from selenium.webdriver.common.keys import Keys
from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException, WebDriverException, StaleElementReferenceException
from flask import Flask, request, Response
import json
import uuid
from datetime import datetime, timezone
from gevent.pywsgi import WSGIServer
from gevent.lock import Semaphore
import time
import argparse
import os
import sys
import hashlib
from enum import Enum
import array

# --- Venice site config: all fragile selectors/URLs live in venice_config.py (copied next to
# this file). Edit that file when Venice changes their site; inline fallbacks below keep the
# adapter working if it's ever missing. ---
_vc_here = os.path.dirname(os.path.abspath(__file__))
if _vc_here not in sys.path:
    sys.path.insert(0, _vc_here)
try:
    import venice_config as _VC
except Exception:
    _VC = None


def _vcfg(name, default):
    try:
        v = getattr(_VC, name)
        return default if v is None else v
    except Exception:
        return default


def _vc_by(how):
    return {"id": By.ID, "name": By.NAME, "css": By.CSS_SELECTOR, "xpath": By.XPATH}.get(how, By.XPATH)


def _vc_sel(name, default_entries):
    return [(_vc_by(h), v) for (h, v) in _vcfg(name, default_entries)]


# Resolved once at import — edit venice_config.py to change any of these.
VC_SIGN_IN_URL = _vcfg('SIGN_IN_URL', "https://venice.ai/sign-in")
VC_CHAT_URL = _vcfg('CHAT_URL', "https://venice.ai/chat/classic")
VC_SIGN_IN_MARKER = _vcfg('SIGN_IN_URL_MARKER', "/sign-in")
VC_LOGIN_SUBMIT_XPATH = _vcfg('LOGIN_SUBMIT_XPATH', "//button[@type='submit' or contains(., 'Continue') or contains(., 'Sign in') or contains(., 'Log in')]")
VC_EMAIL_FIELDS = _vc_sel('EMAIL_FIELDS', [("id", "identifier-field"), ("name", "identifier"), ("css", "input[type='email']"), ("css", "input[autocomplete='username']"), ("css", "input[name='email']")])
VC_PASSWORD_FIELDS = _vc_sel('PASSWORD_FIELDS', [("id", "password-field"), ("css", "input[type='password']")])
VC_COMPOSER_XPATH = _vcfg('COMPOSER_XPATH', "//textarea[not(@readonly)]")
VC_SEND_BUTTON_XPATHS = _vcfg('SEND_BUTTON_XPATHS', ["//button[@type='submit' and @aria-label='Submit chat']", "//button[@data-testid='minds-chat-send-button']", "//button[@aria-label='Send message']", "//button[@type='submit']"])
VC_MODEL_BUTTON_XPATHS = _vcfg('MODEL_BUTTON_XPATHS', ["//button[.//p[@data-testid='minds-chat-agent-model-label']]", "//p[@data-testid='minds-chat-agent-model-label']/ancestor::button[1]", "//button[contains(@class,'css-d73kup')]"])
VC_MODEL_LABEL_XPATH = _vcfg('MODEL_LABEL_XPATH', "//p[@data-testid='minds-chat-agent-model-label']")
VC_MODEL_SEARCH_CSS = _vcfg('MODEL_SEARCH_CSS', "input[placeholder*='Search']")
VC_MODEL_ROW_TITLE_CSS = _vcfg('MODEL_ROW_TITLE_CSS', "p[title]")
VC_CLOSE_BUTTON_XPATH = _vcfg('CLOSE_BUTTON_XPATH', "//button[@aria-label='Close']")
VC_NEW_CHAT_XPATH = _vcfg('NEW_CHAT_XPATH', "//button[@aria-label='New chat']")


app = Flask(__name__)
selenium_lock = Semaphore()
driver = {}

class ResponseFormat(Enum):
    CHAT = 1
    GENERATE = 2
    COMPLETION_AS_STRING = 3
    CHAT_NON_STREAMED = 4


def capture_and_redirect_browser_logs(driver):
    global debug_browser
    if not debug_browser: return
    logs = driver.get_log('browser')
    for entry in logs:
        print(f"Browser log: {entry['level']} - {entry['message']}", file=sys.stderr)


def get_webdriver(headless=True, debug_browser=False, docker=False):
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument("--user-data-dir=" + os.path.join(os.path.dirname(os.path.abspath(__file__)), ".chrome-profile"))
    try:
        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
        chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    except Exception:
        pass
    if headless:
        chrome_options.add_argument("--headless")
    if debug_browser:
        chrome_options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    if docker:
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")

    if args.seed:
        chrome_options.add_argument("--disable-features=ChromeAppsDeprecation")

    chrome_options.page_load_strategy = 'eager'
    # Check if system-wide chromedriver exists
    system_chromedriver = "/usr/bin/chromedriver"
    if os.path.exists(system_chromedriver) and os.access(system_chromedriver, os.X_OK):
        print(f"Using system-wide chromedriver: {system_chromedriver}")
        service = Service(system_chromedriver)

        # Try to use Chromium first
        try:
            chrome_options.binary_location = "/usr/bin/chromium"
            driver = webdriver.Chrome(service=service, options=chrome_options)
            print("Using Chromium")
            return driver
        except WebDriverException as e:
            print(f"Chromium initialization failed: {e}")

        # If Chromium fails, try Chrome
        try:
            chrome_options.binary_location = ""
            driver = webdriver.Chrome(service=service, options=chrome_options)
            print("Using Google Chrome")
            return driver
        except WebDriverException as e:
            print(f"Chrome initialization failed: {e}")
    else:
        # Use ChromeDriverManager to install

        try:
            driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
            return driver
        except WebDriverException as e:
            print(f"Chrome not found ({e}), trying Chromium")


        try:
            driver = webdriver.Chrome(service=Service(ChromeDriverManager(chrome_type=ChromeType.CHROMIUM).install()), options=chrome_options)
            return driver
        except WebDriverException as e:
            print(f"Chromium error occurred: {e}")

    raise Exception("Neither Chrome nor Chromium could be initialized. Please make sure one of them is installed.")

def ensure_logged_in(driver):
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

def login_to_venice_with_username(username, password):
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

def inject_web3_provider(driver, seed):
    script = """
    (function injectWeb3Provider() {
    const script = document.createElement('script');
    script.textContent = `
        (function() {
            function loadScript(url) {
                return new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = url;
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            }

            async function loadDependencies() {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js');
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/web3/1.8.2/web3.min.js');
            }

            function createProvider(wallet) {
                const provider = {
                    isMetaMask: true,
                    _metamask: {
                        isUnlocked: () => Promise.resolve(true),
                        requestBatch: () => Promise.resolve(),
                        isApproved: () => Promise.resolve(true),
                    },
                    selectedAddress: wallet.address,
                    networkVersion: '1', // Arbitrum One: 42161
                    chainId: '0x1', // Arbitrum One: 0xa4b1
                    isConnected: () => true,
                    subscriptions: new Map(),
                    request: async ({ method, params }) => {
                        console.log('Request received:', method, params);
                        return new Promise((resolve, reject) => {
                            switch (method) {
                                case 'eth_requestAccounts':
                                case 'eth_accounts':
                                    resolve([wallet.address]);
                                case 'personal_sign':
                                    message = params[0];
                                    if (message.startsWith('0x')) {
                                            message = ethers.utils.toUtf8String(message);
                                    }

                                    const address = params[1];
                                    if (address.toLowerCase() !== wallet.address.toLowerCase()) {
                                        console.log('Address is wrong');
                                        reject(new Error('Address mismatch'));
                                    } else {
                                        wallet.signMessage(message)
                                            .then(signature => {
                                                console.log('Returning signature');
                                                resolve(signature);
                                            })
                                            .catch(error => {
                                                console.error('Error signing message:', error);
                                                reject(error);
                                            });
                                    }
                                    break;
                                case 'eth_sign':
                                    const messageToSign = ethers.utils.arrayify(params[1]);
                                    const addressForEthSign = params[0];
                                    if (addressForEthSign.toLowerCase() !== wallet.address.toLowerCase()) {
                                        reject(new Error('Address mismatch'));
                                    } else {
                                        return wallet.signMessage(messageToSign);
                                    }
                                    break;
                                case 'eth_chainId':
                                    resolve('0x1');
                                    break;
                                case 'net_version':
                                    resolve('1');
                                    break;
                                case 'wallet_switchEthereumChain':
                                    resolve();
                                    break;
                                default:
                                    reject(new Error('Unsupported web3 method: ' + method));
                            }
                        });
                    },
                    setMaxListeners: function(n) {
                      console.log('setMaxListeners called with:', n);
                    },
                    bzz: undefined,
                    removeListener: function(eventName, listener) {
                       console.log('removeListener called for:', eventName);
                    },
                    on: (eventName, callback) => {
                        const subscriptionId = 'sub_' + Math.random().toString(36).substring(2, 15);
                        console.log('Setting up provider event listener for:', eventName, 'with subscriptionId:', subscriptionId);
                        switch (eventName) {
                            case 'accountsChanged':
                                provider.subscriptions.set(subscriptionId, { callback });
                                setTimeout(() => callback([wallet.address]), 500);
                                break;

                            case 'connect':
                                console.log('Connected to the network');
                                provider.subscriptions.set(subscriptionId, { callback });
                                setTimeout(() => callback({ chainId: '0x1' }), 500);
                                break;

                            case 'message':
                            case 'disconnect':
                            case 'error':
                                provider.subscriptions.set(subscriptionId, { callback });
                                break;

                            case 'chainChanged':
                                provider.subscriptions.set(subscriptionId, { callback });
                                setTimeout(() => callback({ chainId: '0x01' }), 500);
                                break;

                            default:
                                console.log('Unsupported web3 event:', eventName);
                                reject(new Error('Unsupported web3 event: ' + eventName));
                        }

                        console.log('Called provider.on(' + eventName + ', ' + callback + ')');
                    },
                    removeListener: () => {},
                };

                // Mimic MetaMask's extension behavior
                provider.request.toString = () => 'function request() { [native code] }';
                Object.setPrototypeOf(provider, EventTarget.prototype);

                const eip6963_metamask_provider = {
                    info: {
                        name: "MetaMask",
                        uuid: "04c4cfd0-60b3-49fb-8f11-e181fa32b912",
                        rdns: "io.metamask",
                        icon: ""
                    },
                    provider: provider
                };

                function announceMetamaskWalletProvider() {
                      console.log('announceMetamaskWalletProvider called');
                      console.log('event detail:', eip6963_metamask_provider);

                    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
                        detail: eip6963_metamask_provider,
                        bubbles: true,
                        cancelable: false
                    }));
                }
                setTimeout(announceMetamaskWalletProvider, 100);
                window.addEventListener("eip6963:requestProvider", announceMetamaskWalletProvider);

                //return provider;

                // DEBUG ON
                try {
                    return new Proxy(provider, {
                        get(target, prop) {
                            try {
                                const value = target[prop];
                                const stack = new Error().stack;
                                console.log('Accessing property:', String(prop));
                                console.log('Stack trace:', stack);


                                if (typeof value === 'function') {
                                    return function(...args) {
                                        try {
                                            console.log('Calling method:', String(prop), args);
                                            return value.apply(target, args);
                                        } catch (error) {
                                            console.error('Error calling method:', String(prop), error);
                                            return undefined;
                                        }
                                    };
                                }

                                return value;
                            } catch (error) {
                                console.error('Error accessing property:', String(prop), error);
                                return undefined;
                            }
                        },
                        set(target, prop, value) {
                            try {
                                console.log('Setting property:', String(prop), value);
                                target[prop] = value;
                                return true;
                            } catch (error) {
                                console.error('Error setting property:', String(prop), error);
                                return false;
                            }
                        }
                    });
                } catch (error) {
                    console.error('Error creating proxy:', error);
                    return provider;
                }

            // DEBUG OFF
            }

            console.log('Loading dependencies')
            loadDependencies().then(() => {
                const seed = '{seed}';
                const hdNode = ethers.utils.HDNode.fromMnemonic(seed);
                const wallet = new ethers.Wallet(hdNode.derivePath("m/44'/60'/0'/0/0"));

                console.log('Creating provider')

                const provider = createProvider(wallet);

                //window.web3 = new Web3(provider);

                // Dispatch event to notify that the provider is ready
                //window.dispatchEvent(new Event('ethereum#initialized'));

                // Mimic content script injection
                //const metaMaskScript = document.createElement('script');
                //metaMaskScript.setAttribute('data-extension-id', 'nkbihfbeogaeaoehlefnkodbefgpgknn'); // MetaMask's extension ID
                //document.head.appendChild(metaMaskScript);

                console.log('Web3 provider injected successfully');
            });
        })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
})();

    """.replace('{seed}', seed)
    driver.execute_script(script)



def element_and_shadow_root_exist(driver, selector):
    script = f"""
        const el = {selector};
        return el && el.shadowRoot;
    """
    return driver.execute_script(script)

def login_to_venice_with_seed(seed):
    global driver, args
    print(f"Logging in to venice with seed...")
    driver = get_webdriver(headless=args.headless, debug_browser=args.debug_browser, docker=args.docker)

    driver.get("about:blank")
    inject_web3_provider(driver, seed)
    driver.get(VC_SIGN_IN_URL)
    print("Injecting web3 provider")
    inject_web3_provider(driver, seed)

    print("Waiting to click on Wallet Connect")
    wait = WebDriverWait(driver, selenium_timeout)
    button = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@aria-label='Wallet Connect']")))
    button.click()

    print("Clicked")
    wait.until(lambda driver: driver.execute_script(
        "return document.querySelector('w3m-modal').classList.contains('open');"))

    selectors = [
        "document.querySelector('w3m-modal')",
        ".querySelector('w3m-router')",
        ".querySelector('w3m-connecting-siwe-view')",
        ".querySelectorAll('wui-button')[1]"
    ]

    current_selector = selectors[0]
    for next_selector in selectors[1:]:
        WebDriverWait(driver, selenium_timeout).until(
            lambda x: element_and_shadow_root_exist(x, current_selector)
        )
        current_selector += ".shadowRoot" + next_selector

    sign_button_selector = current_selector
    js_is_clickable = f"""
        const button = {sign_button_selector};
        return button && !button.disabled;
    """
    WebDriverWait(driver, selenium_timeout).until(lambda x: x.execute_script(js_is_clickable))

    js_click = f"""
        const button = {sign_button_selector};
        button.click();
    """

    driver.execute_script(js_click)

    # Maximum wait time in seconds until the modal closes
    max_wait_time = 60
    start_time = time.time()

    while time.time() - start_time < max_wait_time:
        try:
            # Check if the link is clickable
            element = WebDriverWait(driver, selenium_timeout).until(
                EC.element_to_be_clickable((By.LINK_TEXT, "without an account"))
            )
            element.click()
            print("Link clicked successfully.")
            break
        except ElementClickInterceptedException:
            # print("Element is still obstructed. Retrying...")
            time.sleep(1)
        except TimeoutException:
            # print("Link is not clickable yet. Retrying...")
            time.sleep(1)  # Wait for 1 second before retrying
    else:
        print("Maximum wait time exceeded. Link was not clickable.")

    ensure_logged_in(driver)

    print(f"Logged in with seed")
    return driver


def login_to_venice():
    if (username is not None and password is not None and len(username)>0):
        return login_to_venice_with_username(username, password)
    elif (seed is not None):
        return login_to_venice_with_seed(seed)
    else:
        print("No username and password, nor seed provided")
        sys.exit(1)

def inject_request_interceptor(driver, api_data_json):
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










def presence_of_either_element_located(locators):
    def _predicate(driver):
        for locator in locators:
            try:
                element = driver.find_element(*locator)
                if element.is_displayed():
                    return element
            except:
                pass
        return False
    return _predicate

AIEXE_MODELS_CACHE = []
AIEXE_FALLBACK_MODELS = _vcfg('FALLBACK_MODELS', ["DeepSeek V4 Flash", "DeepSeek V3.2",
    "Qwen 3.7 Max", "Claude Fable 5", "Claude Opus 4.8", "Claude Sonnet 4.6", "GLM 4.6",
    "GLM 4.7 Flash Heretic", "GLM 5.2", "Google Gemma 4 31B Instr", "Venice Uncensored 1.2"])


def _aiexe_model_button(driver):
    """The composer button that opens the model picker. Tries the configured xpaths, then falls
    back to a button whose text is a KNOWN model name (survives Venice's hashed CSS classes)."""
    for xp in VC_MODEL_BUTTON_XPATHS:
        try:
            b = driver.find_element(By.XPATH, xp)
            if b.is_displayed():
                return b
        except Exception:
            pass
    known = [m.lower() for m in (AIEXE_MODELS_CACHE or AIEXE_FALLBACK_MODELS)]
    try:
        for b in driver.find_elements(By.TAG_NAME, "button"):
            try:
                t = (b.text or "").strip().lower()
                if t and b.is_displayed() and any(t == k or (k in t and len(t) <= len(k) + 14) for k in known):
                    return b
            except Exception:
                pass
    except Exception:
        pass
    # The model name often lives in a <p>/<span> whose parent button reports empty .text —
    # match the label element (exact model name) and climb to its clickable ancestor button.
    try:
        for el in driver.find_elements(By.XPATH, "//button//p | //button//span"):
            try:
                t = (el.text or el.get_attribute("title") or "").strip().lower()
                if t and el.is_displayed() and t in known:
                    return el.find_element(By.XPATH, "./ancestor::button[1]")
            except Exception:
                pass
    except Exception:
        pass
    return None


def _aiexe_current_model(driver):
    """Text of the currently-selected model (from the model button), or ''."""
    b = _aiexe_model_button(driver)
    try:
        return (b.text or "").strip() if b is not None else ""
    except Exception:
        return ""


def _aiexe_open_model_modal(driver):
    b = _aiexe_model_button(driver)
    if b is None:
        print("AIEXE_MODEL could NOT find the model button", flush=True)
        return False
    try:
        b.click()
        return True
    except Exception as _e:
        try:
            driver.execute_script("arguments[0].click();", b)
            return True
        except Exception:
            print("AIEXE_MODEL model button not clickable: %s" % _e, flush=True)
            return False


def _aiexe_dismiss_modal(driver):
    """Belt-and-suspenders: close any open dialog so it can't block the composer."""
    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
    except Exception:
        pass
    try:
        for b in driver.find_elements(By.XPATH, VC_CLOSE_BUTTON_XPATH):
            if b.is_displayed():
                b.click()
    except Exception:
        pass


def _aiexe_close_modal(driver):
    _aiexe_dismiss_modal(driver)


def _aiexe_wait_composer(driver):
    """Return a fresh, enabled Venice composer textarea.

    Venice's SPA frequently rerenders the composer after New chat/model-picker actions.
    Holding an older Selenium element is what causes stale-element failures, so every
    typing/submitting step should come through this helper.
    """
    last_err = None
    for _ in range(10):
        try:
            el = WebDriverWait(driver, selenium_timeout).until(
                EC.presence_of_element_located((By.XPATH, VC_COMPOSER_XPATH))
            )
            if el.is_displayed() and el.is_enabled():
                driver.execute_script("return arguments[0].tagName;", el)
                return el
        except Exception as exc:
            last_err = exc
            time.sleep(0.25)
    if last_err:
        raise last_err
    return WebDriverWait(driver, selenium_timeout).until(
        EC.element_to_be_clickable((By.XPATH, VC_COMPOSER_XPATH))
    )


def _aiexe_set_composer_text(driver, text):
    """Set composer text via React's value setter, retrying through SPA rerenders."""
    last_err = None
    for _ in range(6):
        try:
            el = _aiexe_wait_composer(driver)
            driver.execute_script(
                "var el=arguments[0], v=arguments[1];"
                "el.focus();"
                "var d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');"
                "(d&&d.set?d.set:function(x){el.value=x;}).call(el, v);"
                "el.dispatchEvent(new Event('input', {bubbles:true}));"
                "el.dispatchEvent(new Event('change', {bubbles:true}));", el, text)
            return True
        except (StaleElementReferenceException, WebDriverException) as exc:
            last_err = exc
            time.sleep(0.25)
    if last_err:
        print("AIEXE_SEND set_text failed: %s" % last_err, flush=True)
    return False


def _aiexe_submit_prompt(driver):
    """Click Venice's send button, with JS and Enter fallbacks."""
    for _try in range(24):
        for _xp in VC_SEND_BUTTON_XPATHS:
            try:
                btn = driver.find_element(By.XPATH, _xp)
                if btn.is_displayed() and btn.is_enabled():
                    try:
                        btn.click()
                    except Exception:
                        driver.execute_script("arguments[0].click();", btn)
                    print("AIEXE_SEND clicked xpath=%r try=%d" % (_xp, _try), flush=True)
                    return True
            except Exception:
                pass
        time.sleep(0.25)
    try:
        _aiexe_wait_composer(driver).send_keys(Keys.RETURN)
        print("AIEXE_SEND fallback_enter", flush=True)
        return True
    except Exception as exc:
        print("AIEXE_SEND failed: %s" % exc, flush=True)
        return False


def aiexe_scrape_models(driver):
    """Read Venice's real model list from the picker (title attrs). Best-effort; cached once."""
    import time as _t
    try:
        if 'venice.ai/chat' not in driver.current_url:
            driver.get(VC_CHAT_URL)
        # Wait for the composer + model button to render, else the modal never opens (the
        # startup scrape used to run too early → empty → /api/tags fell back to stale names).
        for _w in range(20):
            if _aiexe_model_button(driver) is not None:
                break
            _t.sleep(0.5)
        if not _aiexe_open_model_modal(driver):
            return []
        _t.sleep(1)
        names = []
        for p in driver.find_elements(By.CSS_SELECTOR, VC_MODEL_ROW_TITLE_CSS):
            t = (p.get_attribute("title") or "").strip()
            if t and t not in names:
                names.append(t)
        _aiexe_close_modal(driver)
        return names
    except Exception:
        return []


def aiexe_select_model(driver, name):
    """Pick `name` in Venice's model modal before sending. Fully guarded — a failure just
    leaves the current model selected, never breaks the chat."""
    import time as _t
    name = (name or "").strip()
    if not name:
        return
    # Only drive the picker for a REAL Venice model. Legacy/mock IDs (llama-...-akash, hermes,
    # dolphin, nemotron, etc.) aren't in Venice's list — opening the modal for them finds
    # nothing and can leave a dialog over the composer, which breaks the chat. Skip them.
    known = [m.lower() for m in (AIEXE_MODELS_CACHE or AIEXE_FALLBACK_MODELS)]
    nl = name.lower()
    if not any(nl == k or nl in k or k in nl for k in known):
        print("AIEXE_MODEL skip (not a known model): %r" % name, flush=True)
        return
    try:
        # The model button may still be rendering right after the composer appears — wait briefly.
        for _w in range(12):
            if _aiexe_model_button(driver) is not None:
                break
            _t.sleep(0.5)
        cur = _aiexe_current_model(driver)
        if cur and cur.lower() == nl:
            print("AIEXE_MODEL already on %r" % name, flush=True)
            return
        print("AIEXE_MODEL want=%r current=%r — opening picker" % (name, cur), flush=True)
        if not _aiexe_open_model_modal(driver):
            return
        _t.sleep(0.8)
        try:
            box = driver.find_element(By.CSS_SELECTOR, VC_MODEL_SEARCH_CSS)
            box.clear()
            box.send_keys(name.split()[0])
            _t.sleep(0.9)
        except Exception as _e:
            print("AIEXE_MODEL search box not found (%s)" % _e, flush=True)
        rows = driver.find_elements(By.CSS_SELECTOR, VC_MODEL_ROW_TITLE_CSS)
        print("AIEXE_MODEL rows=%d titles=%r" % (len(rows), [(r.get_attribute("title") or "")[:24] for r in rows[:10]]), flush=True)
        target = None
        for p in rows:
            if (p.get_attribute("title") or "").strip().lower() == nl:
                target = p; break
        if target is None:
            for p in rows:
                if nl in (p.get_attribute("title") or "").strip().lower():
                    target = p; break
        if target is not None:
            try:
                row = target.find_element(By.XPATH, "./ancestor::*[@role='group' or @role='menuitem' or @role='menuitemradio'][1]")
            except Exception:
                row = target
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", row)
            except Exception:
                pass
            try:
                row.click()
            except Exception:
                driver.execute_script("arguments[0].click();", row)
            _t.sleep(0.5)
            print("AIEXE_MODEL clicked %r" % name, flush=True)
        else:
            print("AIEXE_MODEL target row NOT found for %r" % name, flush=True)
            _aiexe_close_modal(driver)
    except Exception as _e:
        print("AIEXE_MODEL error: %s" % _e, flush=True)
        _aiexe_close_modal(driver)


def generate_selenium_streamed_response(data, driver, response_format=ResponseFormat.CHAT):
    global timeout
    request_id = str(uuid.uuid4())[:8]
    model_id = data.get('model', 'llama-3.1-405b-akash-api')
    request_model_id = model_id
    if ':latest' in request_model_id:
        request_model_id = request_model_id.split(':latest')[0]

    api_data = {
        "requestId": request_id,
        "modelId": request_model_id,
        "prompt": data['messages'],
        "systemPrompt": "",
        "conversationType": "text",
        "temperature": 0.8,
        "topP": 0.9
    }

    api_data_json = json.dumps(api_data)
    try:
        try:
            print("AIEXE_DIAG url=" + str(driver.current_url))
            for _i, _t in enumerate(driver.find_elements(By.TAG_NAME, "textarea")):
                print("AIEXE_DIAG textarea[%d] placeholder=%r displayed=%s" % (_i, _t.get_attribute("placeholder"), _t.is_displayed()))
            for _b in driver.find_elements(By.XPATH, "//button[@type='submit' or @aria-label]"):
                print("AIEXE_DIAG button aria=%r type=%r text=%r" % (_b.get_attribute("aria-label"), _b.get_attribute("type"), (_b.text or "")[:30]))
        except Exception as _e:
            print("AIEXE_DIAG error " + str(_e))
        # New AI.EXE chat (no assistant turns yet) → load a FRESH Venice conversation so chats
        # don't bleed into each other. Follow-ups within the same chat reuse the page (reloading
        # every request proved flaky). AI.EXE sends the full history in the prompt either way.
        _is_first_turn = not any(isinstance(_m, dict) and _m.get('role') == 'assistant'
                                 for _m in (data.get('messages') or []))
        if 'venice.ai/chat' not in driver.current_url:
            driver.get(VC_CHAT_URL)              # not on Venice at all → one real load
        elif _is_first_turn:
            # New AI.EXE chat → fresh Venice conversation WITHOUT a full page reload: click
            # Venice's own "New chat" (SPA nav, ~instant). Fall back to reload if absent.
            try:
                _nc = driver.find_element(By.XPATH, VC_NEW_CHAT_XPATH)
                driver.execute_script("arguments[0].click();", _nc)
                time.sleep(0.5)
                print("AIEXE_NAV new chat via SPA button", flush=True)
            except Exception:
                driver.get(VC_CHAT_URL)
        # follow-ups within the same AI.EXE chat: reuse the page, no navigation at all
        # Hide the raw typed prompt in the (minimized) Venice window — model still receives it.
        # Toggle from AI.EXE Settings (passed as AIEXE_HIDE_PROMPT env on start; default on).
        try:
            if os.getenv('AIEXE_HIDE_PROMPT', '1') != '0':
                driver.execute_script("var s=document.getElementById('aiexe-hide')||document.createElement('style');s.id='aiexe-hide';s.textContent='[data-testid=\"user-message\"],[data-message-content]{visibility:hidden!important}';document.head.appendChild(s);")
            else:
                driver.execute_script("var s=document.getElementById('aiexe-hide'); if(s) s.remove();")
        except Exception:
            pass
        element = WebDriverWait(driver, selenium_timeout).until(
            presence_of_either_element_located((
                (By.XPATH, "//button[.//p[contains(text(), 'Text Conversation')]]"),
                (By.XPATH, VC_COMPOSER_XPATH)
            ))
        )

        if element.tag_name == 'button':
            element.click()
            element = _aiexe_wait_composer(driver)
        else:
            element = _aiexe_wait_composer(driver)

        # NOW the composer (and its model selector) is rendered — pick the requested model.
        # Doing this right after driver.get() failed: the model button wasn't in the DOM yet
        # (textarea displayed=False). Guarded — a failure just keeps the current model.
        try:
            aiexe_select_model(driver, request_model_id)
        except Exception:
            pass
        _aiexe_dismiss_modal(driver)  # never let a stray dialog block the composer
        # Venice SPA navigation/model-picker changes can rerender the composer. Never reuse
        # the textarea found before model selection; reacquire it right before typing.
        element = _aiexe_wait_composer(driver)

        # Type the REAL user prompt into the composer (was a placeholder " " that relied on a
        # network-body swap which no longer lands — Venice was answering the empty space). Use
        # the native value setter + input event so React/Chakra registers it.
        _prompt_text = " "
        try:
            for _mm in reversed(data.get('messages') or []):
                if isinstance(_mm, dict) and _mm.get('role') == 'user' and str(_mm.get('content') or '').strip():
                    _prompt_text = str(_mm.get('content'))
                    break
        except Exception:
            _prompt_text = " "
        if not _aiexe_set_composer_text(driver, _prompt_text):
            _aiexe_wait_composer(driver).send_keys(_prompt_text)

        current_url = driver.current_url

        # If we are on the main chat page, the button will navigate us to a different url first
        if current_url == 'https://venice.ai/chat':
            WebDriverWait(driver, selenium_timeout).until(
                EC.element_to_be_clickable((By.XPATH, "//button[@type='submit' and @aria-label='submit']"))
            ).click()
            WebDriverWait(driver, selenium_timeout).until(EC.url_changes(current_url))
            _aiexe_set_composer_text(driver, " ")


        inject_request_interceptor(driver, api_data_json)

        _sent = _aiexe_submit_prompt(driver)

        start_time = datetime.now(timezone.utc)

        eval_count = 0
        last_data_time = time.time()
        streamed_content = ""
        _reasoning_open = False   # True while we're inside a <thinking>…</thinking> block

        def _emit(txt):
            # Stream a piece of assistant text in the right shape for the response format.
            if response_format == ResponseFormat.CHAT:
                return json.dumps({"model": model_id, "created_at": datetime.utcnow().isoformat() + "Z",
                                   "message": {"role": "assistant", "content": txt}, "done": False}) + "\r\n"
            if response_format == ResponseFormat.GENERATE:
                return json.dumps({"model": model_id, "created_at": datetime.utcnow().isoformat() + "Z",
                                   "response": txt, "done": False}) + "\r\n"
            return None

        while True:
            chunks = driver.execute_script("""
                if (typeof window.receivedChunks !== 'undefined' && window.receivedChunks !== null) {
                    return window.receivedChunks.splice(0, window.receivedChunks.length);
                } else {
                    return [];
                }
            """)
            buffer = ""
            for chunk in chunks:
                last_data_time = time.time()
                chunk_str = bytes(array.array('B', chunk)).decode('utf-8')
                buffer += chunk_str
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)  # Split at the first newline
                    if line:
                        try:
                            json_data = json.loads(line)
                            _kind = str(json_data.get('kind') or '')
                            _c = json_data.get('content', '')
                            if _kind == 'content' and len(_c) > 0:
                                # Close a reasoning block before the visible answer starts.
                                if _reasoning_open:
                                    if response_format == ResponseFormat.CHAT_NON_STREAMED:
                                        streamed_content += '</thinking>'
                                    else:
                                        _m = _emit('</thinking>')
                                        if _m: yield _m
                                    _reasoning_open = False
                                eval_count += 1
                                if response_format == ResponseFormat.CHAT_NON_STREAMED:
                                    streamed_content += _c
                                elif response_format == ResponseFormat.COMPLETION_AS_STRING:
                                    yield _c
                                else:
                                    _m = _emit(_c)
                                    if _m: yield _m
                            elif len(_c) > 0 and ('reason' in _kind.lower() or 'think' in _kind.lower() or 'thought' in _kind.lower()):
                                # Venice's native reasoning stream → wrap as <thinking> so AI.EXE's
                                # Thoughts UI can show it (and strip it when think mode is off).
                                _piece = ('<thinking>' if not _reasoning_open else '') + _c
                                _reasoning_open = True
                                if response_format == ResponseFormat.CHAT_NON_STREAMED:
                                    streamed_content += _piece
                                elif response_format == ResponseFormat.COMPLETION_AS_STRING:
                                    pass  # completion string = final text only, skip reasoning
                                else:
                                    _m = _emit(_piece)
                                    if _m: yield _m
                            elif len(_c) > 0:
                                print("AIEXE_KIND unhandled kind=%r content=%r" % (_kind, _c[:60]), flush=True)
                        except json.JSONDecodeError:
                            print(f"Failed to parse line: {line}")

            if driver.execute_script("return window.streamComplete;"):
                break
            if time.time() - last_data_time > timeout:
                print(f"Timeout: No data received for {timeout} seconds. Exiting loop.")
                try:
                    _posts = driver.execute_script("return window.__aiexe_urls || []")
                    print("AIEXE_DIAG_FETCH posts=" + str(_posts)[:900], flush=True)
                except Exception:
                    pass
                break
            time.sleep(0.1)

        if _reasoning_open:  # stream ended still inside a reasoning block — close it
            if response_format == ResponseFormat.CHAT_NON_STREAMED:
                streamed_content += '</thinking>'
            else:
                _m = _emit('</thinking>')
                if _m: yield _m
            _reasoning_open = False

        capture_and_redirect_browser_logs(driver)

        if (response_format == ResponseFormat.CHAT) or (response_format == ResponseFormat.GENERATE) or (response_format == ResponseFormat.CHAT_NON_STREAMED):
            end_time = datetime.now(timezone.utc)
            duration = int((end_time - start_time).total_seconds() * 1e9)  # nanoseconds

            final_message = {
                "model": model_id,
                "created_at": datetime.utcnow().isoformat() + "Z",
                "message": {"role": "assistant", "content": streamed_content},
                "done_reason": "stop",
                "done": True,
                "total_duration": duration,
                "load_duration": duration,
                "prompt_eval_count": eval_count,
                "prompt_eval_duration": duration,
                "eval_count": eval_count,
                "eval_duration": duration
            }

            yield f"{json.dumps(final_message)}"
    except WebDriverException as e:
        print(f"Error occurred during chat: {e}", flush=True)  # AIEXE_RECOVER
        try:
            driver.get(VC_CHAT_URL)  # keep the session; no re-login/recursion
        except Exception:
            pass


def parse_json_request(request):
    content_type = request.headers.get('Content-Type')

    if content_type == 'application/json':
        return request.json
    elif content_type == 'text/plain; charset=utf-8':
        data = request.data.decode('utf-8')
        try:
          return json.loads(data)
        except json.JSONDecodeError:
          return None

@app.route('/api/chat', methods=['POST'])
def chat():
    global driver
    request_json = parse_json_request(request)
    if request_json is None :
            return Response("Invalid JSON data received", status=400, content_type='text/plain')

    response_format = ResponseFormat.CHAT
    content_type = 'application/x-ndjson'

    if 'stream' in request_json and request_json['stream'] == False:
        response_format = ResponseFormat.CHAT_NON_STREAMED
        content_type = 'application/json; charset=utf-8'

    with selenium_lock:
        return Response(generate_selenium_streamed_response(request_json, driver, response_format=response_format), content_type=content_type)

@app.route('/api/generate', methods=['POST'])
def generate():
    global driver
    request_json = parse_json_request(request)
    if request_json is None :
        return Response("Invalid JSON data received", status=400, content_type='text/plain')

    prompt = request_json.pop('prompt')

    if '[INST]' in prompt:
        inst_start = prompt.find('[INST]')
        inst_end = prompt.find('[/INST]')

        instructions = prompt[inst_start + 6:inst_end]
        response = prompt[inst_end + 7:]
        request_json["messages"] = [
            {
                "role": "user",
                "content": instructions.strip()
            },
            {
                "role": "assistant",
                "content": response.strip()
            }
        ]
    else:
        request_json["messages"] = [
            {
                "role": "user",
                "content": prompt
            }
        ]
    with selenium_lock:
        return Response(generate_selenium_streamed_response(request_json, driver, response_format=ResponseFormat.GENERATE), content_type='application/x-ndjson')

@app.route('/v1/chat/completions', methods=['POST'])
def openai_like_completion():
    request_json = parse_json_request(request)
    completion = ''.join(generate_selenium_streamed_response(request_json, driver, response_format=ResponseFormat.COMPLETION_AS_STRING))
    response_json = {
        "id": "chatcmpl-953",
        "object": "chat.completion",
        "created": int(datetime.now().timestamp()),
        "model": request_json["model"],
        "system_fingerprint": "fp_ollama",
        "choices": [
            {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": completion
            },
            "finish_reason": "stop"
            }
        ]
        }
    return Response(json.dumps(response_json), mimetype='application/json')






@app.route('/api/version', methods=['GET'])
def version():
    return Response(json.dumps({"version":"0.3.6"}), content_type='application/json')

def get_mock_model(name, parameter_size):
    return {
      "name": name,
      "model": name,
      "modified_at": "2024-08-16T18:50:00.684933726+02:00",
      "size": 15628387458,
      "digest": hashlib.sha256(json.dumps({"name": name, "parameter_size": parameter_size}, sort_keys=True).encode("utf-8")).hexdigest(),
      "details": {
        "parent_model": "",
        "format": "gguf",
        "family": "llama",
        "families": [ "llama" ],
        "parameter_size": parameter_size,
        "quantization_level": "Q7_0"
      }
    }

@app.route('/api/tags', methods=['GET'])
def tags():
    # Advertise Venice's REAL models (scraped once at startup, else the curated fallback) so
    # AI.EXE's model dropdown matches what the picker can actually select.
    names = AIEXE_MODELS_CACHE or AIEXE_FALLBACK_MODELS
    tags_response = {"models": [get_mock_model(n + ":latest", "") for n in names]}
    return Response(json.dumps(tags_response), content_type='application/json')

@app.route('/api/show', methods=['POST'])
def mock_show():
    show_response = {
        "modelfile": "# Modelfile generated by \"ollama show\"\n# To build a new Modelfile based on this one, replace the FROM line with:\n# FROM llava:latest\n\nFROM /Users/matt/.ollama/models/blobs/sha256:200765e1283640ffbd013184bf496e261032fa75b99498a9613be4e94d63ad52\nTEMPLATE \"\"\"{{ .System }}\nUSER: {{ .Prompt }}\nASSISTANT: \"\"\"\nPARAMETER num_ctx 4096\nPARAMETER stop \"\u003c/s\u003e\"\nPARAMETER stop \"USER:\"\nPARAMETER stop \"ASSISTANT:\"",
        "parameters": "num_keep                       24\nstop                           \"<|start_header_id|>\"\nstop                           \"<|end_header_id|>\"\nstop                           \"<|eot_id|>\"",
        "template": "{{ if .System }}<|start_header_id|>system<|end_header_id|>\n\n{{ .System }}<|eot_id|>{{ end }}{{ if .Prompt }}<|start_header_id|>user<|end_header_id|>\n\n{{ .Prompt }}<|eot_id|>{{ end }}<|start_header_id|>assistant<|end_header_id|>\n\n{{ .Response }}<|eot_id|>",
        "details": {
            "parent_model": "",
            "format": "gguf",
            "family": "llama",
            "families": [
            "llama"
            ],
            "parameter_size": "8.0B",
            "quantization_level": "Q4_0"
        },
        "model_info": {
            "general.architecture": "llama",
            "general.file_type": 2,
            "general.parameter_count": 8030261248,
            "general.quantization_version": 2,
            "llama.attention.head_count": 32,
            "llama.attention.head_count_kv": 8,
            "llama.attention.layer_norm_rms_epsilon": 0.00001,
            "llama.block_count": 32,
            "llama.context_length": 8192,
            "llama.embedding_length": 4096,
            "llama.feed_forward_length": 14336,
            "llama.rope.dimension_count": 128,
            "llama.rope.freq_base": 500000,
            "llama.vocab_size": 128256,
            "tokenizer.ggml.bos_token_id": 128000,
            "tokenizer.ggml.eos_token_id": 128009,
            "tokenizer.ggml.merges": [],            # populates if `verbose=true`
            "tokenizer.ggml.model": "gpt2",
            "tokenizer.ggml.pre": "llama-bpe",
            "tokenizer.ggml.token_type": [],        # populates if `verbose=true`
            "tokenizer.ggml.tokens": []             # populates if `verbose=true`
        }
        }
    return show_response

## main code

parser = argparse.ArgumentParser(description='Ollama-like API for venice.ai')

parser.add_argument('--username', type=str, required=False, help='Venice username')
parser.add_argument('--password', type=str, required=False, help='Venice password')

# Optional arguments with defaults
parser.add_argument('--host', type=str, default='127.0.0.1', help='Local host address')
parser.add_argument('--port', type=int, default=9999, help='Server port')
parser.add_argument('--timeout', type=int, default=20, help='Timeout for generating tokens from Venice (seconds)')
parser.add_argument('--selenium-timeout', type=int, default=20, help='Selenium timeout (seconds)')
parser.add_argument('--headless', action='store_true', default=True, help='Run Selenium in headless mode')
parser.add_argument('--no-headless', action='store_false', dest='headless', help='Disable headless mode and run with a visible browser window')
parser.add_argument('--debug-browser', action='store_true', default=False, help='Enable browser debugging logs')
parser.add_argument('--docker', action='store_true', default=False, help='Do not run Chrome sandbox (required for docker)')
parser.add_argument('--seed', type=str, required=False, help='Seed to log in with WalletConnect')
parser.add_argument('--ensure-pro', action='store_true', default=False, help='Ensure that Venice recognized the user has a pro account')

args = parser.parse_args()

# Set username and password or seed from environment variables if not provided
username = args.username or os.getenv('VENICE_USERNAME')
password = args.password or os.getenv('VENICE_PASSWORD')
seed = args.seed or os.getenv('VENICE_SEED')

if (not seed) and (not username or not password):
    print("Either seed or both username and password for venice are required. Set using command line arguments or environment variables - VENICE_SEED or VENICE_USERNAME and VENICE_PASSWORD", file=sys.stderr)
    sys.exit(1)

timeout=args.timeout
selenium_timeout=args.selenium_timeout
debug_browser = args.debug_browser

import atexit as _aiexe_atexit, signal as _aiexe_signal
def _aiexe_close_browser(*_a):
    try:
        _d = globals().get("driver")
        if _d and not isinstance(_d, dict):
            _d.quit()
    except Exception:
        pass
_aiexe_atexit.register(_aiexe_close_browser)
try:
    _aiexe_signal.signal(_aiexe_signal.SIGTERM, lambda *_a: (_aiexe_close_browser(), os._exit(0)))
except Exception:
    pass
driver = login_to_venice()
try:  # scrape Venice's real model list once (best-effort) so /api/tags advertises the truth
    _scraped = aiexe_scrape_models(driver)
    if _scraped:
        AIEXE_MODELS_CACHE = _scraped
        print("AIEXE_MODELS scraped: %d models" % len(_scraped), flush=True)
except Exception as _e:
    print("AIEXE_MODELS scrape failed: " + str(_e), flush=True)
print(f"Starting server at port {args.host}:{args.port}")
http_server = WSGIServer((args.host, args.port), app)
http_server.serve_forever()
