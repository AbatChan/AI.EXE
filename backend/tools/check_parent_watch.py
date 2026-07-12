"""Guard: os.kill(pid, 0) is a POSIX-only existence probe. On Windows the same call
maps to TerminateProcess (via OpenProcess(PROCESS_ALL_ACCESS)), which either kills the
target or, when access is denied, raises OSError — twice this silently made a process
os._exit itself seconds after boot (backend v7.9.1, adapter v7.9.5). Any os.kill(x, 0)
must live only inside a POSIX-gated `_watch_parent_posix` function. Fails CI otherwise.
"""
import ast
import os
import sys


def _is_os_kill_probe(node) -> bool:
    if not isinstance(node, ast.Call) or len(node.args) < 2:
        return False
    f = node.func
    if not (isinstance(f, ast.Attribute) and f.attr == "kill"
            and isinstance(f.value, ast.Name) and f.value.id == "os"):
        return False
    sig = node.args[1]
    return isinstance(sig, ast.Constant) and sig.value == 0


def _offending_calls(tree: ast.AST):
    # Nodes anywhere inside a _watch_parent_posix function (incl. nested closures)
    # are allowed; every other os.kill(x, 0) is Windows-unsafe.
    safe = set()
    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef) and fn.name == "_watch_parent_posix":
            for child in ast.walk(fn):
                if _is_os_kill_probe(child):
                    safe.add(id(child))
    bad = []
    for node in ast.walk(tree):
        if _is_os_kill_probe(node) and id(node) not in safe:
            bad.append(node.lineno)
    return bad


def main() -> int:
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")
    failures = []
    for dirpath, _, names in os.walk(root):
        for name in names:
            if not name.endswith(".py"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), filename=path)
            for line in _offending_calls(tree):
                failures.append(f"{path}:{line}: os.kill(pid, 0) outside _watch_parent_posix (Windows-unsafe)")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("parent-watch guard ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
