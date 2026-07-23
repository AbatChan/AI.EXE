import pathlib


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()

# Successful network-interceptor streams skip the DOM-fallback branch. `_prev`
# must already exist before the stream loop because raw-copy upgrade reads it first.
stream_setup = SOURCE.index("        eval_count = 0")
prev_init = SOURCE.index('        _prev = ""', stream_setup)
stream_loop = SOURCE.index("        while True:", stream_setup)
turn_accounting = SOURCE.index("        if _chat_key:", stream_loop)
assert stream_setup < prev_init < stream_loop < turn_accounting
assert '_prev, _stable = "", 0' not in SOURCE

assert "AIEXE_THREAD_MAX_TURNS = 0" in SOURCE
assert "AIEXE_THREAD_SLOW.add(_chat_key)" in SOURCE
assert "def _aiexe_temporary_chat_mode" in SOURCE
assert "def _aiexe_ensure_temporary_chat_mode" in SOURCE
assert "def _aiexe_start_fresh_temp_chat" in SOURCE
assert "if not _aiexe_ensure_temporary_chat_mode(driver):" in SOURCE
assert "Venice Temporary Chat is required but unavailable" in SOURCE
assert "AIEXE_CHAT_URLS" not in SOURCE
assert "_mapped" not in SOURCE
assert "sidebar_debug" not in SOURCE
assert "_aiexe_delete_chat" not in SOURCE
assert "_aiexe_rename_chat" not in SOURCE
assert "_aiexe_internal_cleanup_loop" not in SOURCE

# Startup must force Temporary Chat before catalog scraping and credit reads.
startup = SOURCE.index("driver = login_to_venice()", SOURCE.index("_aiexe_atexit.register"))
forced = SOURCE.index("if not _aiexe_ensure_temporary_chat_mode(driver):", startup)
scrape = SOURCE.index("_aiexe_restore_fresh_model_cache()", startup)
assert startup < forced < scrape

print("PASS: Venice is Temporary-only at startup and per request; saved-chat UI paths are absent")
