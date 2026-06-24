"""§2 — the generate loop: LLM -> separate code -> run in sandbox -> auto-correct.

Dependency-injected (llm, sandbox_runner, charge) so it is testable offline with a fake
LLM + the real sandbox. `charge()` consumes one credit per LLM call and raises
RateLimited/CreditExhausted; the first call's exception propagates (endpoint -> HTTP),
later retries stop gracefully when limits are hit.
"""
from .usage import CreditExhausted, RateLimited

DEFAULT_SYSTEM = (
    "You are AI.EXE's code generator. Produce a SMALL, COMPLETE, RUNNABLE Python program "
    "for the user's request. The runnable ENTRY file MUST be named main.py. Put the code in "
    "fenced ```python blocks, each beginning with a '# filename.py' comment on the first line. "
    "Prefer the standard library; if you must use a third-party package, keep it minimal."
)

WEB_SYSTEM = (
    "You are AI.EXE's web generator. Produce ONE COMPLETE, self-contained static web page "
    "for the user's request: a single index.html with all CSS in a <style> tag and all JS "
    "in a classic <script> tag (no external files, no frameworks, works from file://). "
    "Output it in a single fenced ```html block."
)


def system_for(language: str) -> str:
    return WEB_SYSTEM if str(language or "").lower() in ("web", "html") else DEFAULT_SYSTEM


def ensure_entry(files: dict, entry: str) -> dict:
    """If the model named its entry file something other than `entry` (e.g. add.py),
    rename the obvious main file to `entry` so the run + packaging find it."""
    if not files or entry in files:
        return files
    py = [f for f in files if f.endswith(".py")]
    pick = py[0] if len(py) == 1 else next(
        (f for f in py if "__main__" in files[f] or "def main(" in files[f]), None)
    if pick:
        files = dict(files)
        files[entry] = files.pop(pick)
    return files


def _has_error_signal(result: dict) -> bool:
    """A real failure worth auto-correcting — a traceback or a known error hint — vs a
    program that simply exited non-zero by design (e.g. a CLI printing usage with no args)."""
    if not result:
        return False
    return bool(result.get("retry_hint")) or "Traceback (most recent call last)" in (result.get("stderr") or "")


def _attempt(files, result):
    return {
        "files": list(files.keys()),
        "ok": None if result is None else bool(result.get("ok")),
        "exit_code": None if result is None else result.get("exit_code"),
        "stderr_excerpt": "" if result is None else (result.get("stderr") or "")[:600],
    }


def run_generation(*, prompt, llm, sandbox_runner, charge, system_prompt=None,
                   run=True, auto_correct=True, max_retries=2, requirements=None,
                   timeout_seconds=30, entry="main.py") -> dict:
    messages = [
        {"role": "system", "content": system_prompt or DEFAULT_SYSTEM},
        {"role": "user", "content": str(prompt or "")},
    ]
    attempts = []

    charge()  # first LLM call — propagates RateLimited/CreditExhausted to the caller
    text = llm.complete(messages)
    parsed = {"files": {}, "prose": ""}
    from .codeparse import extract_code_files
    parsed = extract_code_files(text, entry)
    files = parsed["files"]
    if not files:
        return {"ok": False, "error": "The model did not return any code.",
                "prose": parsed["prose"], "files": {}, "stdout": "", "stderr": "",
                "blocked": False, "attempts": attempts, "stopped_reason": None}

    files = ensure_entry(files, entry)
    result = sandbox_runner(files, requirements, timeout_seconds) if run else None
    attempts.append(_attempt(files, result))

    retries = 0
    stopped = None
    while (run and auto_correct and result and not result.get("ok")
           and not result.get("blocked") and _has_error_signal(result)
           and retries < max_retries):
        try:
            charge()  # each retry is another metered LLM call
        except (RateLimited, CreditExhausted) as exc:
            stopped = type(exc).__name__
            break
        feedback = result.get("retry_hint") or (result.get("stderr") or "")[:1500] or "It did not run correctly."
        messages.append({"role": "assistant", "content": text})
        messages.append({"role": "user", "content":
                         f"The program failed when run. Error:\n{feedback}\n"
                         "Return the corrected COMPLETE file(s) in fenced blocks."})
        text = llm.complete(messages)
        parsed = extract_code_files(text, entry)
        if parsed["files"]:
            files = ensure_entry(parsed["files"], entry)
        result = sandbox_runner(files, requirements, timeout_seconds)
        attempts.append(_attempt(files, result))
        retries += 1

    return {
        "ok": bool(result.get("ok")) if (run and result) else (not run),
        "files": files,
        "prose": parsed["prose"],
        "stdout": result.get("stdout", "") if result else "",
        "stderr": result.get("stderr", "") if result else "",
        "blocked": result.get("blocked", False) if result else False,
        "attempts": attempts,
        "stopped_reason": stopped,
        "error": None,
    }
