import ast
import json
import pathlib
import re


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)

helper = next(
    item for item in TREE.body
    if isinstance(item, ast.FunctionDef) and item.name == "_aiexe_salvage_incomplete_final_json"
)
module = ast.Module(body=[helper], type_ignores=[])
namespace = {"json": json, "re": re}
exec(compile(ast.fix_missing_locations(module), str(SOURCE_PATH), "exec"), namespace)
salvage = namespace["_aiexe_salvage_incomplete_final_json"]

cut_final = '''```json
{
  "action": "final",
  "message": "Phase 1 is wrapped! Static validation passed. Run `npm install && npm run dev` to verify Three.js'''
recovered = json.loads(salvage(cut_final))
assert recovered["action"] == "final"
assert recovered["message"].startswith("Phase 1 is wrapped!")
assert "npm install" in recovered["message"]

assert salvage('{"action":"tool","tool":"write_file","path":"/app.js"') == ""
assert salvage('{"action":"final","message":"') == ""

branch = SOURCE[SOURCE.index("        if eval_count == 0 and not streamed_content:"):SOURCE.index("        # Decide rotation only after every recovery path", SOURCE.index("        if eval_count == 0 and not streamed_content:"))]
assert "_structured_incomplete_stable >= 8" in branch
assert "not _aiexe_generation_running(driver)" in branch
assert "_aiexe_salvage_incomplete_final_json(_txt)" in branch

print("PASS: stable incomplete final JSON is recovered quickly; partial tool decisions remain blocked")
