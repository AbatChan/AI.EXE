from selenium import webdriver
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from webdriver_manager.core.os_manager import ChromeType
from selenium.webdriver.common.by import By
from selenium.webdriver.common.desired_capabilities import DesiredCapabilities
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException, WebDriverException, StaleElementReferenceException, NoSuchWindowException, InvalidSessionIdException
from flask import Flask, request, Response
import json
import uuid
from datetime import datetime, timezone
import gevent
from gevent.pywsgi import WSGIServer
from gevent.lock import Semaphore
import time
import argparse
import os
import sys
import hashlib
import re
from enum import Enum
import array
import base64
import tempfile

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
# Venice's modal "Search models..." control is a BUTTON that reveals the real input on click.
VC_MODEL_SEARCH_BUTTON_XPATH = _vcfg('MODEL_SEARCH_BUTTON_XPATH', "//button[contains(., 'Search models')]")
VC_MODEL_ROW_TITLE_CSS = _vcfg('MODEL_ROW_TITLE_CSS', "p[title]")
VC_CLOSE_BUTTON_XPATH = _vcfg('CLOSE_BUTTON_XPATH', "//button[@aria-label='Close']")
VC_NEW_CHAT_XPATH = _vcfg('NEW_CHAT_XPATH', "//button[@aria-label='New chat']")
VC_CHAT_SETTINGS_BUTTON_XPATH = _vcfg('CHAT_SETTINGS_BUTTON_XPATH', "//button[@aria-label='Settings']")
VC_STOP_GENERATING_XPATH = _vcfg('STOP_GENERATING_XPATH', "//button[translate(@aria-label,'STOP','stop')='stop' or @aria-label='Stop generating']")
VC_PRICED_ICON_PATH_PREFIX = _vcfg('PRICED_ICON_PATH_PREFIX', "M9 14c0")   # the coin-stack svg's first path
VC_CREDITS_TEXT_XPATH = _vcfg('CREDITS_TEXT_XPATH', "//p[contains(., 'Credits')]")
VC_CHAT_SETTINGS_SWITCH_XPATH = _vcfg('CHAT_SETTINGS_SWITCH_XPATH', "//p[normalize-space()='{}']/ancestor::div[contains(@class,'css-bngl5n')]//input[@type='checkbox']")
# Attachments
VC_ATTACH_FILE_INPUT_XPATHS = _vcfg('ATTACH_FILE_INPUT_XPATHS', ["//input[@type='file' and @name='attachments']", "//form//input[@type='file']", "//input[@type='file']"])
VC_ATTACH_CARD_IMG_XPATH = _vcfg('ATTACH_CARD_IMG_XPATH', "//div[contains(@class,'chakra-card')]//img[starts-with(@src,'blob:')]")
VC_ATTACH_CARD_BY_NAME_XPATH = _vcfg('ATTACH_CARD_BY_NAME_XPATH', "//div[contains(@class,'chakra-card')][.//p[normalize-space()='{}'] or .//img[@alt='{}']]")
VC_ATTACH_CARD_REMOVE_XPATH = _vcfg('ATTACH_CARD_REMOVE_XPATH', "//div[contains(@class,'chakra-card')]//button[@aria-label='Remove']")
VC_ATTACH_ACTIONS_BUTTON_XPATH = _vcfg('ATTACH_ACTIONS_BUTTON_XPATH', "//button[@aria-label='Actions']")
# Sidebar rows: rename / delete / cleanup
VC_SIDEBAR_CHAT_ROW_XPATH = _vcfg('SIDEBAR_CHAT_ROW_XPATH', "//div[@role='group'][.//a[contains(@href,'/chat/classic/{}')]]")
VC_SIDEBAR_CHAT_ROW_ANY_XPATH = _vcfg('SIDEBAR_CHAT_ROW_ANY_XPATH', "//a[contains(@href,'/chat/classic/')]")
VC_CHAT_RENAME_BUTTON_XPATH = _vcfg('CHAT_RENAME_BUTTON_XPATH', ".//button[@aria-label='Rename']")
VC_CHAT_RENAME_INPUT_XPATH = _vcfg('CHAT_RENAME_INPUT_XPATH', "//input[contains(@class,'chakra-input')]")
VC_CHAT_RENAME_CONFIRM_XPATH = _vcfg('CHAT_RENAME_CONFIRM_XPATH', "//button[@aria-label='confirm']")
VC_CHAT_RENAME_CANCEL_XPATH = _vcfg('CHAT_RENAME_CANCEL_XPATH', "//button[@aria-label='Cancel']")
VC_CHAT_DELETE_BUTTON_XPATH = _vcfg('CHAT_DELETE_BUTTON_XPATH', ".//button[@aria-label='Delete']")
VC_CHAT_DELETE_CONFIRM_XPATH = _vcfg('CHAT_DELETE_CONFIRM_XPATH', "//footer//button[normalize-space()='Confirm']")
VC_SIDEBAR_TOGGLE_XPATH = _vcfg('SIDEBAR_TOGGLE_XPATH', "//button[@aria-label='Toggle sidebar' or @aria-label='Show Sidebar']")
# Rendered assistant reply (DOM fallback when the worker bypasses the fetch interceptor).
VC_ASSISTANT_MESSAGE_XPATH = _vcfg('ASSISTANT_MESSAGE_XPATH', "//div[@data-message-id]")
VC_USER_MESSAGE_MARKER_CSS = _vcfg('USER_MESSAGE_MARKER_CSS', "[data-testid='user-message']")


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
    # Keep rendering/timers alive while minimized — the model scrape + priced-icon sweep
    # run on a minimized window (Venice's picker is virtualized: no paint = no rows).
    chrome_options.add_argument("--disable-background-timer-throttling")
    chrome_options.add_argument("--disable-backgrounding-occluded-windows")
    chrome_options.add_argument("--disable-renderer-backgrounding")
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
    # (Not minimized here — the boot sequence minimizes once after scrape+credits.)
    try:
        if "/sign-in" not in driver.current_url:
            print("Already logged in (saved session).")
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
    # Deliberately NOT minimized here: startup still needs to scrape models + read credits,
    # which is only reliable while the window paints. The boot sequence minimizes ONCE at
    # the end (one visible window that sets things up, then gets out of the way).
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


def _aiexe_browser_lost_error(error):
    if isinstance(error, (NoSuchWindowException, InvalidSessionIdException)):
        return True
    msg = str(error).lower()
    return any(s in msg for s in (
        "no such window",
        "target window already closed",
        "web view not found",
        "invalid session id",
        "disconnected",
    ))


def _aiexe_driver_alive(active_driver):
    try:
        if not active_driver or isinstance(active_driver, dict):
            return False
        active_driver.execute_script("return 1")
        return True
    except WebDriverException as error:
        if _aiexe_browser_lost_error(error):
            return False
        raise
    except Exception:
        return False


def _aiexe_reopen_driver(reason):
    global driver, AIEXE_MODELS_CACHE
    print("AIEXE_BROWSER restarting Venice browser: %s" % reason, flush=True)
    try:
        old_driver = driver
        if old_driver and not isinstance(old_driver, dict):
            old_driver.quit()
    except Exception:
        pass
    driver = login_to_venice()
    try:
        scraped = aiexe_scrape_models_with_restore(driver)
        if scraped:
            AIEXE_MODELS_CACHE = scraped
            print("AIEXE_MODELS scraped after browser restart: %d models" % len(scraped), flush=True)
    except Exception as error:
        print("AIEXE_MODELS scrape after browser restart failed: %s" % error, flush=True)
    try:
        _aiexe_read_credits(driver)
    except Exception:
        pass
    _aiexe_cleanup_transient_ui(driver, "browser restart ready")
    try:  # restart done — same single-minimize rule as boot
        driver.minimize_window()
    except Exception:
        pass
    return driver


def inject_request_interceptor(driver, api_data_json, swap_body=True):
    # On attachment turns we still capture the stream but must NOT clobber Venice's native
    # request body (it carries the parsed-file references) — swap_body=False keeps the body.
    swap_js = "true" if swap_body else "false"
    script = f"""
    window.streamComplete = false;
    window.receivedChunks = [];
    window.__aiexe_urls = [];
    (function(original) {{
      const apiData = {api_data_json};
      const swapBody = {swap_js};
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
          if (swapBody && init && init.body) {{
            let body = JSON.parse(init.body);
            try {{ window.__aiexe_body_keys = Object.keys(body).join(','); }} catch (e) {{}}
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
AIEXE_CURRENT_MODEL = ""   # last model name observed on Venice's composer button (cache — no selenium)

# --- Per-chat Venice conversation mapping -----------------------------------
# One Venice conversation per AI.EXE chat (chat turns AND agent planner/decision/narration
# calls share it): no more new-chat-per-request churn, no sidebar pollution, and most
# requests need ZERO navigation. Correctness never depends on this — AI.EXE sends the full
# context in every prompt — so every step is best-effort.
AIEXE_CHAT_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aiexe_chat_map.json")
AIEXE_CHAT_URLS = {}
AIEXE_LAST_REQUEST_TS = time.time()
# Attachment IDs already uploaded to each Venice thread (dedupe: full history re-sends every
# turn, but an attachment stays pinned to the conversation — upload once, never again).
AIEXE_THREAD_ATTACHMENTS = {}
# Set true for a request once we upload files; the reply then prefers the DOM (worker transport).
AIEXE_LAST_TURN_HAD_UPLOAD = False
# Last name we pushed to each Venice conversation (rename only when it actually changes).
AIEXE_THREAD_NAMED = {}
# Cancel requests from AI.EXE's pause/stop button. The running Selenium loop owns the driver
# lock, so HTTP cancel routes set this flag and the loop clicks Venice's Stop button itself.
AIEXE_CANCEL_KEYS = set()


def _aiexe_stable_chat_url(url):
    """True for a materialized conversation URL like /chat/classic/<slug> (not ?refreshId=…)."""
    return re.search(r"venice\.ai/chat/classic/[A-Za-z0-9_-]+(?:$|[?#])", str(url or "")) is not None


def _aiexe_load_chat_map():
    global AIEXE_CHAT_URLS
    try:
        with open(AIEXE_CHAT_MAP_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            AIEXE_CHAT_URLS = {str(k): str(v) for k, v in data.items() if k and _aiexe_stable_chat_url(v)}
    except Exception:
        AIEXE_CHAT_URLS = {}


def _aiexe_save_chat_map():
    try:
        with open(AIEXE_CHAT_MAP_PATH, "w", encoding="utf-8") as fh:
            json.dump(AIEXE_CHAT_URLS, fh, indent=1, sort_keys=True)
    except Exception:
        pass


def _aiexe_chat_key(data):
    """Stable per-AI.EXE-chat key: the chat id AI.EXE sends (preferred), else a hash of the
    first user turn embedded in the flattened prompt (legacy clients)."""
    if not isinstance(data, dict):
        return ""
    for k in ("aiexe_chat_id", "chat_id"):
        v = str(data.get(k) or "").strip()
        if v:
            return "id:" + v[:120]
        opts = data.get("options")
        if isinstance(opts, dict):
            v = str(opts.get(k) or "").strip()
            if v:
                return "id:" + v[:120]
    try:
        texts = [str(m.get("content") or "") for m in (data.get("messages") or [])
                 if isinstance(m, dict) and str(m.get("role") or "").lower() == "user"]
        source = "\n".join(texts)
        m = re.search(r"<\|im_start\|>user\n([\s\S]*?)\n<\|im_end\|>", source)
        basis = (m.group(1) if m else source).strip()
        if not basis:
            return ""
        return "hist:" + hashlib.sha256(basis[:4000].encode("utf-8", "ignore")).hexdigest()[:24]
    except Exception:
        return ""


def _aiexe_cancel_key_requested(key):
    return bool(key and key in AIEXE_CANCEL_KEYS) or "__all__" in AIEXE_CANCEL_KEYS


def _aiexe_clear_cancel_key(key):
    if key:
        AIEXE_CANCEL_KEYS.discard(key)
    AIEXE_CANCEL_KEYS.discard("__all__")


def _aiexe_request_cancel(key):
    if key:
        AIEXE_CANCEL_KEYS.add(key)
    else:
        AIEXE_CANCEL_KEYS.add("__all__")


def _aiexe_stop_generation(driver, reason=""):
    """Click Venice's active Stop control. Best-effort and safe when no generation is active."""
    clicked = False
    try:
        for _b in driver.find_elements(By.XPATH, VC_STOP_GENERATING_XPATH):
            try:
                if _b.is_displayed():
                    driver.execute_script("arguments[0].click();", _b)
                    clicked = True
                    break
            except Exception:
                pass
    except Exception:
        pass
    if not clicked:
        try:
            clicked = bool(driver.execute_script("""
              const visible = (el) => {
                if (!el) return false;
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
              };
              const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
              const stop = buttons.find((b) => {
                const label = String(b.getAttribute('aria-label') || '').trim();
                const text = String(b.innerText || b.textContent || '').trim();
                return /(stop|cancel|generating)/i.test(label) || /^stop$/i.test(text);
              });
              if (!stop) return false;
              stop.click();
              return true;
            """))
        except Exception:
            clicked = False
    if clicked:
        time.sleep(0.45)
        print("AIEXE_CANCEL clicked Venice stop%s" % ((" (" + reason + ")") if reason else ""), flush=True)
    else:
        print("AIEXE_CANCEL no Venice stop button visible%s" % ((" (" + reason + ")") if reason else ""), flush=True)
    return clicked


