import ast
import pathlib


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)
node = next(
    item for item in TREE.body
    if isinstance(item, ast.FunctionDef) and item.name == "_aiexe_cleanup_internal_batch"
)


saved = []
namespace = {
    "AIEXE_CHAT_URLS": {"id:internal:test": "https://venice.ai/chat/classic/internal-slug"},
    "AIEXE_STALE_THREADS": {"already-gone-slug"},
    "AIEXE_THREAD_ATTACHMENTS": {},
    "AIEXE_THREAD_NAMED": {},
    "AIEXE_THREAD_TURNS": {},
    "AIEXE_THREAD_SLOW": set(),
    "_aiexe_save_chat_map": lambda: saved.append("map"),
    "_aiexe_save_stale_threads": lambda: saved.append("stale"),
}
exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)

forgotten = namespace["_aiexe_cleanup_internal_batch"](respect_user_window=False)
assert forgotten == 1
assert namespace["AIEXE_CHAT_URLS"] == {}
assert namespace["AIEXE_STALE_THREADS"] == set()
assert saved == ["map", "stale"]
cleanup_source = ast.get_source_segment(SOURCE, node)
assert "_aiexe_delete_chat" not in cleanup_source
assert "driver." not in cleanup_source
assert "selenium_lock" not in cleanup_source
print("PASS: cleanup forgets local mappings without deleting chats or driving Chrome")
