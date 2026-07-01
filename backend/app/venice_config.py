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
LOGIN_SUBMIT_XPATH = "//button[@type='submit' or contains(., 'Continue') or contains(., 'Sign in') or contains(., 'Log in')]"
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
MODEL_ROW_TITLE_CSS = "p[title]"        # each model row's name is in a <p title="...">
CLOSE_BUTTON_XPATH = "//button[@aria-label='Close']"
NEW_CHAT_XPATH = "//button[@aria-label='New chat']"   # SPA new-chat (no full page reload)

# --- Streaming API ----------------------------------------------------------
# The internal endpoint Venice's frontend POSTs to for a completion; the fetch interceptor
# watches for this substring in the request URL. If replies come back empty after a Venice
# update, this path likely changed — capture the real one from the browser Network tab.
INFERENCE_ENDPOINT = "/api/inference/chat"

# --- Models -----------------------------------------------------------------
# Shown in AI.EXE's model dropdown ONLY when the live scrape fails. These are the REAL Venice
# model names (verified from the live picker 2026-07-01); "DeepSeek V4 Pro" was a wrong guess —
# Venice has V4 Flash / V3.2, no "V4 Pro". Keep this list matching the live titles.
FALLBACK_MODELS = [
    "DeepSeek V4 Flash", "DeepSeek V3.2", "Qwen 3.7 Max",
    "Claude Fable 5", "Claude Opus 4.8", "Claude Sonnet 4.6",
    "GLM 4.6", "GLM 4.7 Flash Heretic", "GLM 5.2",
    "Google Gemma 4 31B Instr", "Venice Uncensored 1.2",
]