AIEXE_TEXT_MODEL_CATALOG = [
    "Claude Sonnet 5", "GLM 5.2", "Kimi K2.7 Code", "MiniMax M3 Preview", "MiMo-V2.5",
    "Claude Fable 5", "NVIDIA Nemotron 3 Ultra", "Qwen 3.7 Plus", "Claude Opus 4.8",
    "Claude Opus 4.8 Fast", "Gemma 4 26B A4B Uncensored", "Qwen3.6 35B A3B Uncensored",
    "Qwen 3.7 Max", "Gemini 3.5 Flash", "Grok Build 0.1", "Qwen 3.6 35B A3B FP8",
    "Gemma 4 31B Instruct", "Claude Opus 4.7 Fast", "Qwen 3.6 27B", "DeepSeek V4 Pro",
    "DeepSeek V4 Flash", "GPT-5.5 Pro", "GLM 5.1", "GPT-5.5", "Kimi K2.6", "Grok 4.3",
    "Claude Opus 4.7", "Gemma 4 Uncensored", "Qwen 3.6 Plus Uncensored",
    "Google Gemma 4 31B Instruct", "Google Gemma 4 26B A4B Instruct", "GLM 5V Turbo",
    "Venice Uncensored 1.2", "GPT-5.4 Mini", "Aion 2.0", "Nemotron Cascade 2 30B A3B",
    "MiniMax M2.7", "Venice Uncensored 1.1", "Gemma 3 27B", "GLM 4.7", "GPT OSS 20B",
    "GPT OSS 120B", "Qwen 2.5 7B", "Qwen3 30B A3B", "Qwen3 VL 30B A3B",
    "Mistral Small 4", "GLM 5 Turbo", "Grok 4.20", "Grok 4.20 Multi-Agent",
    "Qwen 3.5 9B", "GPT-5.4", "GPT-5.4 Pro", "GPT-4o", "GPT-4o Mini",
    "Qwen 3.5 35B A3B", "GPT-5.3 Codex", "Venice Role Play Uncensored", "Mercury 2",
    "Gemini 3.1 Pro Preview", "Claude Sonnet 4.6", "Qwen 3.5 397B", "MiniMax M2.5",
    "GLM 5", "Claude Opus 4.6", "GLM 4.7 Flash Heretic", "GLM 4.7 Flash", "Kimi K2.5",
    "Qwen 3 Coder 480B Turbo", "NVIDIA Nemotron 3 Nano 30B", "Qwen3 VL 235B",
    "GLM 4.7 Reasoning", "Gemini 3 Flash Preview", "GPT-5.2", "Claude Opus 4.5",
    "DeepSeek V3.2", "Claude Sonnet 4.5", "GPT-5.2 Codex", "GLM 4.6",
]
AIEXE_FALLBACK_MODELS = _vcfg('FALLBACK_MODELS', AIEXE_TEXT_MODEL_CATALOG)


def _aiexe_model_catalog():
    names = []
    for source in (AIEXE_MODELS_CACHE, AIEXE_FALLBACK_MODELS):
        for name in source or []:
            if name and name not in names:
                names.append(name)
    return names


AIEXE_SETTINGS_DONE = set()   # chat keys whose Venice per-chat settings were already normalized
AIEXE_SEEN_CHUNK_SHAPES = set()   # textless chunk shapes already logged (dedup)
AIEXE_PRICED_MODELS = set()   # model names whose picker row shows Venice's coin icon (credit-metered)
AIEXE_PRICED_CHECKED_MODELS = set()   # model rows already inspected for the coin icon
AIEXE_CREDITS = ""            # last credit-balance text read from the sidebar ("10,279 Credits")
AIEXE_CREDITS_TRUSTED = False  # True = came from the real sidebar/menu <p>, not a page-text regex guess


def _aiexe_set_switch(driver, label, want_on):
    """Flip one labeled switch in Venice's per-chat Settings dialog (must be open).
    Skips disabled switches (e.g. Reasoning on forced-reasoning models). Best-effort."""
    try:
        sw = driver.find_element(By.XPATH, VC_CHAT_SETTINGS_SWITCH_XPATH.format(label))
    except Exception:
        print("AIEXE_SETTINGS switch %r not found" % label, flush=True)
        return
    try:
        if sw.get_attribute("disabled") is not None or sw.get_attribute("aria-disabled") == "true":
            print("AIEXE_SETTINGS %r is locked by Venice (cannot change)" % label, flush=True)
            return
        is_on = (sw.get_attribute("aria-checked") == "true") or bool(sw.get_attribute("checked"))
        if bool(want_on) != is_on:
            driver.execute_script(
                "arguments[0].closest('label').querySelector('.chakra-switch__track').click();", sw)
            time.sleep(0.3)
            print("AIEXE_SETTINGS %r -> %s" % (label, "on" if want_on else "off"), flush=True)
    except Exception as _e:
        print("AIEXE_SETTINGS %r error: %s" % (label, str(_e)[:120]), flush=True)


def _aiexe_normalize_chat_settings(driver, keep_reasoning=False):
    """Open Venice's per-chat Settings and turn OFF what hurts the adapter: Web Enabled
    (agent JSON decisions were doing live web searches — '10 Citations' — pure latency),
    URL Scraping, and Reasoning unless AI.EXE's Think mode asked for it. Fully guarded."""
    try:
        btn = None
        for b in driver.find_elements(By.XPATH, VC_CHAT_SETTINGS_BUTTON_XPATH):
            if b.is_displayed():
                btn = b
                break
        if btn is None:
            print("AIEXE_SETTINGS button not found", flush=True)
            return
        driver.execute_script("arguments[0].click();", btn)
        time.sleep(0.8)
        _aiexe_set_switch(driver, "Web Enabled", False)
        _aiexe_set_switch(driver, "URL Scraping", False)
        _aiexe_set_switch(driver, "Reasoning", bool(keep_reasoning))
        _aiexe_dismiss_modal(driver)
        time.sleep(0.3)
    except Exception as _e:
        print("AIEXE_SETTINGS error: %s" % str(_e)[:150], flush=True)
        try:
            _aiexe_dismiss_modal(driver)
        except Exception:
            pass


def _aiexe_set_native_value(driver, el, text, proto="HTMLTextAreaElement"):
    """Set a React/Chakra-controlled field's value via the native prototype setter + input
    event (plain send_keys doesn't always register). Used for the composer and search box."""
    driver.execute_script(
        "var el=arguments[0], v=arguments[1], p=arguments[2];"
        "var d=Object.getOwnPropertyDescriptor(window[p].prototype,'value');"
        "(d&&d.set?d.set:function(x){el.value=x;}).call(el, v);"
        "el.dispatchEvent(new Event('input', {bubbles:true}));", el, text, proto)


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
    known = [m.lower() for m in _aiexe_model_catalog()]
    try:
        for b in driver.find_elements(By.TAG_NAME, "button"):
            try:
                t = (b.text or "").strip().lower()
                short = t.replace("...", "").replace("…", "").strip()
                if t and b.is_displayed() and any(
                    t == k
                    or (k in t and len(t) <= len(k) + 14)
                    or (len(short) >= 4 and k.startswith(short))
                    for k in known
                ):
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
                short = t.replace("...", "").replace("…", "").strip()
                if t and el.is_displayed() and (
                    t in known or any(len(short) >= 4 and k.startswith(short) for k in known)
                ):
                    return el.find_element(By.XPATH, "./ancestor::button[1]")
            except Exception:
                pass
    except Exception:
        pass
    return None


def _aiexe_current_model(driver):
    """Name of the currently-selected model (from the model button), or ''. First line
    only — the button text can carry badge suffixes like 'GLM 5.2\\nTEE', which made the
    same-model check fail and re-open the picker modal on every request."""
    b = _aiexe_model_button(driver)
    try:
        return (b.text or "").strip().split("\n")[0].strip() if b is not None else ""
    except Exception:
        return ""


def _aiexe_open_model_modal(driver):
    try:
        if driver.execute_script("return !!document.querySelector('.model-switcher-scroll-container, [class*=\"model-switcher-scroll-container\"] p[title], [role=\"dialog\"] p[title]');"):
            return True
    except Exception:
        pass
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
        time.sleep(0.15)
    except Exception:
        pass
    for _ in range(4):
        try:
            if not driver.execute_script("return !!document.querySelector('[role=\"dialog\"], .chakra-modal__content');"):
                break
        except Exception:
            pass
        clicked = False
        try:
            buttons = driver.find_elements(By.XPATH, VC_CLOSE_BUTTON_XPATH)
            for b in buttons:
                try:
                    if b.is_displayed():
                        driver.execute_script("arguments[0].click();", b)
                        clicked = True
                        time.sleep(0.25)
                        break
                except Exception:
                    pass
        except Exception:
            pass
        if not clicked:
            try:
                driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
                time.sleep(0.2)
            except Exception:
                break
    try:
        # Chakra's model picker sometimes has no visible close button; clicking the modal
        # container/backdrop or sending one final ESC after focus moved out closes it.
        driver.execute_script("""
          const container = document.querySelector('.chakra-modal__content-container, [class*="modal__content-container"]');
          const dialog = document.querySelector('[role="dialog"], .chakra-modal__content');
          if (container && dialog) {
            const r = dialog.getBoundingClientRect();
            const x = Math.max(8, Math.min(window.innerWidth - 8, r.left - 12));
            const y = Math.max(8, Math.min(window.innerHeight - 8, r.top + 12));
            const el = document.elementFromPoint(x, y) || container;
            el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, clientY:y}));
            el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:x, clientY:y}));
            el.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:x, clientY:y}));
          }
        """)
        time.sleep(0.15)
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.15)
    except Exception:
        pass


def _aiexe_close_modal(driver):
    _aiexe_dismiss_modal(driver)


