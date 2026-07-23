import ast
import pathlib


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)

cleanup = next(
    item for item in TREE.body
    if isinstance(item, ast.FunctionDef) and item.name == "aiexe_cleanup_internal_route"
)
cleanup_source = ast.get_source_segment(SOURCE, cleanup)
assert '"forgotten": 0' in cleanup_source
assert "driver" not in cleanup_source
assert "selenium_lock" not in cleanup_source
assert "AIEXE_CHAT_URLS" not in SOURCE
assert "_aiexe_internal_cleanup_loop" not in SOURCE
assert "_aiexe_sweep_stale_threads" not in SOURCE
assert "_aiexe_delete_chat" not in SOURCE

print("PASS: compatibility cleanup is a no-op; no saved-chat deletion or background UI loop remains")
