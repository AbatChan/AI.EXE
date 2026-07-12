"""Venice website selectors & URLs — THE place to edit when Venice changes their site.

Everything the browser adapter depends on that Venice can change (URLs, form fields, the
composer, the send button, the model picker, the streaming API path, the model list) lives
here. When a chat breaks after a Venice update, you almost always only need to fix a value
in this file — no code changes.

Selector format: (how, value) where how is one of "id" | "name" | "css" | "xpath".
Lists are tried in order; the first that matches wins. Keep older selectors as fallbacks.

This file is copied next to the adapter server on install/start. If it's missing, the server
falls back to the same values hard-coded inline, so nothing breaks.
"""

# --- URLs -------------------------------------------------------------------
SIGN_IN_URL = "https://venice.ai/sign-in"
# Classic text-chat mode. Venice's default /chat redirects to "agent" mode, whose response
# stream the interceptor can't read — classic is the interceptable one. A FRESH load of this
# URL each request keeps Venice stateless (AI.EXE sends the full history itself).
CHAT_URL = "https://venice.ai/chat/classic"

# --- Login form -------------------------------------------------------------
EMAIL_FIELDS = [
    ("id", "identifier-field"),
    ("name", "identifier"),
    ("css", "input[type='email']"),
    ("css", "input[autocomplete='username']"),
    ("css", "input[name='email']"),
]
PASSWORD_FIELDS = [
    ("id", "password-field"),
    ("css", "input[type='password']"),
]
LOGIN_SUBMIT_XPATH = "//button[@data-localization-key='formButtonPrimary' or @type='submit' or contains(., 'Continue') or contains(., 'Sign in') or contains(., 'Log in')]"
# We consider ourselves logged in once the URL leaves this path (stable across UI changes).
SIGN_IN_URL_MARKER = "/sign-in"

# --- Chat composer + send button --------------------------------------------
# The message box. Placeholder text rotates on Venice, so match structurally (any editable
# textarea) rather than by placeholder.
COMPOSER_XPATH = "//textarea[not(@readonly)]"
# Send button — tried in order. Classic mode uses aria-label "Submit chat"; agent mode used a
# data-testid. It only appears after the composer has text.
SEND_BUTTON_XPATHS = [
    "//button[@type='submit' and @aria-label='Submit chat']",
    "//button[@data-testid='minds-chat-send-button']",
    "//button[@aria-label='Send message']",
    "//button[@type='submit']",
]

# --- Model picker -----------------------------------------------------------
# The button in the composer that opens the model modal.
MODEL_BUTTON_XPATHS = [
    "//button[.//p[@data-testid='minds-chat-agent-model-label']]",
    "//p[@data-testid='minds-chat-agent-model-label']/ancestor::button[1]",
    "//button[contains(@class,'css-d73kup')]",
]
MODEL_LABEL_XPATH = "//p[@data-testid='minds-chat-agent-model-label']"   # shows the current model
MODEL_SEARCH_CSS = "input[placeholder*='Search']"
# The modal's "Search models..." control is a BUTTON that reveals the real input when clicked.
MODEL_SEARCH_BUTTON_XPATH = "//button[contains(., 'Search models')]"
MODEL_ROW_TITLE_CSS = "p[title]"        # each model row's name is in a <p title="...">
CLOSE_BUTTON_XPATH = "//button[@aria-label='Close']"
NEW_CHAT_XPATH = "//button[@aria-label='New chat']"   # SPA new-chat (no full page reload)
# Composer's per-chat Settings dialog (Web Enabled / URL Scraping / Reasoning switches).
CHAT_SETTINGS_BUTTON_XPATH = "//button[@aria-label='Settings']"
# The stop control shown while Venice is generating (clicked to clear an aborted request).
# Verified from the live DOM: <button aria-label="stop"> (lowercase).
STOP_GENERATING_XPATH = "//button[translate(@aria-label,'STOP','stop')='stop' or @aria-label='Stop generating']"
# Credit-metered ("premium") models show a coin-stack icon in their picker row; this is the
# first path of that svg. The account's balance text lives in a <p> like "10,279 Credits".
PRICED_ICON_PATH_PREFIX = "M9 14c0"
CREDITS_TEXT_XPATH = "//p[contains(., 'Credits')]"
# Row switch inside that dialog, keyed by the row's visible label text ({} = label).
CHAT_SETTINGS_SWITCH_XPATH = "//p[normalize-space()='{}']/ancestor::div[contains(@class,'css-bngl5n')]//input[@type='checkbox']"

# --- Attachments (image / file upload) --------------------------------------
# Hidden <input type=file name=attachments> — Selenium send_keys(abs_path), no OS dialog.
ATTACH_FILE_INPUT_XPATHS = [
    "//input[@type='file' and @name='attachments']",
    "//form//input[@type='file']",
    "//input[@type='file']",
]
# Accepted-attachment cards (upload-landed signal). {} = file basename.
ATTACH_CARD_IMG_XPATH = "//div[contains(@class,'chakra-card')]//img[starts-with(@src,'blob:')]"
ATTACH_CARD_BY_NAME_XPATH = "//div[contains(@class,'chakra-card')][.//p[normalize-space()='{}'] or .//img[@alt='{}']]"
ATTACH_CARD_REMOVE_XPATH = "//div[contains(@class,'chakra-card')]//button[@aria-label='Remove']"
ATTACH_ACTIONS_BUTTON_XPATH = "//button[@aria-label='Actions']"

# --- Sidebar chat rows: rename / delete / cleanup ---------------------------
# A sidebar row is a <div role="group"> holding the <a href="/chat/classic/<slug>"> AND a
# sibling actions <div> with the Rename/Delete/Export buttons. Anchor on the GROUP (not the
# <a>) so the buttons are descendants; {} = the slug. Rename swaps in an <input>+confirm/Cancel.
SIDEBAR_CHAT_ROW_XPATH = "//div[@role='group'][.//a[contains(@href,'/chat/classic/{}')]]"
SIDEBAR_CHAT_ROW_ANY_XPATH = "//a[contains(@href,'/chat/classic/')]"
CHAT_RENAME_BUTTON_XPATH = ".//button[@aria-label='Rename']"
CHAT_RENAME_INPUT_XPATH = "//input[contains(@class,'chakra-input')]"
CHAT_RENAME_CONFIRM_XPATH = "//button[@aria-label='confirm']"
CHAT_RENAME_CANCEL_XPATH = "//button[@aria-label='Cancel']"
CHAT_DELETE_BUTTON_XPATH = ".//button[@aria-label='Delete']"
# Delete confirmation modal — the destructive button reads "Confirm".
CHAT_DELETE_CONFIRM_XPATH = "//footer//button[normalize-space()='Confirm']"
# Sidebar toggle (open to reach rows, close after for a clean UI). "Show Sidebar" = collapsed.
SIDEBAR_TOGGLE_XPATH = "//button[@aria-label='Toggle sidebar' or @aria-label='Show Sidebar']"

# --- Streaming API ----------------------------------------------------------
# The internal endpoint Venice's frontend POSTs to for a completion; the fetch interceptor
# watches for this substring in the request URL. If replies come back empty after a Venice
# update, this path likely changed — capture the real one from the browser Network tab.
INFERENCE_ENDPOINT = "/api/inference/chat"

# --- Models -----------------------------------------------------------------
# Shown in AI.EXE's model dropdown when live scraping only sees Venice's compact/recent
# subset. None means "use the expanded text-model catalog embedded in the adapter server".
FALLBACK_MODELS = None