def _aiexe_cleanup_transient_ui(driver, reason=""):
    """Leave Venice on a clean composer surface after adapter-driven startup/scrape actions."""
    try:
        _aiexe_dismiss_modal(driver)
    except Exception:
        pass
    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.15)
    except Exception:
        pass
    try:
        driver.execute_script("""
          const visible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          for (const b of Array.from(document.querySelectorAll('button')).filter(visible)) {
            const label = String(b.getAttribute('aria-label') || '').trim();
            if (/^(hide|close|collapse)\\s+sidebar$/i.test(label)) {
              b.click();
              break;
            }
          }
        """)
    except Exception:
        pass
    try:
        if driver.execute_script("return !!document.querySelector('[role=\"dialog\"], .chakra-modal__content');"):
            print("AIEXE_UI cleanup left a modal open%s" % ((" (" + reason + ")") if reason else ""), flush=True)
        else:
            print("AIEXE_UI cleanup complete%s" % ((" (" + reason + ")") if reason else ""), flush=True)
    except Exception:
        pass


def _aiexe_model_titles(driver):
    """Model names from the visible picker rows. Also records which rows carry Venice's
    coin icon (= the model debits credits per use) into AIEXE_PRICED_MODELS."""
    names = []
    for p in driver.find_elements(By.CSS_SELECTOR, VC_MODEL_ROW_TITLE_CSS):
        try:
            t = (p.get_attribute("title") or "").strip()
        except Exception:
            t = ""
        if t and t not in names:
            names.append(t)
            _aiexe_note_priced_model(driver, p, t)
    return names


def _aiexe_title_has_priced_icon(driver, title_el):
    """True when the model row around title_el contains Venice's coin-stack icon.

    A shared modal ancestor contains many model titles and many coin icons, so never walk
    past the nearest model row. Otherwise a non-metered sibling can inherit another row's
    coin icon, which is how rows like GLM 5.2 were being marked incorrectly.
    """
    try:
        return bool(driver.execute_script("""
          const title = arguments[0];
          const prefix = arguments[1];
          const expected = String(title.getAttribute('title') || title.textContent || '').trim();
          const row = title.closest('[role="group"], [role="menuitem"], [role="menuitemradio"]');
          if (!row || !expected) return false;
          const titles = Array.from(row.querySelectorAll('p[title]'));
          if (titles.length !== 1) return false;
          const rowTitle = String(titles[0].getAttribute('title') || titles[0].textContent || '').trim();
          if (rowTitle !== expected) return false;
          return Array.from(row.querySelectorAll('svg path, path'))
            .some((p) => String(p.getAttribute('d') || '').startsWith(prefix));
        """, title_el, VC_PRICED_ICON_PATH_PREFIX))
    except Exception:
        return False


def _aiexe_note_priced_model(driver, title_el, name):
    try:
        if not name:
            return
        AIEXE_PRICED_CHECKED_MODELS.add(name)
        if _aiexe_title_has_priced_icon(driver, title_el):
            if name not in AIEXE_PRICED_MODELS:
                AIEXE_PRICED_MODELS.add(name)
                print("AIEXE_PRICED_MODEL %r" % name, flush=True)
    except Exception:
        pass


def _aiexe_read_credits(driver, allow_ui=True):
    """Best-effort read of the account's credit balance ('10,279 Credits' in the sidebar).
    Cached in AIEXE_CREDITS so /api/aiexe/state stays selenium-free.
    allow_ui=False = passive only: read what's already on screen, never click the
    sidebar/account menu open (used post-reply on non-metered models)."""
    global AIEXE_CREDITS, AIEXE_CREDITS_TRUSTED
    if allow_ui:
        try:
            _aiexe_dismiss_modal(driver)
        except Exception:
            pass

    def _capture_visible_credit_text(source):
        global AIEXE_CREDITS, AIEXE_CREDITS_TRUSTED
        try:
            for p in driver.find_elements(By.XPATH, VC_CREDITS_TEXT_XPATH):
                txt = (p.text or "").strip()
                if txt and 'credit' in txt.lower() and any(ch.isdigit() for ch in txt):
                    if AIEXE_CREDITS != txt:
                        AIEXE_CREDITS = txt
                        print("AIEXE_CREDITS %s (from %s)" % (txt, source), flush=True)
                    AIEXE_CREDITS_TRUSTED = True
                    return True
        except Exception:
            pass
        return False

    if _capture_visible_credit_text("visible"):
        return
    if not allow_ui:
        # Passive fallback: scan the page text without opening anything.
        try:
            txt = driver.execute_script("""
              const root = document.body || document.documentElement;
              const text = String((root && (root.innerText || root.textContent)) || '');
              const m = text.match(/(?:^|\\b)(\\d[\\d,\\.\\s]{0,18})\\s+Credits?\\b/i);
              return m ? `${m[1].replace(/\\s+/g, '')} Credits` : '';
            """)
            txt = (txt or "").strip()
            # A page-text guess never overwrites a real sidebar/menu capture.
            if txt and any(ch.isdigit() for ch in txt) and AIEXE_CREDITS != txt and not AIEXE_CREDITS_TRUSTED:
                AIEXE_CREDITS = txt
                print("AIEXE_CREDITS %s (from page-text-passive)" % txt, flush=True)
        except Exception:
            pass
        return

    try:
        toggled = driver.execute_script("""
          const btn = Array.from(document.querySelectorAll('button'))
            .find((b) => /^(show|open|toggle)\\s+sidebar$/i.test(String(b.getAttribute('aria-label') || '').trim()));
          if (!btn) return false;
          btn.click();
          return true;
        """)
        if toggled:
            time.sleep(0.6)
            captured = _capture_visible_credit_text("sidebar")
            try:  # close the sidebar we opened — leave the UI as we found it
                driver.execute_script("""
                  const btn = Array.from(document.querySelectorAll('button'))
                    .find((b) => /^(hide|close|collapse|toggle)\\s+sidebar$/i.test(String(b.getAttribute('aria-label') || '').trim()));
                  if (btn) btn.click();
                """)
            except Exception:
                pass
            if captured:
                return
    except Exception:
        pass

    try:
        opened_account = driver.execute_script("""
          const visible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
          const accountButton = buttons.find((b) => {
            const text = String(b.innerText || b.textContent || '');
            return b.querySelector('img.chakra-avatar__img, img[alt], [class*="avatar"] img')
              && (/\\bPRO\\b/i.test(text) || /menu/i.test(String(b.className || '')) || b.hasAttribute('aria-haspopup'));
          }) || buttons.find((b) => {
            const text = String(b.innerText || b.textContent || '');
            return /\\bPRO\\b/i.test(text) && b.hasAttribute('aria-haspopup');
          });
          if (!accountButton) return false;
          accountButton.click();
          return true;
        """)
        if opened_account:
            time.sleep(0.8)
            captured = _capture_visible_credit_text("account-menu")
            try:  # close the account menu we opened so it can't block the composer
                driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
            except Exception:
                pass
            if captured:
                return
    except Exception:
        pass
    try:
        txt = driver.execute_script("""
          const root = document.body || document.documentElement;
          const text = String((root && (root.innerText || root.textContent)) || '');
          const m = text.match(/(?:^|\\b)(\\d[\\d,\\.\\s]{0,18})\\s+Credits?\\b/i);
          return m ? `${m[1].replace(/\\s+/g, '')} Credits` : '';
        """)
        txt = (txt or "").strip()
        # A page-text guess never overwrites a real sidebar/menu capture.
        if txt and any(ch.isdigit() for ch in txt) and not AIEXE_CREDITS_TRUSTED:
            if AIEXE_CREDITS != txt:
                AIEXE_CREDITS = txt
                print("AIEXE_CREDITS %s (from page-text)" % txt, flush=True)
            return
    except Exception:
        pass



def _aiexe_text_model_count(driver):
    try:
        texts = driver.execute_script("""
          return Array.from(document.querySelectorAll('button,p,div,span'))
            .map(e => String(e.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 2000);
        """) or []
        for txt in texts:
            m = re.search(r"\bText\s*[\u2022\u00b7]\s*(\d+)\b", str(txt))
            if m:
                return int(m.group(1))
    except Exception:
        pass
    return 0


def _aiexe_model_scroll_container(driver):
    try:
        el = driver.execute_script("""
          const preferred = document.querySelector('.model-switcher-scroll-container,[class*="model-switcher-scroll-container"]');
          if (preferred) return preferred;
          const candidates = Array.from(document.querySelectorAll('div'))
            .filter(e => {
              const cs = getComputedStyle(e);
              return e.offsetParent !== null
                && e.scrollHeight > e.clientHeight + 80
                && /(auto|scroll)/.test(cs.overflowY + cs.overflow);
            })
            .sort((a,b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
          return candidates[0] || null;
        """)
        if el is not None:
            return el
    except Exception:
        pass
    return None


def _aiexe_collect_models_from_modal(driver):
    """Collect model titles from Venice's virtualized model modal.

    The modal says "Text <count>", but only the visible rows exist in the DOM at once.
    Scrolling the modal is required to discover the full text-model list.
    """
    import time as _t
    expected = _aiexe_text_model_count(driver)
    names = []
    seen = set()

    def add_visible():
        for t in _aiexe_model_titles(driver):
            if t not in seen:
                seen.add(t)
                names.append(t)

    add_visible()
    scroller = _aiexe_model_scroll_container(driver)
    if scroller is not None:
        try:
            dims = driver.execute_script(
                "return {className:String(arguments[0].className||''), scrollTop:arguments[0].scrollTop, scrollHeight:arguments[0].scrollHeight, clientHeight:arguments[0].clientHeight};",
                scroller)
            print("AIEXE_MODELS scroller=%r" % dims, flush=True)
        except Exception:
            pass
        try:
            driver.execute_script("arguments[0].scrollTop = 0;", scroller)
            _t.sleep(0.25)
            add_visible()
        except Exception:
            pass
        stagnant = 0
        last_count = len(names)
        for _ in range(90):
            if expected and len(names) >= expected:
                break
            try:
                at_bottom = bool(driver.execute_script(
                    "var e=arguments[0];"
                    "e.scrollTop = Math.min(e.scrollHeight, e.scrollTop + Math.max(320, e.clientHeight * 0.85));"
                    "return e.scrollTop + e.clientHeight >= e.scrollHeight - 4;", scroller))
            except Exception:
                at_bottom = True
            _t.sleep(0.18)
            add_visible()
            if len(names) == last_count:
                stagnant += 1
            else:
                stagnant = 0
                last_count = len(names)
            if at_bottom and stagnant >= 3:
                break
    else:
        print("AIEXE_MODELS no scroll container found", flush=True)
    print("AIEXE_MODELS modal count expected=%s collected=%d" % (expected or "?", len(names)), flush=True)
    return names


def _aiexe_find_visible_model_title(driver, name):
    target = (name or "").strip().lower()
    if not target:
        return None
    rows = driver.find_elements(By.CSS_SELECTOR, VC_MODEL_ROW_TITLE_CSS)
    for p in rows:
        try:
            if (p.get_attribute("title") or "").strip().lower() == target:
                return p
        except Exception:
            pass
    for p in rows:
        try:
            if target in (p.get_attribute("title") or "").strip().lower():
                return p
        except Exception:
            pass
    return None


