import ast
import pathlib
import re


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)

WANTED_ASSIGNMENTS = {
    "AIEXE_MODEL_OPTION_RE",
    "AIEXE_MODEL_ROW_OPTIONS",
    "AIEXE_PRICED_MODELS",
    "AIEXE_UNCENSORED_MODELS",
}
WANTED_FUNCTIONS = {
    "_aiexe_encode_model_option",
    "_aiexe_decode_model_option",
    "_aiexe_record_model_row",
    "_aiexe_cached_model_rows",
    "_aiexe_merge_cached_model_rows",
    "_aiexe_expand_model_options",
}

nodes = []
for node in TREE.body:
    if isinstance(node, ast.Assign):
        targets = {target.id for target in node.targets if isinstance(target, ast.Name)}
        if targets & WANTED_ASSIGNMENTS:
            nodes.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name in WANTED_FUNCTIONS:
        nodes.append(node)

namespace = {"re": re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)

namespace["_aiexe_record_model_row"]("GLM 5.2", "", True)
namespace["_aiexe_record_model_row"]("GLM 5.2", "", False)
namespace["_aiexe_record_model_row"]("GLM 5.2", "TEE", False)
namespace["_aiexe_record_model_row"]("Venice Role Play", "Uncensored", False)
namespace["AIEXE_PRICED_MODELS"] = {"GLM 5.2"}

options = namespace["_aiexe_expand_model_options"](["GLM 5.2", "Kimi K3", "Venice Role Play"])
assert options == [
    "GLM 5.2 [Private · Pay-per-use]",
    "GLM 5.2 [Private · Free]",
    "GLM 5.2 [TEE · Free]",
    "Kimi K3",
    "Venice Role Play",
]
assert namespace["AIEXE_PRICED_MODELS"] == {"GLM 5.2 [Private · Pay-per-use]"}
assert namespace["AIEXE_UNCENSORED_MODELS"] == {"Venice Role Play"}
assert namespace["_aiexe_decode_model_option"]("GLM 5.2 [TEE · Free]:latest") == (
    "GLM 5.2", "TEE", False
)

# A clean adapter restart must restore the same-title row identities from disk.
namespace["AIEXE_MODEL_ROW_OPTIONS"] = {}
namespace["_aiexe_merge_cached_model_rows"]({
    "models": ["GLM 5.2"],
    "row_options": {
        "GLM 5.2": [["Private", False], ["Private", True], ["TEE", False]],
    },
})
restart_options = namespace["_aiexe_expand_model_options"](["GLM 5.2", "Kimi K3"])
assert restart_options == [
    "GLM 5.2 [Private · Free]",
    "GLM 5.2 [Private · Pay-per-use]",
    "GLM 5.2 [TEE · Free]",
    "Kimi K3",
]

assert 'AIEXE_MODEL_CACHE_VERSION = 7' in SOURCE
assert '"row_options": row_options' in SOURCE
assert 'os.replace(temp_path, AIEXE_MODEL_CACHE_FILE)' in SOURCE
assert 'AIEXE_MODEL_CACHE_TTL' not in SOURCE
assert '_aiexe_schedule_model_refresh' not in SOURCE
tags_body = SOURCE.split("def tags():", 1)[1].split("def mock_show", 1)[0]
assert 'aiexe_scrape_models' not in tags_body
assert '_aiexe_model_catalog()' in tags_body
assert '"Kimi K3"' in SOURCE

print("PASS: Venice model variants remain distinct and catalog refresh is launch-only")
