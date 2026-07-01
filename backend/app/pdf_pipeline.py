"""§10 — PDF-to-software orchestration: dispatch each spec section to a specialized
agent, aggregate the generated files, stitch into one project, and emit a build log +
a section→file mapping. Dependency-injected (llm, sandbox_runner, charge) for testing.

Honest scope: this runs the multi-agent PIPELINE the doc describes. Cross-agent code
COHERENCE is the known-hard part (each agent emits its own files); v1 delivers the
structure + mapping + build log + a ready project, not a guaranteed unified program.
"""
from .codeparse import extract_code_files

# §10 suggested agents.
AGENT_ROLES = [
    ("foundation", "the foundational/core setup and project skeleton"),
    ("intelligence", "the main logic / intelligence layer"),
    ("optimization", "optimized, refined, efficient implementations"),
    ("runtime", "runtime / integration / the entry point that ties things together"),
    ("advanced", "advanced modules and concise technical documentation"),
]

_SYS = ("You are AI.EXE agent '{role}'. Implement {focus} for the following spec section. "
        "Output Python file(s) in fenced ```python blocks, each starting with a '# filename.py' "
        "comment. Keep it minimal and runnable.")


def render_mapping_md(mapping: dict) -> str:
    lines = ["# PDF section → generated files\n"]
    for title, info in mapping.items():
        lines.append(f"## {title}\n- agent: {info['agent']}\n- files: {', '.join(info['files']) or '(none)'}\n")
    return "\n".join(lines)


def run_pdf_to_software(sections, llm, sandbox_runner, charge, *, timeout_seconds=30) -> dict:
    all_files: dict = {}
    mapping: dict = {}
    log = []
    for i, sec in enumerate(sections):
        role, focus = AGENT_ROLES[i % len(AGENT_ROLES)]
        charge()  # each agent is a metered LLM call
        messages = [
            {"role": "system", "content": _SYS.format(role=role, focus=focus)},
            {"role": "user", "content": sec["text"]},
        ]
        text = llm.complete(messages)
        files = extract_code_files(text, f"section_{i + 1}.py")["files"]
        for name, content in files.items():
            all_files[name] = content
        produced = list(files.keys())
        mapping[sec["title"] or f"section {i + 1}"] = {"agent": role, "files": produced}
        log.append(f"[agent:{role}] section {i + 1} '{sec['title'][:40]}' → {produced or 'no files'}")

    run_ok = None
    if all_files and "main.py" in all_files and sandbox_runner:
        res = sandbox_runner(all_files, [], timeout_seconds)
        run_ok = bool(res.get("ok"))
        log.append(f"[validate] main.py → {'ran clean' if run_ok else 'errors: ' + (res.get('stderr') or '')[:160]}")

    return {
        "ok": bool(all_files),
        "files": all_files,
        "mapping": mapping,
        "build_log": "\n".join(log),
        "sections": [s["title"] for s in sections],
        "run_ok": run_ok,
    }