def _aiexe_search_input(driver):
    import time as _t
    try:
        scroller = _aiexe_model_scroll_container(driver)
        if scroller is not None:
            driver.execute_script("arguments[0].scrollTop = 0;", scroller)
            _t.sleep(0.2)
    except Exception:
        pass
    try:
        box = driver.execute_script("""
          const configured = arguments[0];
          const visible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const inputs = Array.from(document.querySelectorAll('input'));
          const matchesSearch = (el) => /search/i.test([
            el.getAttribute('placeholder') || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('name') || '',
          ].join(' '));
          let found = null;
          try { found = document.querySelector(configured); } catch (e) { found = null; }
          if (!found || !matchesSearch(found)) {
            found = inputs.find((el) => matchesSearch(el) && visible(el))
              || inputs.find((el) => matchesSearch(el));
          }
          if (found) {
            try { found.scrollIntoView({block:'center', inline:'nearest'}); } catch (e) {}
            try { found.focus(); } catch (e) {}
          }
          return found || null;
        """, VC_MODEL_SEARCH_CSS)
        if box is not None:
            return box
    except Exception:
        pass
    try:
        sbtn = driver.execute_script("""
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find((b) => /search models/i.test([
            b.innerText || '',
            b.textContent || '',
            b.getAttribute('aria-label') || '',
            b.getAttribute('title') || '',
          ].join(' '))) || null;
        """)
        if sbtn is None:
            sbtn = driver.find_element(By.XPATH, VC_MODEL_SEARCH_BUTTON_XPATH)
        driver.execute_script("arguments[0].click();", sbtn)
        _t.sleep(0.35)
    except Exception:
        pass
    for _ in range(8):
        try:
            box = driver.execute_script("""
              const inputs = Array.from(document.querySelectorAll('input'));
              const matchesSearch = (el) => /search/i.test([
                el.getAttribute('placeholder') || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('name') || '',
              ].join(' '));
              const found = inputs.find(matchesSearch) || null;
              if (found) {
                try { found.scrollIntoView({block:'center', inline:'nearest'}); } catch (e) {}
                try { found.focus(); } catch (e) {}
              }
              return found;
            """)
            if box is not None:
                return box
        except Exception:
            pass
        _t.sleep(0.25)
    try:
        diag = driver.execute_script("""
          return {
            inputs: Array.from(document.querySelectorAll('input')).map((el) => ({
              placeholder: el.getAttribute('placeholder') || '',
              aria: el.getAttribute('aria-label') || '',
              type: el.getAttribute('type') || '',
              visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            })).slice(0, 12),
            buttons: Array.from(document.querySelectorAll('button')).map((el) =>
              String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()
            ).filter(Boolean).slice(0, 30),
          };
        """)
        print("AIEXE_PRICED search input unavailable diag=%r" % diag, flush=True)
    except Exception:
        pass
    return None


def _aiexe_collect_priced_models_by_search(driver, candidates):
    """Search every known model in the already-open picker and record coin icons.

    Some Venice rows are not present in the default/recommended list or the virtualized scroll
    window. This mirrors the selection path: reveal Search models, type the model name, inspect
    the resulting row for the credit icon, then move on without clicking/selecting anything.
    """
    import time as _t
    box = _aiexe_search_input(driver)
    if box is None:
        print("AIEXE_PRICED search input unavailable", flush=True)
        return
    names = []
    for source in (candidates or [], AIEXE_FALLBACK_MODELS):
        for name in source or []:
            clean = (name or "").strip().replace(":latest", "")
            if clean and clean not in names and clean not in AIEXE_PRICED_CHECKED_MODELS:
                names.append(clean)
    checked = 0
    before = len(AIEXE_PRICED_MODELS)
    for name in names:
        try:
            _aiexe_set_native_value(driver, box, name, "HTMLInputElement")
        except Exception:
            try:
                box.clear()
                box.send_keys(name)
            except Exception:
                continue
        found = None
        for _ in range(6):
            _t.sleep(0.2)
            found = _aiexe_find_visible_model_title(driver, name)
            if found is not None:
                break
        if found is not None:
            checked += 1
            try:
                title = (found.get_attribute("title") or name).strip()
            except Exception:
                title = name
            _aiexe_note_priced_model(driver, found, title)
    try:
        _aiexe_set_native_value(driver, box, "", "HTMLInputElement")
    except Exception:
        pass
    print("AIEXE_PRICED searched=%d newly_priced=%d total=%d" %
          (checked, max(0, len(AIEXE_PRICED_MODELS) - before), len(AIEXE_PRICED_MODELS)), flush=True)


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


# --- Attachments ------------------------------------------------------------
def _aiexe_attachment_id(att):
    """Stable per-attachment id for dedupe. Prefer the app's id; else hash name+bytes."""
    if not isinstance(att, dict):
        return None
    aid = str(att.get("id") or att.get("attachment_id") or "").strip()
    if aid:
        return aid[:120]
    raw = (str(att.get("name") or "") + "|" + str(att.get("data") or att.get("dataUrl") or "")[:2000])
    return hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:24]


def _aiexe_decode_attachment(att):
    """(basename, bytes) from an attachment dict carrying base64/data-URL bytes, else None.
    Reconciles the extension with the ACTUAL bytes' mime — the app re-encodes image previews to
    JPEG, so a *.png name over JPEG bytes makes Venice reject the upload ('unable to process')."""
    try:
        name = os.path.basename(str(att.get("name") or "attachment").strip()) or "attachment"
        blob = str(att.get("data") or att.get("dataUrl") or att.get("base64") or "")
        if not blob:
            return None
        mime = str(att.get("mime") or "")
        if blob.startswith("data:"):
            head, _, rest = blob.partition(",")
            blob = rest
            m = re.match(r"data:([^;,]+)", head)
            if m:
                mime = m.group(1)
        raw = base64.b64decode(blob + "=" * (-len(blob) % 4))
        if not raw:
            return None
        ext_by_mime = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                       "image/gif": ".gif", "image/svg+xml": ".svg"}
        want = ext_by_mime.get(mime.lower(), "")
        if want and not name.lower().endswith(want):
            name = os.path.splitext(name)[0] + want
        return (name, raw)
    except Exception as exc:
        print("AIEXE_ATTACH decode failed: %s" % exc, flush=True)
        return None


def _aiexe_find_file_input(driver):
    for xp in VC_ATTACH_FILE_INPUT_XPATHS:
        try:
            el = driver.find_element(By.XPATH, xp)
            if el:
                return el
        except Exception:
            pass
    # Some composer states hide the input until the + Actions menu is opened.
    try:
        driver.find_element(By.XPATH, VC_ATTACH_ACTIONS_BUTTON_XPATH).click()
        time.sleep(0.4)
    except Exception:
        pass
    for xp in VC_ATTACH_FILE_INPUT_XPATHS:
        try:
            el = driver.find_element(By.XPATH, xp)
            if el:
                return el
        except Exception:
            pass
    return None


def _aiexe_upload_attachments(driver, attachments, uploaded):
    """Upload each not-yet-uploaded attachment onto Venice's hidden file input, ONE AT A TIME
    with a settle pause (a rapid multi-file burst makes Venice's async processing reject some).
    Waits for each card. `uploaded` is this thread's seen-id set (mutated). Returns count uploaded."""
    if not attachments:
        return 0
    n = 0
    for att in attachments:
        aid = _aiexe_attachment_id(att)
        if not aid or aid in uploaded:
            continue
        decoded = _aiexe_decode_attachment(att)
        if not decoded:
            uploaded.add(aid)  # can't decode → don't retry forever
            continue
        name, raw = decoded
        inp = _aiexe_find_file_input(driver)
        if inp is None:
            print("AIEXE_ATTACH no file input found — skipping upload", flush=True)
            return n
        tmpdir = tempfile.mkdtemp(prefix="aiexe_att_")
        path = os.path.join(tmpdir, name)
        try:
            with open(path, "wb") as fh:
                fh.write(raw)
            inp.send_keys(path)
            # Wait for THIS file's card by name (generous — slow internet makes previews lag).
            _card = VC_ATTACH_CARD_BY_NAME_XPATH.format(name, name)
            try:
                WebDriverWait(driver, 40).until(EC.presence_of_element_located((By.XPATH, _card)))
            except Exception:
                try:
                    WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.XPATH, VC_ATTACH_CARD_IMG_XPATH)))
                except Exception:
                    pass
            uploaded.add(aid)
            n += 1
            print("AIEXE_ATTACH uploaded %r (id=%s)" % (name, aid), flush=True)
            _aiexe_prune_blank_attachment_cards(driver)
            time.sleep(1.5)  # let Venice finish processing before the next upload / the submit
        except Exception as exc:
            print("AIEXE_ATTACH upload failed for %r: %s" % (name, exc), flush=True)
        finally:
            try:
                os.remove(path)
                os.rmdir(tmpdir)
            except Exception:
                pass
    return n


def _aiexe_clear_attachment_cards(driver):
    """Remove any leftover attachment cards sitting in the composer (a failed prior send, or a
    phantom upload) so this turn's message sends clean. Clicks each card's Remove button."""
    try:
        removed = 0
        for _ in range(20):  # cap — each click drops one card
            cards = driver.find_elements(By.XPATH, VC_ATTACH_CARD_REMOVE_XPATH)
            btn = next((b for b in cards if b.is_displayed()), None)
            if btn is None:
                break
            driver.execute_script("arguments[0].click();", btn)
            removed += 1
            time.sleep(0.2)
        if removed:
            print("AIEXE_ATTACH cleared %d stale composer card(s)" % removed, flush=True)
    except Exception as exc:
        print("AIEXE_ATTACH clear failed: %s" % exc, flush=True)


def _aiexe_prune_blank_attachment_cards(driver):
    """Remove Venice attachment cards that have a remove button but no preview/name.

    These blank cards keep the send button disabled. They can appear when Venice rejects an
    async upload while still leaving a placeholder card in the composer.
    """
    try:
        removed = int(driver.execute_script("""
          const visible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const cards = Array.from(document.querySelectorAll('.chakra-card, [class*="chakra-card"]'))
            .filter((card) => card.querySelector('button[aria-label="Remove"]'));
          let removed = 0;
          for (const card of cards) {
            const hasPreview = !!card.querySelector('img[src^="blob:"], img[alt], video, canvas');
            const clone = card.cloneNode(true);
            clone.querySelectorAll('button, svg').forEach((n) => n.remove());
            const label = String(clone.innerText || clone.textContent || '').trim();
            if (!hasPreview && !label) {
              const btn = card.querySelector('button[aria-label="Remove"]');
              if (btn && visible(btn)) {
                btn.click();
                removed += 1;
              }
            }
          }
          return removed;
        """) or 0)
        if removed:
            time.sleep(0.35)
            print("AIEXE_ATTACH pruned %d blank composer card(s)" % removed, flush=True)
        return removed
    except Exception as exc:
        print("AIEXE_ATTACH blank-card prune failed: %s" % exc, flush=True)
        return 0


def _aiexe_wait_send_ready(driver, timeout_s=45):
    """Wait until the composer can submit, pruning blank upload cards while Venice settles."""
    deadline = time.time() + max(1, float(timeout_s or 0))
    while time.time() < deadline:
        _aiexe_prune_blank_attachment_cards(driver)
        try:
            for xp in VC_SEND_BUTTON_XPATHS:
                try:
                    btn = driver.find_element(By.XPATH, xp)
                    if btn.is_displayed() and btn.is_enabled():
                        return True
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(0.5)
    print("AIEXE_SEND button still disabled after attachment/prompt settle wait", flush=True)
    return False


