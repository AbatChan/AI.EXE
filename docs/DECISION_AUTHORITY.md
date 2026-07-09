# Decision Authority Map

Who may do what to a model decision. This is the contract that months of
debugging converged on — most agent regressions came from a "helpful" guard
quietly exceeding its authority. Read this before adding or changing any guard
in `agent-loop.js`, `agent-executor.js`, or `agent-planner.js`.

**The one rule:** the model decides *what* to do; the harness decides *whether
it's allowed* and *what happens around it*. A guard may **block** an action and
say why in an observation. A guard may **never substitute** a different action,
target, or content of its own invention.

## Authority tiers

### Tier 1 — The model owns (harness must not override)

- Tool choice and arguments for each step.
- File content it generates (whole files and edit programs).
- Which file a repair targets.
- Project naming and routing intent (`trust model judgment; regex only as a
  last-resort fallback` — the keyword "intent" heuristic that renamed Tetris to
  "full-game" was removed for a reason).
- The final message's substance.

### Tier 2 — Block with an observation (never redirect)

Guards here return a failure/observation and let the MODEL pick the next move:

- Structure-breaking writes/edits, duplicate-id saves (`agent-executor` save guards).
- Oscillation (file returned to a prior content state), repeat-read caps,
  polish-loop re-reads of just-written files (`agent-loop`).
- Command policy: blocked commands and shell metacharacters; ask-first pauses
  for installs/publishes (`classifyAgentCommand`).
- Delete without an explicit user request; delete confirmation pause.
- `write_file` over an existing file (must read+edit instead).

### Tier 3 — Transform presentation only (content-preserving)

- `sanitizeAssistantText`: strips leaked tool markup, transcript markers,
  orphaned fence labels — display cleanup, never meaning changes.
- `sanitizeAgentGeneratedFileContent`: unwraps code fences, JSON-escaped
  bodies, and tool-call envelopes to the inner content. Unwrap ≠ rewrite —
  the v6.1.x lesson: a "helpful" tail-delete heuristic here truncated real
  TSX files. No content heuristics beyond whole-wrapper removal.

### Tier 4 — Deterministic sequencing (harness-owned mechanics)

The harness may decide *when* things happen, not *what* the model builds:

- Phase scoping (`.aiexe/plan.md` is the cross-run source of truth), phase
  completeness fill (may ADD uncovered expected files to a phase's tasks,
  never remove or reassign the model's tasks).
- Validate-before-final, run_app smoke run before finishing browser projects,
  auto-finalize when requirements are met, checklist ticking.
- Timeouts, retries, inference aborts, budget stops.

### Tier 5 — Parse repair (infer intent, never invent it)

`parseAgentDecision` may recover a malformed decision (e.g. infer `read_file`
from a path-only JSON, accept array-form edit programs). It restores what the
model clearly meant; it must not choose a *different* action than the output
implies.

## The wall of removed hijacks (do not rebuild these)

Each of these shipped once, looked helpful, and corrupted runs until removed:

1. **Duplicate-repair wrong-file substitution** — guard redirected a repair to
   a different file than the model chose.
2. **Repeat-edit → planned-file hijack** — a repeated edit got silently
   retargeted at the next planned file.
3. **Read → edit escalation** — a read decision was "upgraded" to an edit with
   invented content.
4. **Read-all-before-edit injection** — forced reads the model didn't ask for.
5. **Keyword intent routers** — phrase-list routing/naming that overrode model
   judgment (v2.6.3 overfit; project-name override).
6. **Content-tail heuristics in the file sanitizer** — deleted legitimate JSX
   (`<Header>` matched a `<head` regex) from complete files.

If a new guard needs to *change* what the model did rather than block it,
that's a prompt problem or a Tier 5 parse problem — fix it there.

## Working style for new guards

- Prefer a pure function with a unit test in `scripts/*_test.js`
  (`deriveAgentFailureSignature`, `evaluateRepeatedRead`,
  `markPhaseTaskLiveProgressForPath` are the pattern).
- Block on objective, high-confidence failures only (syntax, const-reassign);
  subjective quality checks stay advisory — validation must not stop the agent
  from finishing (validation tiering).
- Every block's observation must tell the model what to do INSTEAD, in one
  sentence, or the run treadmills.
