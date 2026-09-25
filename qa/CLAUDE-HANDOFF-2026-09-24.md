# Codex QA handoff to Claude Code

The user asked Codex to tell you what it has done so far. This is an informational handoff; no additional implementation request is implied. Review the current diff before changing anything: the checkout includes your existing uncommitted work and Codex changes. Do not reset or overwrite it.

## Current state

- Local packaged preview built and launched directly: **13.2.6**, build tag `form-flow-checks`.
- Build directory: `build-mac-preview/`; binary: `build-mac-preview/ai_exe_gui_mac.app/Contents/MacOS/ai_exe_gui_mac`.
- No commit, push, deployment, or release. Version follows the project's odometer scheme.
- Only `deepseek-flash` was available in the UI; no alternate-model comparison was performed.
- Keep vulnerability auditing local. Earlier authorization for package downloads does not authorize a public dependency audit.

## AI.EXE fixes made by Codex

1. Offline HTML verifier was discarding `defer` and running head scripts before body DOM existed. Preserve deferred external classic-script order after body parsing. Browser-correct apps must not be rewritten to accommodate a broken verifier.
2. Assertions poll briefly for asynchronous UI changes instead of assuming completion after 40 ms. Current bound is one second per assertion; not unlimited async verification.
3. Accept smoke results only from the current iframe; unfinished checks remain unverified.
4. Preserve actual runtime diagnostics. Removed keyword-based module inference and regex rewriting of module syntax; structural checks use the bundled JS parser on original source.
5. Track actual visible file line ranges in model context. Permit rereading omitted content and prioritize newly requested ranges while retaining a bounded loop guard.
6. Removed the deterministic startup narration generator that duplicated the main model introduction. Fresh packaged QA showed one intro before the file/tool group.
7. Prompt guidance no longer recommends weakening compiler settings to get green builds. Plans are hypotheses to revise from evidence. Requested interaction checks must be attempted; startup-only success is insufficient.
8. Latest 13.2.6 checker adds `{fill: selector, text: value}` and `{select: selector, value: optionValue}`. It validates disabled/read-only controls and rejects steps mixing actions and assertions rather than silently dropping assertions. Tool schema, live prompt and fallback prompt updated.

Primary areas: `ui/ai-exe.js`, `ui/agent-executor.js`, `ui/agent-loop.js`, `ui/prompt-core.js`, `ui/prompts/developer_agent_decision.md`, and regression scripts. This is not an attribution of every dirty line: inspect the diff against your prior work.

## Verification

- `node scripts/agent_verification_scenarios_test.js` passes. Covers module parsing, context ranges, delayed assertions, defer scheduling, foreign iframe messages, original errors, fill/select and mixed-step rejection.
- `node scripts/queue_steer_and_run_errors_test.js` passes.
- Related earlier passing suites and detailed limits are listed in `qa/verification-2026-09-24/results.md`.
- `node --check ui/ai-exe.js` and `cmake --build build-mac-preview -j 2` passed.
- Native packaged preview and Chrome were exercised; not merely source checks.

## Complex project experiment

Disposable generated project: `/Users/macbookair2020/Downloads/parcel bench qa` (outside repo).
Chat: `chat_mufwntll_db6orc`; separate invoice chat: `chat_mufwp0ry_8vep7n`.

- Nine-file offline inventory/order app: integer cents, multiple order lines, stock validation, cancellation, undo, CSV import, search/filter, persistence.
- Initial Agent build had blank inventory/orders and zero displayed sales, though order state changed. Unhinted repair guessed alias/undo problems and failed.
- Actual cause: `PB.render.init()` never called, leaving DOM references empty. A guided Thinking run fixed it and passed 21 checker steps. This is NOT a controlled Think-vs-normal comparison: diagnostic hints and runner capabilities also changed.
- Chrome independently passed $28 order (2 Tea + 1 Mug), stock 3/2, cancel 5/3, undo 3/2, reload persistence, literal HTML-like customer names, over-stock and fractional rejection, and atomic invalid CSV rejection.
- Adversarial input exposed prototype-key collisions: duplicate `__proto__` SKU rows accepted, `constructor` order succeeded with empty lines.
- Agent changed CSV duplicate tracking to Map, but neglected order aggregation and repeatedly chased a Cancelled card hidden by the Active filter. It removed notifications while attempting to deduplicate them. Stopped this non-converging run; UI correctly showed Interrupted by you / Progress saved / Continue.
- Codex then directly corrected the disposable fixture: null-prototype order aggregation map and restored single confirmation/cancel notifications, with only one notification subscription. No name denylist.
- `node qa/complex-agent-2026-09-24/domain-checks.cjs` passes all six suites. Chrome verified a real constructor SKU order, stock deduction/restoration, single toast, quoted comma name, and rejection of duplicate __proto__ rows.

## Remaining gaps — do not call these fixed

- Model repeatedly speculates about root causes, misses explicitly requested checks, and repeats stale checks instead of addressing the latest regression. Large repeated source context was observed; contribution to quality is unproven.
- Conclusions can be verbose, ask for already-authorized checks, or assert false missing files (QA Tally Two CSS existed and was styled).
- Cross-chat invoice response was correct ($34) but waited for the initial Agent run to finish. Chat switching worked; truly concurrent responsiveness did not pass.
- CSV replacement can remove products referenced by active orders. Historical totals remain intact, but those orders cannot then be cancelled. Inventory lifecycle behavior still needs design/implementation work.
- Requested fixture name QA Defer Final became qa defer probe (1), despite creating a separate folder. Naming provenance is unresolved.
- Mini Sheets is not certified functional by these tests.

Full evidence: `qa/verification-2026-09-24/results.md` and `qa/complex-agent-2026-09-24/results.md`. Raw inference records are local in `data/logs/agent_raw.jsonl`; use the bounded `scripts/raw_log.js` reader rather than dumping potentially sensitive prompts.

Prefer evidence-led diagnosis, clear context and reliable tools over brittle regexes or canned conclusions. Model changes should be evaluated with the same fixtures and expected results before attributing improvement to the model.