def _aiexe_strip_reply_chrome(text):
    """Remove Venice page chrome accidentally captured by DOM fallback."""
    lines = str(text or "").splitlines()

    def duration_line(value):
        return re.match(r"^\s*[\u00b7\u2022]?\s*\d+(?:\.\d+)?s\s*$", str(value or ""), re.I) is not None

    def provider_line(value):
        t = str(value or "").strip()
        if re.match(r"^(?:Qwen|Claude|GPT|Gemini|Grok|DeepSeek|Kimi|GLM|MiniMax|NVIDIA|Mistral|Llama|Venice|Gemma|Aion|Mercury)\b.{0,140}\b\d+(?:\.\d+)?s\b", t, re.I):
            return True
        return re.match(r"^(?:Qwen|Claude|GPT|Gemini|Grok|DeepSeek|Kimi|GLM|MiniMax|NVIDIA|Mistral|Llama|Venice|Gemma|Aion|Mercury)\b.{0,120}(?:Turbo|Coder|Pro|Flash|Preview|Opus|Sonnet|Fable|Instruct|Uncensored|Reasoning|VL|A3B|FP8|Nano|Ultra|Mini|Max|V\d|[0-9]{1,4}B)\s*$", t, re.I) is not None

    kept = []
    for idx, line in enumerate(lines):
        t = line.strip()
        if not t:
            kept.append(line)
            continue
        prev_line = lines[idx - 1] if idx > 0 else ""
        next_line = lines[idx + 1] if idx + 1 < len(lines) else ""
        if duration_line(t) and (provider_line(prev_line) or provider_line(next_line)):
            continue
        if provider_line(t) and (re.search(r"\b\d+(?:\.\d+)?s\b", t, re.I) or duration_line(prev_line) or duration_line(next_line)):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def _aiexe_read_last_assistant_text(driver):
    """Read only the latest Venice assistant message body.

    This avoids page/header chrome leaks like model name + timing by targeting the
    assistant message DOM node, then its inner prose/body node. It intentionally avoids
    provider-name regex stripping because model names can appear legitimately in replies.
    """
    try:
        text = driver.execute_script("""
          const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();

          const visible = (el) => {
            if (!el || !(el instanceof Element)) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none'
              && cs.visibility !== 'hidden'
              && r.width > 0
              && r.height > 0;
          };

          const stripControls = (node) => {
            const clone = node.cloneNode(true);
            clone.querySelectorAll([
              'button',
              'svg',
              '[role="button"]',
              '[aria-label]',
              '[data-testid*="copy" i]',
              '[data-testid*="action" i]',
              '[data-testid*="menu" i]',
              '[data-testid*="toolbar" i]'
            ].join(',')).forEach((n) => n.remove());
            return clean(clone.innerText || clone.textContent || '');
          };

          const assistantSelector = [
            'div.assistant[data-testid="text-chat-message"]',
            '[data-testid="text-chat-message"].assistant'
          ].join(',');

          const latest =
            document.querySelector('div.assistant[data-testid="text-chat-message"][data-latest-message="true"]')
            || Array.from(document.querySelectorAll(assistantSelector)).filter(visible).at(-1);

          if (latest) {
            const body =
              latest.querySelector('[class*="prose"], [class*="whitespace-normal"]')
              || latest.querySelector('p, [data-message-content], [class*="markdown"]')
              || latest;

            const bodyText = stripControls(body);
            if (bodyText) return bodyText;

            const latestText = stripControls(latest);
            if (latestText) return latestText;
          }

          // Last-resort structural fallback for older Venice markup.
          // Still avoid document.body/main-page scraping.
          const userMarker = arguments[0] || "[data-testid='user-message']";
          const roots = Array.from(document.querySelectorAll('div[data-message-id], article'))
            .filter(visible)
            .filter((root) => !root.querySelector(userMarker));

          const root = roots.at(-1);
          if (!root) return '';

          const fallbackBody =
            root.querySelector('[class*="prose"], [class*="whitespace-normal"], p, [data-message-content], [class*="markdown"]')
            || root;

          return stripControls(fallbackBody);
        """, VC_USER_MESSAGE_MARKER_CSS) or ""
        return str(text or "").strip()
    except Exception:
        return ""


# --- Sidebar: rename / delete / cleanup -------------------------------------
def _aiexe_open_sidebar(driver):
    try:
        for b in driver.find_elements(By.XPATH, VC_SIDEBAR_TOGGLE_XPATH):
            if b.is_displayed() and (b.get_attribute("aria-label") or "") == "Show Sidebar":
                driver.execute_script("arguments[0].click();", b)
                time.sleep(0.4)
                return True
    except Exception:
        pass
    return False


def _aiexe_close_sidebar(driver):
    try:
        for b in driver.find_elements(By.XPATH, VC_SIDEBAR_TOGGLE_XPATH):
            if b.is_displayed() and (b.get_attribute("aria-label") or "") == "Toggle sidebar":
                driver.execute_script("arguments[0].click();", b)
                time.sleep(0.3)
                return True
    except Exception:
        pass
    return False


def _aiexe_sidebar_row(driver, slug, tries=12):
    """Find the sidebar row for `slug`, retrying — the list is server-fetched and can lag on
    slow internet, and a just-opened sidebar may still be rendering. Scrolls it into view."""
    if not slug:
        return None
    for _ in range(max(1, tries)):
        try:
            row = driver.find_element(By.XPATH, VC_SIDEBAR_CHAT_ROW_XPATH.format(slug))
            if row is not None:
                try:
                    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", row)
                except Exception:
                    pass
                return row
        except Exception:
            pass
        time.sleep(0.5)
    return None


def _aiexe_slug_from_url(url):
    m = re.search(r"/chat/classic/([A-Za-z0-9_-]+)", str(url or ""))
    return m.group(1) if m else ""


def _aiexe_sidebar_diag(driver, slug, label):
    """One log line answering WHY a sidebar row lookup failed: rowless list vs
    missing toggle vs unexpected page/window state."""
    try:
        anchors = len(driver.find_elements(By.XPATH, VC_SIDEBAR_CHAT_ROW_ANY_XPATH))
        toggles = [(b.get_attribute("aria-label") or "") for b in
                   driver.find_elements(By.XPATH, VC_SIDEBAR_TOGGLE_XPATH) if b.is_displayed()]
        rect = driver.get_window_rect()
        print("AIEXE_%s row-miss slug=%s url=%s rect=%s rows=%d toggles=%s" % (
            label, slug, driver.current_url, rect, anchors, toggles), flush=True)
        detail = driver.execute_script("""
          return Array.from(document.querySelectorAll("a[href*='/chat/classic/']")).slice(0, 6).map(a => {
            const chain = []; let e = a;
            for (let i = 0; i < 5 && e; i += 1) {
              e = e.parentElement;
              if (e) chain.push(e.tagName + (e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : ''));
            }
            return { href: a.getAttribute('href'), chain: chain.join('>') };
          });
        """) or []
        for d in detail:
            print("AIEXE_%s row-miss anchor href=%s chain=%s" % (label, d.get('href'), d.get('chain')), flush=True)
    except Exception as exc:
        print("AIEXE_%s row-miss diag failed: %s" % (label, exc), flush=True)


def _aiexe_row_action_button(driver, row, xpath):
    """Row action buttons (Rename/Delete) are only rendered on the hovered or active
    row; hover first, then look."""
    try:
        ActionChains(driver).move_to_element(row).perform()
        time.sleep(0.3)
    except Exception:
        pass
    try:
        return row.find_element(By.XPATH, xpath)
    except Exception:
        return None


def _aiexe_row_via_thread_nav(driver, slug, label):
    """Virtualized sidebar can omit a row entirely; opening the thread itself makes it
    the active conversation, which Venice always renders in the list."""
    if not slug:
        return None
    try:
        if driver.execute_script("return document.hidden === true"):
            print("AIEXE_%s thread-nav skipped (window hidden, paint throttled)" % label, flush=True)
            return None
    except Exception:
        pass
    try:
        driver.get("%s/%s" % (VC_CHAT_URL, slug))
        try:
            WebDriverWait(driver, selenium_timeout).until(
                lambda d: d.find_elements(By.XPATH, VC_SIDEBAR_TOGGLE_XPATH)
                or d.find_elements(By.XPATH, VC_SIDEBAR_CHAT_ROW_ANY_XPATH))
        except Exception:
            pass
        time.sleep(1.0)
        _aiexe_open_sidebar(driver)
        row = _aiexe_sidebar_row(driver, slug, tries=10)
        print("AIEXE_%s thread-nav fallback -> %s" % (label, bool(row)), flush=True)
        return row
    except Exception as exc:
        print("AIEXE_%s thread-nav fallback failed: %s" % (label, exc), flush=True)
        return None


def _aiexe_requested_chat_name(data):
    if not isinstance(data, dict):
        return ""
    name = str(data.get("aiexe_chat_name") or data.get("chat_name") or "").strip()
    if not name and isinstance(data.get("options"), dict):
        name = str(data["options"].get("aiexe_chat_name") or data["options"].get("chat_name") or "").strip()
    if not name or re.match(r"^(new chat|untitled chat|untitled)$", name, re.I):
        return ""
    return name[:80]


def _aiexe_rename_chat(driver, slug, name):
    """Rename a Venice conversation row to `name`. Best-effort, guarded, cleans up after."""
    name = (name or "").strip()
    if not name:
        return False
    opened = _aiexe_open_sidebar(driver)
    ok = False
    try:
        row = _aiexe_sidebar_row(driver, slug)
        if row is None:
            _aiexe_sidebar_diag(driver, slug, "RENAME")
            row = _aiexe_row_via_thread_nav(driver, slug, "RENAME")
        if row is None:
            return False
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", row)
        btn = _aiexe_row_action_button(driver, row, VC_CHAT_RENAME_BUTTON_XPATH)
        if btn is None and _aiexe_slug_from_url(driver.current_url) != slug:
            # Inactive rows can stay buttonless even hovered; opening the thread
            # makes it the active row, which always carries its action buttons.
            row = _aiexe_row_via_thread_nav(driver, slug, "RENAME")
            if row is not None:
                btn = _aiexe_row_action_button(driver, row, VC_CHAT_RENAME_BUTTON_XPATH)
        if btn is None:
            print("AIEXE_RENAME no Rename button on row %s" % slug, flush=True)
            return False
        driver.execute_script("arguments[0].click();", btn)
        inp = WebDriverWait(driver, selenium_timeout).until(
            EC.presence_of_element_located((By.XPATH, VC_CHAT_RENAME_INPUT_XPATH)))
        _aiexe_set_native_value(driver, inp, name, proto="HTMLInputElement")
        driver.find_element(By.XPATH, VC_CHAT_RENAME_CONFIRM_XPATH).click()
        time.sleep(0.3)
        ok = True
        print("AIEXE_RENAME %s -> %r" % (slug, name), flush=True)
    except Exception as exc:
        print("AIEXE_RENAME failed for %s: %s" % (slug, exc), flush=True)
        try:
            driver.find_element(By.XPATH, VC_CHAT_RENAME_CANCEL_XPATH).click()
        except Exception:
            pass
    finally:
        if opened:
            _aiexe_close_sidebar(driver)
    return ok


def _aiexe_sidebar_op_with_restore(driver, op, label):
    """Run a sidebar operation; if it fails, restore the window and retry once, then
    re-minimize. A minimized Chrome often leaves the virtualized sidebar rowless
    (same failure mode as the model picker), so rename/delete silently no-op'd in
    the background until the window was restored."""
    ok = False
    try:
        ok = bool(op())
    except Exception:
        ok = False
    if ok:
        return True
    print("AIEXE_%s failed while minimized — restoring window for one retry" % label, flush=True)
    if not _aiexe_restore_unobtrusive(driver):
        return False
    time.sleep(0.8)
    try:
        ok = bool(op())
    except Exception:
        ok = False
    finally:
        try:
            driver.minimize_window()
        except Exception:
            pass
    print("AIEXE_%s retry with restored window -> %s" % (label, ok), flush=True)
    return ok


