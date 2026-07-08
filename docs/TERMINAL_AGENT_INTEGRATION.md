# Terminal-Powered Agent Integration

Date: 2026-07-06

## Backup

Before this analysis, the dirty workspace state was backed up here:

- `.codex-backups/terminal-agent-20260706-000000/status.txt`
- `.codex-backups/terminal-agent-20260706-000000/tracked-changes.patch`
- `.codex-backups/terminal-agent-20260706-000000/untracked-files.txt`
- `.codex-backups/terminal-agent-20260706-000000/untracked-files.tgz`

The backup is compact: it stores the tracked diff plus untracked artifacts instead of copying the full 6.7 GB repository.

## Verdict

The terminal-powered proposal is directionally correct, but AI.EXE should not switch to an unrestricted shell. The best upgrade is a hybrid:

```txt
Current AI.EXE work panel + file tools
+ structured command runner
+ stack-aware proof commands
+ permission policy
+ proof-gated finalization
```

The existing code already started this direction:

- `run_app` can run a real `npm run build` for Vite projects and hidden-browser smoke checks for plain HTML.
- `run_command` exists and returns real output/exit status for Python, pip, Node, and npm.
- `check_code` gives fast syntax diagnostics for JS/HTML/CSS/JSON.
- The agent loop already blocks finishing over unresolved `run_app` failures.
- Native command execution goes through `ProcessRunner` and `RunProjectCommand`, not raw shell strings.

So the right move is not "add shell access". It is "turn the current narrow command runner into a first-class proof subsystem".

## Current Architecture Fit

### Strong Pieces Already Present

1. Native command runner foundation

`src/command_runner.h` runs allowlisted executables inside the workspace and reuses `ProcessRunner` timeout/output controls. This is better than handing the model a raw shell because argv is structured and command injection surface is smaller.

2. Agent-visible proof tools

`ui/agent-executor.js` already exposes:

- `check_code`
- `run_app`
- `run_command`
- `validate_files`

This means the UI and loop already know how to display tool outcomes and feed real errors back into the planner.

3. Runtime proof is already recognized as stronger than static validation

`run_app` uses `npm run build` for Vite and captures startup errors for plain HTML. `docs/PROJECT_MEMORY.md` also records this as the v2.6.0 direction.

4. Loop hardening exists

The loop has guards for repeated reads, repeated validation, edit oscillation, unresolved `run_app` errors, and weak finalization. These are exactly the controls a terminal agent needs.

## Gaps

### 1. Command policy is too narrow and not explicit enough

Current `run_command` allows only:

```txt
python, pip, node, npm
```

That is a sensible v1 safety choice, but it does not yet cover the proposal's language-agnostic goal: Go, Rust, Java, PHP, C/C++, .NET, TypeScript helpers, pytest, etc.

Do not fix this by allowing arbitrary shell. Add command families deliberately.

### 2. Installs need an ask-first policy

`run_app` currently tries `npm install` automatically when a Vite build looks like missing dependencies. That improves completion, but it violates the safety model in the proposal. Package installation changes lockfiles, downloads code, and can run lifecycle scripts.

First policy fix: dependency installs should return a permission-required result instead of silently running.

### 3. No stack detector owns proof selection

The planner prompt tells the model about `run_app` and `run_command`, but command choice is still mostly model-driven. A robust terminal agent should inspect project files and choose proof commands deterministically:

- `package.json` + `scripts.build` -> `npm run build`
- `tsconfig.json` -> `npx tsc --noEmit` or project build
- `requirements.txt` / `.py` -> `python -m py_compile`, `python -m pytest` when tests exist
- `Cargo.toml` -> `cargo check`
- `go.mod` -> `go test ./...`
- `pom.xml` -> `mvn test`
- `CMakeLists.txt` -> `cmake -S . -B build` then `cmake --build build`

### 4. No structured command result model in the UI

The native side returns `message` and `output`. The agent parses `exit_code=N` out of `message`. A terminal subsystem should expose structured fields:

```ts
type CommandResult = {
  command: string;
  program: string;
  args: string[];
  cwd: string;
  policy: "auto-safe" | "ask-first" | "blocked";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  outputTruncated: boolean;
};
```

### 5. Long-running dev servers are not first-class yet

