import ast
import pathlib
import re


SOURCE_PATH = pathlib.Path(__file__).resolve().parents[1] / "backend" / "app" / "venice_adapter_server.py"
SOURCE = SOURCE_PATH.read_text()
TREE = ast.parse(SOURCE)
WANTED = {
    "_aiexe_slug_from_url",
    "_aiexe_stable_chat_url",
    "_aiexe_same_chat_url",
    "_aiexe_should_rotate_after_turn",
}
nodes = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in WANTED]
namespace = {"re": re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)

slug = namespace["_aiexe_slug_from_url"]
stable = namespace["_aiexe_stable_chat_url"]
same = namespace["_aiexe_same_chat_url"]
should_rotate = namespace["_aiexe_should_rotate_after_turn"]

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

# A missed network chunk followed by a successful DOM capture is the normal Venice
# worker path and must keep the same conversation. Only an unrecovered empty turn or
# a hard idle timeout rotates it.
assert not should_rotate("empty_first_chunk", 1)
assert not should_rotate("empty_dom", 3)
assert not should_rotate("", 1)
assert should_rotate("empty_first_chunk", 0)
assert should_rotate("empty_dom", 0)
assert should_rotate("stream_idle_timeout", 1)

# Successful network-interceptor streams skip the DOM-fallback branch. `_prev`
# must already exist before the stream loop because raw-copy upgrade reads it
# before the conversation URL mapping block runs.
stream_setup = SOURCE.index("        eval_count = 0")
prev_init = SOURCE.index('        _prev = ""', stream_setup)
stream_loop = SOURCE.index("        while True:", stream_setup)
mapping_block = SOURCE.index("        # Remember which Venice conversation", stream_loop)
assert stream_setup < prev_init < stream_loop < mapping_block
assert '_prev, _stable = "", 0' not in SOURCE

assert "AIEXE_THREAD_MAX_TURNS = 0" in SOURCE
assert "AIEXE_THREAD_SLOW.add(_chat_key)" in SOURCE
assert "def _aiexe_temporary_chat_mode" in SOURCE
assert "def _aiexe_start_fresh_temp_chat" in SOURCE
assert "if _chat_key and not _temporary_mode:" in SOURCE
assert 'driver.get(VC_CHAT_URL)  # normal saved mode has no unsaved-page prompt' in SOURCE
rotation_start = SOURCE.index("        if _rotate_turns or _rotate_slow:")
rotation_end = SOURCE.index("        _cur_url =", rotation_start)
assert "_aiexe_stale_add" not in SOURCE[rotation_start:rotation_end]
print("PASS: saved chats reuse routes; temporary chats reset through SPA without reload/delete")