def _aiexe_delete_chat(driver, slug):
    """Delete a Venice conversation (irreversible — only on an explicit AI.EXE chat delete)."""
    if not slug:
        return False
    opened = _aiexe_open_sidebar(driver)
    ok = False
    try:
        row = _aiexe_sidebar_row(driver, slug)
        if row is None:
            _aiexe_sidebar_diag(driver, slug, "DELETE")
            row = _aiexe_row_via_thread_nav(driver, slug, "DELETE")
        if row is None:
            return False
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", row)
        btn = _aiexe_row_action_button(driver, row, VC_CHAT_DELETE_BUTTON_XPATH)
        if btn is None and _aiexe_slug_from_url(driver.current_url) != slug:
            row = _aiexe_row_via_thread_nav(driver, slug, "DELETE")
            if row is not None:
                btn = _aiexe_row_action_button(driver, row, VC_CHAT_DELETE_BUTTON_XPATH)
        if btn is None:
            print("AIEXE_DELETE no Delete button on row %s" % slug, flush=True)
            return False
        driver.execute_script("arguments[0].click();", btn)
        confirm = WebDriverWait(driver, selenium_timeout).until(
            EC.element_to_be_clickable((By.XPATH, VC_CHAT_DELETE_CONFIRM_XPATH)))
        driver.execute_script("arguments[0].click();", confirm)
        time.sleep(0.4)
        ok = True
        print("AIEXE_DELETE %s" % slug, flush=True)
    except Exception as exc:
        print("AIEXE_DELETE failed for %s: %s" % (slug, exc), flush=True)
        _aiexe_dismiss_modal(driver)
    finally:
        if opened:
            _aiexe_close_sidebar(driver)
    return ok


def aiexe_scrape_models(driver):
    """Read Venice's real model list from the picker (title attrs). Best-effort; cached once."""
    import time as _t
    global AIEXE_PRICED_MODELS, AIEXE_PRICED_CHECKED_MODELS
    try:
        AIEXE_PRICED_MODELS = set()
        AIEXE_PRICED_CHECKED_MODELS = set()
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
        names = _aiexe_collect_models_from_modal(driver)
        # Venice's catalog rarely changes: same model list as last boot -> reuse the cached
        # priced set and skip the whole per-model search sweep (it's the slow, fragile part).
        cache = _aiexe_load_model_cache()
        if names and set(names) == set(cache.get("models") or []) and cache.get("priced"):
            AIEXE_PRICED_MODELS = set(cache["priced"])
            AIEXE_PRICED_CHECKED_MODELS = set(names)
            print("AIEXE_PRICED reused cached set (%d) — catalog unchanged" % len(AIEXE_PRICED_MODELS), flush=True)
        else:
            _aiexe_collect_priced_models_by_search(driver, names)
        _aiexe_close_modal(driver)
        return names
    except Exception as exc:
        print("AIEXE_MODELS scrape exception: %s" % exc, flush=True)
        return []
    finally:
        _aiexe_cleanup_transient_ui(driver, "model scrape")


def _aiexe_restore_unobtrusive(driver):
    """Un-minimize for reliable interaction WITHOUT popping a window in the user's face:
    restore into a small window parked at the bottom-right. Keep a REAL strip of the
    window (incl. the title bar) on-screen: the old 80x60 sliver left users unable to
    drag the window back whenever a code path failed to re-minimize it."""
    try:
        dims = driver.execute_script("return [screen.width || 1440, screen.height || 900];") or [1440, 900]
        # >=1180 wide keeps Venice on desktop layout (sidebar inline, not a drawer);
        # only a 320x140 strip stays on-screen so it doesn't pop in the user's face.
        driver.set_window_rect(x=int(dims[0]) - 320, y=int(dims[1]) - 140, width=1180, height=760)
        return True
    except Exception:
        try:
            driver.maximize_window()
            return True
        except Exception:
            return False


AIEXE_MODEL_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aiexe_model_cache.json")


