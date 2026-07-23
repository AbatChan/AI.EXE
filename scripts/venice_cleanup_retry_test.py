import ast
import pathlib
import time


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)
node = next(
    item for item in TREE.body
    if isinstance(item, ast.FunctionDef) and item.name == "_aiexe_cleanup_internal_batch"
)


class DummyLock:
    def __init__(self):
        self.acquired = 0
        self.released = 0

    def acquire(self, blocking=False):
        self.acquired += 1
        return True

    def release(self):
        self.released += 1


class DummyDriver:
    def __init__(self):
        self.minimized = 0

    def minimize_window(self):
        self.minimized += 1


attempts = []
saved = []
lock = DummyLock()
driver = DummyDriver()
namespace = {
    "time": time,
    "driver": driver,
    "selenium_lock": lock,
    "AIEXE_CHAT_URLS": {"id:internal:test": "https://venice.ai/chat/classic/internal-slug"},
    "AIEXE_STALE_THREADS": {"already-gone-slug"},
    "AIEXE_THREAD_ATTACHMENTS": {},
    "AIEXE_THREAD_NAMED": {},
    "AIEXE_THREAD_TURNS": {},
    "AIEXE_THREAD_SLOW": set(),
    "_aiexe_park_offscreen": lambda _driver: True,
    "_aiexe_slug_from_url": lambda url: str(url).rsplit("/", 1)[-1],
    "_aiexe_delete_chat": lambda _driver, slug, nav_fallback=False: attempts.append(slug) or False,
    "_aiexe_save_chat_map": lambda: saved.append("map"),
    "_aiexe_save_stale_threads": lambda: saved.append("stale"),
}
exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)

deleted = namespace["_aiexe_cleanup_internal_batch"](respect_user_window=False)
assert deleted == 0
assert attempts == ["internal-slug", "already-gone-slug"]
assert namespace["AIEXE_CHAT_URLS"] == {}
assert namespace["AIEXE_STALE_THREADS"] == set()
assert lock.acquired == 1 and lock.released == 1
assert driver.minimized == 1
assert saved == ["map", "stale"]
print("PASS: missing/manually-deleted Venice threads are attempted once and never retried")
