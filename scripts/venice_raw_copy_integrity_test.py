import ast
import pathlib
import re


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)

node = next(
    item
    for item in TREE.body
    if isinstance(item, ast.FunctionDef) and item.name == "_aiexe_raw_copy_is_safe_upgrade"
)
module = ast.Module(body=[node], type_ignores=[])
namespace = {"re": re}
exec(compile(module, str(SOURCE_PATH), "exec"), namespace)
safe = namespace["_aiexe_raw_copy_is_safe_upgrade"]

assert safe('{"next":"^15.0.0"}', '{"next":"^15.0.0"}\n')
assert not safe(
    '{"drei":"^9.114.0","fiber":"^8.17.10"}',
    '{"drei":"^1^.114.0","fiber":"^2^.17.10"}',
)
assert not safe('npm install package@^9.114.0', 'npm install package@9.114.0')
assert safe("ordinary prose response", "ordinary prose response with markdown restored")

assert "_aiexe_raw_copy_is_safe_upgrade(_scraped_full, _raw)" in SOURCE

print("PASS: Venice raw-copy upgrades preserve caret-version code tokens")
