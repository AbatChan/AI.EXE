"""Logic tests for §2 generate loop. Fake LLM + REAL sandbox (offline, no network).

Run:  python backend/tests/smoke_generate.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.generate import run_generation  # noqa: E402
from app.sandbox import run_python  # noqa: E402
from app.usage import CreditExhausted  # noqa: E402

base = tempfile.mkdtemp()
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    def complete(self, messages, **kw):
        r = self.responses[min(self.calls, len(self.responses) - 1)]
        self.calls += 1
        return r


def runner(files, requirements, timeout):
    return run_python(base, code=None, files=files, entry="main.py",
                      requirements=requirements or [], stdin=None, args=[], timeout_seconds=timeout)


def noop():
    pass


# 1) Happy path: code runs first try.
res = run_generation(prompt="print hi", llm=FakeLLM(["```python\nprint('hi')\n```"]),
                     sandbox_runner=runner, charge=noop)
assert res["ok"] and "hi" in res["stdout"] and "main.py" in res["files"], res
ok("generates code that runs on the first try")

# 2) Auto-correct: broken first, fixed on retry.
llm = FakeLLM(["```python\nprint(1/0)\n```", "```python\nprint('fixed')\n```"])
res = run_generation(prompt="x", llm=llm, sandbox_runner=runner, charge=noop, max_retries=2)
assert res["ok"] and "fixed" in res["stdout"] and len(res["attempts"]) == 2 and llm.calls == 2, res
ok("auto-corrects a failing program on retry")

# 3) No code in response.
res = run_generation(prompt="x", llm=FakeLLM(["just prose, no code block"]),
                     sandbox_runner=runner, charge=noop)
assert (not res["ok"]) and "did not return any code" in (res["error"] or ""), res
ok("reports when the model returns no code")

# 4) Credit limit stops the retry loop gracefully (no 2nd LLM call).
state = {"n": 0}


def charge_stop():
    state["n"] += 1
    if state["n"] > 1:
        raise CreditExhausted()


llm = FakeLLM(["```python\nprint(1/0)\n```", "```python\nprint('fixed')\n```"])
res = run_generation(prompt="x", llm=llm, sandbox_runner=runner, charge=charge_stop, max_retries=2)
assert (not res["ok"]) and res["stopped_reason"] == "CreditExhausted" and llm.calls == 1, res
ok("retry loop stops cleanly when credits run out")

# 5) Multi-file project from named blocks.
llm = FakeLLM(["```python\n# main.py\nimport util\nprint(util.f())\n```\n"
               "```python\n# util.py\ndef f():\n    return 'multi'\n```"])
res = run_generation(prompt="x", llm=llm, sandbox_runner=runner, charge=noop)
assert res["ok"] and "multi" in res["stdout"] and {"main.py", "util.py"} <= set(res["files"]), res
ok("builds and runs a multi-file project")

# 6) Model names the entry file something else (add.py) -> renamed to main.py so it runs/packages.
llm = FakeLLM(["```python\n# add.py\nprint('renamed entry runs')\n```"])
res = run_generation(prompt="x", llm=llm, sandbox_runner=runner, charge=noop, entry="main.py")
assert res["ok"] and "main.py" in res["files"] and "add.py" not in res["files"], res
ok("entry file is normalized to main.py when the model picks another name")

# 7) A clean non-zero exit (CLI usage, no traceback) does NOT trigger auto-correct.
calls = {"n": 0}


class CountLLM:
    def complete(self, messages, **kw):
        calls["n"] += 1
        return "```python\n# main.py\nimport sys\nif len(sys.argv) != 3:\n    print('usage'); sys.exit(1)\n```"


res = run_generation(prompt="cli", llm=CountLLM(), sandbox_runner=runner, charge=noop, max_retries=2)
assert calls["n"] == 1 and len(res["attempts"]) == 1, res  # no wasted retry on a clean exit(1)
ok("a clean non-zero exit (no traceback) is not auto-corrected")

print(f"\n{passed} checks passed.")