Current `run_command` treats timeout as "still running with no crash". That is useful for a GUI/game loop, but dev servers need tracked process IDs, URLs, log streaming, stop buttons, and port detection.

## Recommended Implementation Plan

### Phase 1 - Policy and result shape

Goal: make the current runner safer before expanding it.

- Add a `classifyCommand(program, args)` policy layer.
- Categories:
  - `auto-safe`: read-only inspection, syntax checks, builds, tests.
  - `ask-first`: package installs, long-running dev servers, external browser open, networked commands.
  - `blocked`: destructive filesystem commands, credential/env dumps, shell pipelines, privilege escalation, remote script execution.
- Return structured command results instead of parsing `message`.
- Stop auto-running `npm install` in `run_app`; surface a permission request.

### Phase 2 - Stack detector and proof planner

Goal: reduce model guessing.

- Add `detectWorkspaceStack()` in the agent executor or workspace core.
- Read project files deterministically: `package.json`, `tsconfig.json`, `vite.config.*`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `CMakeLists.txt`.
- Produce `proofCandidates` for the planner.
- Add a helper tool internally, not necessarily model-visible at first:

```txt
verify_project -> chooses strongest safe command for the current stack
```

### Phase 3 - Broaden command families without raw shell

Goal: generic language coverage while preserving argv safety.

Extend native `RunProjectCommand` in small batches:

- Python: `python`, `pip`, `pytest` through `python -m pytest`
- Node: `node`, `npm`, `npx` with restrictions
- Go: `go test`, `go run`
- Rust: `cargo check`, `cargo test`, `cargo run`
- PHP: `php -l`, `composer test`
- Java: `javac`, `mvn test`, `gradle test`
- .NET: `dotnet build`, `dotnet test`
- C/C++: `cmake`, `make`, `gcc`, `g++` with workspace output paths only

Avoid generic `bash -c`, `zsh -c`, `powershell -Command`, and `cmd /c` for agent-chosen commands. If they are ever added, put them behind explicit advanced approval and command inspection.

### Phase 4 - Proof gates

Goal: terminal output becomes the finalization truth source.

Rules:

- Create/edit/debug tasks that touch code require passing `check_code`, `run_app`, `run_command`, or `verify_project`.
- If any command after the last mutation reports errors, finalization is blocked.
- If the user says "run the app", the agent must actually call `run_app` or a dev-server helper, not explain how to run it.
- If proof cannot run because a dependency is missing or permission is denied, finalization must say that plainly.

### Phase 5 - Long-running process manager

Goal: real "run the app" behavior.

- Add `run_dev_server` separately from `run_command`.
- Track process handle/PID, port, URL, cwd, start time, and rolling logs.
- Render a work-panel command card with Stop.
- Reuse this for Vite, Next, Flask/FastAPI, Django, Rails, PHP built-in server, etc.

## First Code Change I Would Make

Change Vite `run_app` dependency handling:

Current behavior:

```txt
npm run build fails because vite/tsc is missing
-> run_app automatically runs npm install
-> reruns npm run build
```

Recommended behavior:

```txt
npm run build fails because vite/tsc is missing
-> return permission_required for npm install
-> UI shows command, reason, risk, approve/deny
-> approved install runs through the same command runner and is logged
```

This aligns AI.EXE with the proposed safety model and with current agent-system guidance: powerful commands are useful, but package/network operations need explicit boundaries and audit logs.

## External Research Notes

Current agent tooling guidance in 2026 is consistent with this plan:

- OpenAI's Shell tool documentation emphasizes terminal execution for deterministic work, but explicitly warns to sandbox execution, use allowlists/denylists, and log activity.
- OpenAI Codex permission profiles separate read-only, workspace-write, and unrestricted modes.
- Anthropic Claude Code exposes managed settings for allow/ask/deny permissions, MCP/hook allowlists, and managed-only permission rules.
- Google ADK's safety guidance recommends tool-level guardrails, sandboxed code execution, tracing, evaluation, and network controls.

## Bottom Line

The proposal is not a replacement for the current system. It is the next layer.

AI.EXE should keep its current file tools and work panel, then make command proof a first-class verifier. The safest path is to expand from the existing structured native command runner, not by giving the model arbitrary shell text.
