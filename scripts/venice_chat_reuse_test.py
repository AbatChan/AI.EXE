import ast
import pathlib
import re


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)
WANTED = {"_aiexe_slug_from_url", "_aiexe_stable_chat_url", "_aiexe_same_chat_url"}
nodes = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in WANTED]
namespace = {"re": re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)

slug = namespace["_aiexe_slug_from_url"]
stable = namespace["_aiexe_stable_chat_url"]
same = namespace["_aiexe_same_chat_url"]

classic = "https://venice.ai/chat/classic/thread_abc-123"
path_route = "https://venice.ai/chat/thread_abc-123"
query_route = "https://venice.ai/chat/classic?conversationId=thread_abc-123"
assert slug(classic) == "thread_abc-123"
assert slug(path_route) == "thread_abc-123"
assert slug(query_route) == "thread_abc-123"
assert stable(classic) and stable(path_route) and stable(query_route)
assert same(classic, query_route)
assert not stable("https://venice.ai/chat/classic?refreshId=123")
assert not same(classic, "https://venice.ai/chat/another-thread")

assert "AIEXE_THREAD_MAX_TURNS = 0" in SOURCE
assert "AIEXE_THREAD_SLOW.add(_chat_key)" in SOURCE
print("PASS: normal Venice chats reuse stable path/query routes and rotate only after a slow turn")