def _aiexe_load_model_cache():
    try:
        with open(AIEXE_MODEL_CACHE_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _aiexe_save_model_cache(models):
    try:
        with open(AIEXE_MODEL_CACHE_FILE, "w") as f:
            json.dump({"models": list(models), "priced": sorted(AIEXE_PRICED_MODELS), "ts": time.time()}, f)
    except Exception:
        pass


def aiexe_scrape_models_with_restore(driver):
    """Scrape; if empty (a minimized Chrome can still throttle paint despite the flags,
    leaving Venice's virtualized picker rowless), restore unobtrusively, retry once,
    re-minimize. Still empty after that -> the last GOOD catalog persisted on disk."""
    global AIEXE_PRICED_MODELS, AIEXE_PRICED_CHECKED_MODELS
    names = aiexe_scrape_models(driver)
    if not names:
        print("AIEXE_MODELS scrape empty while minimized — restoring window for one retry", flush=True)
        _aiexe_restore_unobtrusive(driver)
        time.sleep(1.0)
        try:
            names = aiexe_scrape_models(driver)
        finally:
            try:
                driver.minimize_window()
            except Exception:
                pass
    if names:
        _aiexe_save_model_cache(names)
        return names
    cache = _aiexe_load_model_cache()
    if cache.get("models"):
        AIEXE_PRICED_MODELS = set(cache.get("priced") or [])
        AIEXE_PRICED_CHECKED_MODELS = set(cache["models"])
        print("AIEXE_MODELS using cached catalog (%d models, %d priced) — live scrape failed"
              % (len(cache["models"]), len(AIEXE_PRICED_MODELS)), flush=True)
        return list(cache["models"])
    return []


def aiexe_select_model(driver, name):
    """Pick `name` in Venice's model modal before sending. Fully guarded — a failure just
    leaves the current model selected, never breaks the chat. Returns False only when the
    switch was NEEDED and didn't land (so the caller can retry with the window restored)."""
    import time as _t
    name = (name or "").strip()
    if not name:
        return True
    # Only drive the picker for a REAL Venice model. Legacy/mock IDs (llama-...-akash, hermes,
    # dolphin, nemotron, etc.) aren't in Venice's list — opening the modal for them finds
    # nothing and can leave a dialog over the composer, which breaks the chat. Skip them.
    known = [m.lower() for m in _aiexe_model_catalog()]
    nl = name.lower()
    if not any(nl == k or nl in k or k in nl for k in known):
        print("AIEXE_MODEL skip (not a known model): %r" % name, flush=True)
        return True
    try:
        # The model button may still be rendering right after the composer appears — wait briefly.
        for _w in range(12):
            if _aiexe_model_button(driver) is not None:
                break
            _t.sleep(0.5)
        cur = _aiexe_current_model(driver)
        global AIEXE_CURRENT_MODEL
        if cur:
            AIEXE_CURRENT_MODEL = cur
        if cur and cur.lower() == nl:
            print("AIEXE_MODEL already on %r" % name, flush=True)
            return True
        print("AIEXE_MODEL want=%r current=%r — opening picker" % (name, cur), flush=True)
        if not _aiexe_open_model_modal(driver):
            return False
        _t.sleep(0.8)
        def _find_target():
            rows = driver.find_elements(By.CSS_SELECTOR, VC_MODEL_ROW_TITLE_CSS)
            print("AIEXE_MODEL rows=%d titles=%r" % (len(rows), [(r.get_attribute("title") or "")[:24] for r in rows[:10]]), flush=True)
            for p in rows:
                if (p.get_attribute("title") or "").strip().lower() == nl:
                    return p
            for p in rows:
                if nl in (p.get_attribute("title") or "").strip().lower():
                    return p
            return None

        target = _find_target()
        if target is None:
            # The default modal shows only the ~17 "recommended" models; the other ~60 exist
            # only behind Search / "View all models". Venice's "Search models..." control is a
            # BUTTON (chakra-input styled) — click it to reveal the real <input>, then type.
            box = None
            try:
                sbtn = driver.find_element(By.XPATH, VC_MODEL_SEARCH_BUTTON_XPATH)
                driver.execute_script("arguments[0].click();", sbtn)
                _t.sleep(0.5)
            except Exception as _e:
                print("AIEXE_MODEL search button not found (%s)" % str(_e)[:120], flush=True)
            for _w in range(8):
                try:
                    box = driver.find_element(By.CSS_SELECTOR, VC_MODEL_SEARCH_CSS)
                    if box.is_displayed():
                        break
                    box = None
                except Exception:
                    box = None
                _t.sleep(0.4)
            if box is not None:
                try:
                    box.click()
                except Exception:
                    pass
                try:
                    _aiexe_set_native_value(driver, box, name, "HTMLInputElement")
                except Exception:
                    try:
                        box.clear(); box.send_keys(name)
                    except Exception:
                        pass
                print("AIEXE_MODEL searching for %r" % name, flush=True)
                for _w in range(10):
                    _t.sleep(0.5)
                    target = _find_target()
                    if target is not None:
                        break
            else:
                print("AIEXE_MODEL search input never appeared after clicking the button", flush=True)
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
            AIEXE_CURRENT_MODEL = name
            print("AIEXE_MODEL clicked %r" % name, flush=True)
            return True
        print("AIEXE_MODEL target row NOT found for %r" % name, flush=True)
        _aiexe_close_modal(driver)
        return False
    except Exception as _e:
        print("AIEXE_MODEL error: %s" % _e, flush=True)
        _aiexe_close_modal(driver)
        return False


def generate_selenium_streamed_response(data, driver, response_format=ResponseFormat.CHAT, retry_browser_restart=True):
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
    _chat_key = _aiexe_chat_key(data)
    _wanted_chat_name = _aiexe_requested_chat_name(data)
    _aiexe_clear_cancel_key(_chat_key)
    try:
        # ONE Venice conversation per AI.EXE chat (see the chat-map block up top). Nav policy:
        #   same chat + already on its conversation → no navigation at all (the common case);
        #   different chat with a known conversation  → navigate to it (deleted → new + remap);
        #   unknown chat                              → New chat (SPA), remembered after send.
        _cur_url = str(driver.current_url or "")
        _mapped = AIEXE_CHAT_URLS.get(_chat_key, "") if _chat_key else ""
        if 'venice.ai/chat' not in _cur_url:
            driver.get(_mapped or VC_CHAT_URL)   # not on Venice at all → one real load
            print("AIEXE_NAV cold load -> %s" % (_mapped or VC_CHAT_URL), flush=True)
        elif _mapped and _cur_url.split('?')[0] == _mapped.split('?')[0]:
            pass                                  # already on this chat's conversation
        elif _mapped:
            driver.get(_mapped)
            time.sleep(0.6)
            landed = str(driver.current_url or "")
            if landed.split('?')[0] != _mapped.split('?')[0]:
                # Venice deleted/lost that conversation → forget it; a new one gets mapped below.
                AIEXE_CHAT_URLS.pop(_chat_key, None)
                _aiexe_save_chat_map()
                print("AIEXE_NAV mapped chat GONE (%s) — will remap" % _mapped, flush=True)
            else:
                print("AIEXE_NAV switched to mapped chat %s" % _mapped, flush=True)
        elif _aiexe_stable_chat_url(_cur_url):
            # Unknown chat while sitting on some OTHER conversation → fresh chat (SPA click).
            try:
                _nc = driver.find_element(By.XPATH, VC_NEW_CHAT_XPATH)
                driver.execute_script("arguments[0].click();", _nc)
                time.sleep(0.5)
                print("AIEXE_NAV new chat via SPA button", flush=True)
            except Exception:
                driver.get(VC_CHAT_URL)
        # else: already on a fresh composer page — just use it
        # A previous ABORTED request (client timeout/retry) can leave Venice still generating —
        # the composer is unusable until it stops.
        _aiexe_stop_generation(driver, "new request cleanup")
        # Hide the raw typed prompt in the (minimized) Venice window — model still receives it.
        # Toggle from AI.EXE Settings (passed as AIEXE_HIDE_PROMPT env on start; default OFF).
        try:
            if os.getenv('AIEXE_HIDE_PROMPT', '0') != '0':
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
        _restored_for_ui = False
        try:
            if not aiexe_select_model(driver, request_model_id):
                # Minimized Chrome can starve the picker's virtualized rows — restore a
                # small corner window (not a face-popping maximize), retry once, and keep
                # it restored for the settings dialog below; re-minimized after.
                print("AIEXE_MODEL retrying with window restored", flush=True)
                _restored_for_ui = _aiexe_restore_unobtrusive(driver)
                time.sleep(0.8)
                aiexe_select_model(driver, request_model_id)
        except Exception:
            pass
        try:
            _aiexe_dismiss_modal(driver)  # never let a stray dialog block the composer
            # Normalize Venice's per-chat settings once per chat (and again if Think flips):
            # web search / URL scraping OFF, Reasoning follows AI.EXE's Think mode.
            try:
                _think = 'on' if str(data.get('aiexe_think') or '') == 'on' else 'off'
                _skey = "%s|%s" % (_chat_key or 'nokey', _think)
                if _chat_key and _skey not in AIEXE_SETTINGS_DONE:
                    _aiexe_normalize_chat_settings(driver, keep_reasoning=(_think == 'on'))
                    AIEXE_SETTINGS_DONE.add(_skey)
                    AIEXE_SETTINGS_DONE.discard("%s|%s" % (_chat_key, 'on' if _think == 'off' else 'off'))
            except Exception:
                pass
        finally:
            # Re-minimize even if modal/settings handling throws — a skipped minimize
            # strands the corner-parked window on the user's screen.
            if _restored_for_ui:
                try:
                    driver.minimize_window()
                except Exception:
                    pass
        # Venice SPA navigation/model-picker changes can rerender the composer. Never reuse
        # the textarea found before model selection; reacquire it right before typing.
        element = _aiexe_wait_composer(driver)

        # Upload NEW attachments for this thread before typing. Dedupe: full history re-sends
        # every turn, but Venice pins a file to the conversation — upload once, never again.
        global AIEXE_LAST_TURN_HAD_UPLOAD
        AIEXE_LAST_TURN_HAD_UPLOAD = False
        try:
            _atts = data.get('aiexe_attachments')
            if not _atts and isinstance(data.get('options'), dict):
                _atts = data['options'].get('aiexe_attachments')
            if _aiexe_cancel_key_requested(_chat_key):
                _aiexe_stop_generation(driver, "cancel before upload")
                _aiexe_clear_cancel_key(_chat_key)
                return
            # Always clear stale cards first — a prior send may have failed and left phantom
            # attachments in the composer that would ride along with (or block) this message.
            _aiexe_clear_attachment_cards(driver)
            if _atts:
                # The app only ever sends THIS turn's new attachments (old ones aren't re-sent),
                # so upload them fresh every request. A per-request set only dedupes within one
                # call; a network retry re-uploads correctly after the card-clear above.
                if _aiexe_upload_attachments(driver, _atts, set()) > 0:
                    AIEXE_LAST_TURN_HAD_UPLOAD = True
                _aiexe_prune_blank_attachment_cards(driver)
        except Exception as _e:
            print("AIEXE_ATTACH turn failed: %s" % _e, flush=True)

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
        if _aiexe_cancel_key_requested(_chat_key):
            _aiexe_stop_generation(driver, "cancel before submit")
            _aiexe_clear_cancel_key(_chat_key)
            return
        _aiexe_wait_send_ready(driver, 45 if AIEXE_LAST_TURN_HAD_UPLOAD else 8)
        if _aiexe_cancel_key_requested(_chat_key):
            _aiexe_stop_generation(driver, "cancel before send")
            _aiexe_clear_cancel_key(_chat_key)
            return

        current_url = driver.current_url

        # If we are on the main chat page, the button will navigate us to a different url first
        if current_url == 'https://venice.ai/chat':
            WebDriverWait(driver, selenium_timeout).until(
                EC.element_to_be_clickable((By.XPATH, "//button[@type='submit' and @aria-label='submit']"))
            ).click()
            WebDriverWait(driver, selenium_timeout).until(EC.url_changes(current_url))
            _aiexe_set_composer_text(driver, " ")


        inject_request_interceptor(driver, api_data_json, swap_body=not AIEXE_LAST_TURN_HAD_UPLOAD)

        _sent = _aiexe_submit_prompt(driver)
        if _aiexe_cancel_key_requested(_chat_key):
            _aiexe_stop_generation(driver, "cancel after send")
            _aiexe_clear_cancel_key(_chat_key)
            return

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
            if _aiexe_cancel_key_requested(_chat_key):
                _aiexe_stop_generation(driver, "cancel during stream")
                _aiexe_clear_cancel_key(_chat_key)
                return
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
                            if not _c:
                                # Reasoning chunks carry their text in a different field —
                                # they were silently dropped (empty `content` hit no branch),
                                # so Think mode showed nothing in the Thoughts UI.
                                for _f in ('reasoning', 'reasoningContent', 'reasoning_content',
                                           'thinking', 'thought', 'text'):
                                    _v = json_data.get(_f)
                                    if isinstance(_v, str) and _v:
                                        _c = _v
                                        if not _kind or _kind == 'content':
                                            _kind = _f
                                        break
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
                            else:
                                # No text found anywhere — log the SHAPE (keys only, once per
                                # shape) so a new Venice chunk format is visible in the log.
                                try:
                                    _shape = "%s|%s" % (_kind, ",".join(sorted(json_data.keys())))
                                    if _shape not in AIEXE_SEEN_CHUNK_SHAPES and len(json_data) > 1:
                                        AIEXE_SEEN_CHUNK_SHAPES.add(_shape)
                                        print("AIEXE_KIND textless chunk kind=%r keys=%s" % (_kind, ",".join(sorted(json_data.keys()))), flush=True)
                                except Exception:
                                    pass
                        except json.JSONDecodeError:
                            print(f"Failed to parse line: {line}")

            if driver.execute_script("return window.streamComplete;"):
                break
            # Attachment turns can stream through Venice's ConversationsWorker, which bypasses
            # our main-thread fetch interceptor (receivedChunks never fills). Don't burn the
            # full timeout — bail early to the DOM-read fallback below.
            if AIEXE_LAST_TURN_HAD_UPLOAD and eval_count == 0 and time.time() - last_data_time > 12:
                print("AIEXE_ATTACH no interceptor chunks after upload — DOM fallback", flush=True)
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

        # DOM-read fallback: interceptor caught nothing but Venice rendered a reply (worker
        # transport). Poll the last assistant bubble until it stabilizes, emit deltas.
        if eval_count == 0 and not streamed_content:
            _prev, _stable = "", 0
            for _i in range(int(max(timeout, 30) / 0.8)):
                if _aiexe_cancel_key_requested(_chat_key):
                    _aiexe_stop_generation(driver, "cancel during DOM fallback")
                    _aiexe_clear_cancel_key(_chat_key)
                    return
                _txt = _aiexe_read_last_assistant_text(driver)
                if _txt and _txt == _prev:
                    _stable += 1
                    if _stable >= 3:
                        break
                else:
                    _stable = 0
                if _txt and len(_txt) > len(_prev):
                    _delta = _txt[len(_prev):]
                    eval_count += 1
                    if response_format == ResponseFormat.CHAT_NON_STREAMED:
                        streamed_content += _delta
                    elif response_format == ResponseFormat.COMPLETION_AS_STRING:
                        yield _delta
                    else:
                        _m = _emit(_delta)
                        if _m: yield _m
                    _prev = _txt
                if driver.execute_script("return window.streamComplete;"):
                    _stable += 1
                time.sleep(0.8)
            if eval_count:
                print("AIEXE_ATTACH DOM fallback captured %d chars" % len(_prev), flush=True)

        if _reasoning_open:  # stream ended still inside a reasoning block — close it
            if response_format == ResponseFormat.CHAT_NON_STREAMED:
                streamed_content += '</thinking>'
            else:
                _m = _emit('</thinking>')
                if _m: yield _m
            _reasoning_open = False

        # Refresh the balance after the reply — but only OPEN the sidebar/account menu when
        # the model that just answered is credit-metered (the balance can't change otherwise;
        # non-metered models get a passive read of whatever is already on screen).
        try:
            _cur_l = (AIEXE_CURRENT_MODEL or "").strip().lower()
            _metered = bool(_cur_l) and any(_cur_l == m.lower() for m in AIEXE_PRICED_MODELS)
        except Exception:
            _metered = False
        _aiexe_read_credits(driver, allow_ui=_metered)
        # Diagnostic: the field names of Venice's REAL request body (captured pre-swap by the
        # interceptor) — reveals whether a reasoning/web flag exists to set per-request.
        try:
            _bk = driver.execute_script("return window.__aiexe_body_keys || ''")
            if _bk:
                print("AIEXE_BODY_KEYS %s" % _bk, flush=True)
        except Exception:
            pass
        # Remember which Venice conversation this AI.EXE chat lives in (URL materializes to
        # /chat/classic/<slug> once the first message is sent — poll briefly).
        if _chat_key:
            try:
                for _w in range(16):
                    _u = str(driver.current_url or "")
                    if _aiexe_stable_chat_url(_u):
                        if AIEXE_CHAT_URLS.get(_chat_key) != _u:
                            AIEXE_CHAT_URLS[_chat_key] = _u
                            _aiexe_save_chat_map()
                            print("AIEXE_CHAT_MAP %s -> %s" % (_chat_key[:32], _u), flush=True)
                        break
                    time.sleep(0.5)
            except Exception:
                pass

        # If AI.EXE already has a real title on a later turn, mirror it here too. The first
        # turn usually arrives as "New Chat", so the UI still calls /api/aiexe/rename_chat
        # when smart naming completes; this backend path catches missed/raced attempts.
        try:
            _slug = _aiexe_slug_from_url(AIEXE_CHAT_URLS.get(_chat_key, "")) if _chat_key else ""
            if _chat_key and _slug and _wanted_chat_name and AIEXE_THREAD_NAMED.get(_chat_key) != _wanted_chat_name:
                if _aiexe_sidebar_op_with_restore(driver, lambda: _aiexe_rename_chat(driver, _slug, _wanted_chat_name), "RENAME"):
                    AIEXE_THREAD_NAMED[_chat_key] = _wanted_chat_name
        except Exception as _e:
            print("AIEXE_RENAME deferred path failed: %s" % _e, flush=True)

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
        if retry_browser_restart and _aiexe_browser_lost_error(e):
            try:
                fresh_driver = _aiexe_reopen_driver(str(e).splitlines()[0])
                yield from generate_selenium_streamed_response(
                    data, fresh_driver, response_format=response_format, retry_browser_restart=False)
                return
            except Exception as restart_error:
                print("AIEXE_BROWSER restart failed: %s" % restart_error, flush=True)
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

def _aiexe_locked_stream(request_json, response_format, reopen_context):
    """Hold the selenium lock for the generator's ENTIRE life, not just its creation.
    `with selenium_lock: return Response(gen)` released the lock the instant the Response
    object existed while the real work (type/submit/stream-read) ran lazily OUTSIDE it —
    so an overlapping request reset the page's shared receivedChunks mid-stream and both
    requests read a mixed stream (duplicated narration; a decision call receiving another
    call's answer). A client disconnect raises GeneratorExit, which still exits the with-
    block and releases the lock."""
    global driver
    with selenium_lock:
        if not _aiexe_driver_alive(driver):
            driver = _aiexe_reopen_driver(reopen_context)
        try:
            yield from generate_selenium_streamed_response(request_json, driver, response_format=response_format)
        except GeneratorExit:
            _aiexe_request_cancel(_aiexe_chat_key(request_json))
            _aiexe_stop_generation(driver, "client disconnected")
            _aiexe_clear_cancel_key(_aiexe_chat_key(request_json))
            raise


@app.route('/api/chat', methods=['POST'])
def chat():
    global AIEXE_LAST_REQUEST_TS
    AIEXE_LAST_REQUEST_TS = time.time()
    request_json = parse_json_request(request)
    if request_json is None :
            return Response("Invalid JSON data received", status=400, content_type='text/plain')

    response_format = ResponseFormat.CHAT
    content_type = 'application/x-ndjson'

    if 'stream' in request_json and request_json['stream'] == False:
        response_format = ResponseFormat.CHAT_NON_STREAMED
        content_type = 'application/json; charset=utf-8'

    return Response(_aiexe_locked_stream(request_json, response_format,
                                         "browser session was closed before /api/chat"),
                    content_type=content_type)

@app.route('/api/aiexe/delete_chat', methods=['POST'])
def aiexe_delete_chat():
    """Delete the Venice conversation for an AI.EXE chat (called on explicit chat delete).
    Body: {aiexe_chat_id | chat_id, slug?}. Irreversible; guarded and best-effort."""
    global driver
    req = parse_json_request(request) or {}
    key = _aiexe_chat_key(req)
    slug = str(req.get('slug') or '').strip() or _aiexe_slug_from_url(AIEXE_CHAT_URLS.get(key, ''))
    if not slug:
        return Response(json.dumps({"ok": False, "reason": "no mapped Venice conversation"}),
                        content_type='application/json; charset=utf-8')
    with selenium_lock:
        if not _aiexe_driver_alive(driver):
            driver = _aiexe_reopen_driver("browser session was closed before delete_chat")
        ok = _aiexe_sidebar_op_with_restore(driver, lambda: _aiexe_delete_chat(driver, slug), "DELETE")
        if ok:
            AIEXE_CHAT_URLS.pop(key, None)
            AIEXE_THREAD_ATTACHMENTS.pop(key, None)
            AIEXE_THREAD_NAMED.pop(key, None)
            _aiexe_save_chat_map()
    return Response(json.dumps({"ok": bool(ok), "slug": slug}),
                    content_type='application/json; charset=utf-8')

@app.route('/api/aiexe/rename_chat', methods=['POST'])
def aiexe_rename_chat_route():
    """Rename the Venice conversation for an AI.EXE chat to `name`. The app calls this ONCE,
    when it applies the smart chat title (the name isn't known until after the first reply)."""
    global driver
    req = parse_json_request(request) or {}
    key = _aiexe_chat_key(req)
    name = str(req.get('name') or req.get('aiexe_chat_name') or '').strip()
    slug = str(req.get('slug') or '').strip() or _aiexe_slug_from_url(AIEXE_CHAT_URLS.get(key, ''))
    if not name or not slug:
        return Response(json.dumps({"ok": False, "reason": "missing name or mapped conversation"}),
                        content_type='application/json; charset=utf-8')
    if key and AIEXE_THREAD_NAMED.get(key) == name:
        return Response(json.dumps({"ok": True, "slug": slug, "skipped": "already named"}),
                        content_type='application/json; charset=utf-8')
    with selenium_lock:
        if not _aiexe_driver_alive(driver):
            driver = _aiexe_reopen_driver("browser session was closed before rename_chat")
        ok = _aiexe_sidebar_op_with_restore(driver, lambda: _aiexe_rename_chat(driver, slug, name[:80]), "RENAME")
        if ok and key:
            AIEXE_THREAD_NAMED[key] = name
    return Response(json.dumps({"ok": bool(ok), "slug": slug}),
                    content_type='application/json; charset=utf-8')

@app.route('/api/aiexe/stop_generation', methods=['POST'])
def aiexe_stop_generation_route():
    """Request cancellation of the active Venice browser generation.

    If Selenium is idle, click Stop immediately. If a stream owns the lock, queue a cancel flag;
    the running loop polls it and clicks Stop from inside the driver-owning section.
    """
    global driver
    req = parse_json_request(request) or {}
    key = _aiexe_chat_key(req)
    _aiexe_request_cancel(key)
    clicked = False
    immediate = False
    acquired = False
    try:
        acquired = selenium_lock.acquire(blocking=False)
        if acquired:
            immediate = True
            if _aiexe_driver_alive(driver):
                clicked = _aiexe_stop_generation(driver, "stop route")
                _aiexe_clear_cancel_key(key)
    except Exception as exc:
        print("AIEXE_CANCEL stop route failed: %s" % exc, flush=True)
    finally:
        if acquired:
            try:
                selenium_lock.release()
            except Exception:
                pass
    return Response(json.dumps({"ok": True, "queued": not immediate, "clicked": bool(clicked)}),
                    content_type='application/json; charset=utf-8')

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
    return Response(_aiexe_locked_stream(request_json, ResponseFormat.GENERATE,
                                         "browser session was closed before /api/generate"),
                    content_type='application/x-ndjson')

@app.route('/v1/chat/completions', methods=['POST'])
def openai_like_completion():
    request_json = parse_json_request(request)
    completion = ''.join(_aiexe_locked_stream(request_json, ResponseFormat.COMPLETION_AS_STRING,
                                              "browser session was closed before /v1/chat/completions"))
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

@app.route('/api/aiexe/state', methods=['GET'])
def aiexe_state():
    # Usually cached; one immediate DOM read only when NO generation holds the lock —
    # _aiexe_read_credits sends ESCAPE (Venice's stop key) and would abort a live reply.
    if not AIEXE_CREDITS and selenium_lock.acquire(blocking=False):
        try:
            _aiexe_read_credits(driver)
        except Exception:
            pass
        finally:
            selenium_lock.release()
    return Response(json.dumps({
        "current_model": AIEXE_CURRENT_MODEL,
        "credits": AIEXE_CREDITS,
        "priced_models": sorted(AIEXE_PRICED_MODELS),
    }), content_type='application/json')

@app.route('/api/aiexe/sidebar_debug', methods=['GET'])
def aiexe_sidebar_debug_route():
    """Diagnostic: what does Venice's sidebar actually contain right now? Optional ?slug=
    navigates to that thread first (answers 'does this conversation still exist?')."""
    global driver
    slug = str(request.args.get('slug') or '').strip()
    out = {}
    with selenium_lock:
        try:
            _aiexe_restore_unobtrusive(driver)
            time.sleep(0.8)
            if slug:
                driver.get("%s/%s" % (VC_CHAT_URL, slug))
                try:
                    WebDriverWait(driver, selenium_timeout).until(
                        lambda d: d.find_elements(By.XPATH, VC_SIDEBAR_TOGGLE_XPATH))
                except Exception:
                    pass
                time.sleep(1.5)
            _aiexe_open_sidebar(driver)
            out['url'] = driver.current_url
            out['timeline'] = []
            for _ in range(10):
                sample = driver.execute_script("""
                  return Array.from(document.querySelectorAll("a[href*='/chat/classic/']")).map(a => ({
                    href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 60) }));
                """) or []
                out['timeline'].append({'t': time.time(), 'count': len(sample)})
                out['rows'] = sample
                if len(sample) > 2:
                    break
                time.sleep(2.0)
            out['toggles'] = [(b.get_attribute('aria-label') or '') for b in
                              driver.find_elements(By.XPATH, VC_SIDEBAR_TOGGLE_XPATH) if b.is_displayed()]
            out['bodyPreview'] = driver.execute_script("return (document.body.innerText || '').slice(0, 400);")
        except Exception as exc:
            out['error'] = str(exc)
        finally:
            try:
                driver.minimize_window()
            except Exception:
                pass
    return Response(json.dumps(out), content_type='application/json; charset=utf-8')


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
    names = _aiexe_model_catalog()
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
# Idle gap between streamed chunks before we give up. Venice can pause mid-answer
# (reasoning / rate-limit); 20s cut long generations short and saved partial files.
# 120s fits inside the client's 300s adapter HTTP timeout.
parser.add_argument('--timeout', type=int, default=120, help='Idle timeout: max gap between streamed Venice chunks before giving up (seconds)')
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
_aiexe_load_chat_map()
driver = login_to_venice()
try:  # scrape Venice's real model list once (best-effort) so /api/tags advertises the truth
    _scraped = aiexe_scrape_models_with_restore(driver)
    if _scraped:
        AIEXE_MODELS_CACHE = _scraped
        print("AIEXE_MODELS scraped: %d models" % len(_scraped), flush=True)
except Exception as _e:
    print("AIEXE_MODELS scrape failed: " + str(_e), flush=True)
try:  # remember which model Venice is CURRENTLY on, so AI.EXE can adopt it (not pretend)
    _cur = _aiexe_current_model(driver)
    if _cur:
        AIEXE_CURRENT_MODEL = _cur
        print("AIEXE_MODEL current at startup: %r" % _cur, flush=True)
except Exception:
    pass
try:  # preselect the app's model while the window is STILL VISIBLE — a minimized
    # picker can't render rows, and the corner-restore fallback annoys the user.
    _want = (os.getenv('AIEXE_PRESELECT_MODEL') or '').replace(':latest', '').strip()
    if _want:
        print("AIEXE_MODEL preselecting %r at boot" % _want, flush=True)
        aiexe_select_model(driver, _want)
except Exception:
    pass
try:
    _aiexe_read_credits(driver)
except Exception:
    pass
_aiexe_cleanup_transient_ui(driver, "startup ready")
try:  # startup done — ONE minimize, after all window-dependent work finished
    driver.minimize_window()
except Exception:
    pass
def _aiexe_internal_cleanup_loop():
    """Idle-time sidebar hygiene: agent one-shot calls (planner, per-file gen, titles)
    each open an isolated Venice thread by design — delete them in small batches when
    the adapter has been idle, so the user's Venice sidebar isn't buried in them."""
    global driver
    while True:
        gevent.sleep(45)
        try:
            internal = [k for k in list(AIEXE_CHAT_URLS.keys()) if k.startswith("id:internal:")]
            if len(internal) < 6:
                continue
            if time.time() - AIEXE_LAST_REQUEST_TS < 90:
                continue
            if not selenium_lock.acquire(blocking=False):
                continue
            try:
                batch = internal[:3]
                print("AIEXE_CLEANUP deleting %d internal one-shot chats (%d tracked)" % (len(batch), len(internal)), flush=True)
                for key in batch:
                    slug = _aiexe_slug_from_url(AIEXE_CHAT_URLS.get(key, ""))
                    deleted = False
                    if slug:
                        try:
                            deleted = _aiexe_sidebar_op_with_restore(
                                driver, lambda s=slug: _aiexe_delete_chat(driver, s), "DELETE")
                        except Exception as exc:
                            print("AIEXE_CLEANUP delete failed for %s: %s" % (slug, exc), flush=True)
                    AIEXE_CHAT_URLS.pop(key, None)
                    print("AIEXE_CLEANUP %s -> %s" % (slug or key[:36], "deleted" if deleted else "dropped from map"), flush=True)
                _aiexe_save_chat_map()
            finally:
                selenium_lock.release()
        except Exception as exc:
            print("AIEXE_CLEANUP loop error: %s" % exc, flush=True)


print(f"Starting server at port {args.host}:{args.port}")
_aiexe_cleanup_greenlet = gevent.spawn(_aiexe_internal_cleanup_loop)
http_server = WSGIServer((args.host, args.port), app)
http_server.serve_forever()
