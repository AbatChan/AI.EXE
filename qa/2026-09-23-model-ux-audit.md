# AI.EXE live model and UX audit

Build: 12.5.2. Provider: DeepSeek, model: deepseek-flash. Started 23 September 2026, 23:26 Africa/Lagos. Synthetic data only. Existing checkmate chess project was not a test-edit target.

## Verified so far

- No-clue prompt `do it`: asked for clarification without changing anything, but injected unrelated autopilot details and renamed the chat Autopilot Change Request.
- Thinking + CSV + Markdown: exact 380 NGN total, West 120/East 60/North 200; identified duplicate A2, unknown A6 amount, and negative adjustment A5; ignored quoted prompt injection. Thought disclosure rendered. Overlong answer; falsely said no files were read.
- Canvas + thinking + search + context/history: generated an artifact, retained totals, NGN/violet and Assumptions. Search displayed 8 sources; artifact opens and links back to chat.
- Canvas factual/requirements errors: invented 1250-line cap and case-insensitive IDs; conflated combined Web Storage quota with localStorage; claimed iOS Safari private mode blocks writes entirely. Current MDN describes storage as functional in private browsing, with data deleted on close, and 5 MiB each for local/session storage.
- Canvas UX: simple two-column table shows horizontal scrollbar; nested card and repeated titles consume substantial space.
- All modes enabled: Canvas and Agent both remain shown as on; agent routed after a scope confirmation. Confirmation was redundant for explicit NEW isolated project. Trace shows the model chose agent, then a lexical override forced confirm (`explicitNewProjectIntent: false` for NEW isolated project).
- Agent build: created /Users/macbookair2020/Downloads/lantern qa. Planner retained stale case-insensitive requirement despite latest correction. Per-file writer prompt has latest user request but lacks attached dataset, Canvas brief, order_id schema and 380 total. Initial generated app drifts to account attachment-count reconciliation. Plan showed 5/5 before README write finished.

## Baseline checks

- 87 JavaScript scripts passed in preceding UI verification.
- All 25 backend suites passed in this run outside the outer sandbox. Initial restricted run failed smoke_sandbox, smoke_generate, smoke_pdf due to sandbox-exec Operation not permitted; these all passed in the valid environment.

## Sources checked

- https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API
- https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria

## Evidence pointers

- data/logs/debug_trace.jsonl, starting 2026-09-23T22:26 UTC
- Test chat IDs: chat_mueo9wlm_n1ea9x; chat_mueockox_v2fxas
- data/logs/agent_raw.jsonl, plan at 22:32:11 UTC and index.html writer at 22:32:21 UTC
- ui/preflight-router.js:109 lexical new-project detector; ui/agent-planner.js:882 per-file writer prompt
- Synthetic fixtures: /private/tmp/aiexe-qa-20260923/brief.md and orders.csv

## Generated app runtime

- Imported original orders.csv: accepted all 7 rows into the wrong schema, showing NGN 0 and 14 unknowns instead of 380. Required-header validation failed.
- Region filter worked; deleting a row and clicking Undo restored it.
- Editing a stated amount to 80 did not update totals or persist after reload.
- CSV export succeeded: Downloads/lantern-qa-audit.csv exists with 7 rows, but fields reflect the wrong schema. Browser download-event timeout was a test harness limitation.
- Initial completion claimed the complete check passed despite the wrong data model and unverified interactions.
- Four generated files totaled approximately 86 KiB; README alone was 23.33 KiB. Initial run displayed about 81.9k tokens.
- Precise repair follow-up included the full schema and fixture inline. Read operations worked; whole-file rewrite was rejected by AI.EXE because script.js exceeds its 34,913-character safe rewrite threshold. It then attempted targeted edits.

## Remaining tests

Original CSV runtime and all named mode combinations tested. Extended CSV edge fixture is prepared but cannot meaningfully pass until schema repair succeeds. Storage-denied behavior, full keyboard coverage and exhaustive action permutations remain unverified.

## Recovery and responsiveness

- At 390x844, header/actions stack within viewport and remain legible. Overall product/data meaning is still incorrect. Viewport override reset.
- Pause stopped the UI immediately during targeted edit, after about 72 seconds. No successful repair had been applied.
- Canvas incorrectly packaged the interruption notice as a new 39-byte document.
- Continue displayed Thinking for approximately 100 seconds with no resumed tool receipts; Explorer then showed Open project instead of its files. Stopped this continuation. Backend /health still returned ok. Root cause not established.
- Relaunch restored Lantern QA and its files. Testing a separate bounded file-operation chain after restart.

## File-operation chain

- After relaunch: create, read, rename, mkdir, move, final read all completed in 22 seconds. On-disk qa-check/qa-probe-renamed.txt was exactly LANTERN-PROBE-42 (16 bytes).
- Agent tried reading the destination before creating/moving into its directory, then recovered.
- Plan showed 1/1 immediately after file creation although rename/move/read remained.
- Run displayed approximately 97.1k tokens for this trivial probe; prompts repeatedly carry substantial irrelevant project content.
- Canvas converted the completion receipt into a 363-byte artifact with an awkward auto-title. This hides a simple result behind an extra click.

## Prioritized remediation

1. Carry attachment contents, relevant Canvas content and latest corrections into every file-writing/editing stage, with clear source labels.
2. Completion checks must exercise requested data and observable behavior. A successful server start is not proof of functional correctness.
3. Resume/cancellation needs a regression reproducer for the stalled continuation and disappearing Explorer.
4. Keep simple completion and interruption notices in chat even when Canvas is enabled; create artifacts only for actual deliverables.
5. Update progress from completed tool evidence, not existence of expected files.
6. Reduce repeated prompt payloads and improve recovery when a generated file exceeds the editing limit.
7. Honor explicit new-project intent without brittle exact-phrase overrides; avoid finance assumptions for clue-free prompts.
8. Ground web claims in source text and distinguish source facts from added assumptions.

## Delete probe outcome

- Explicit delete-only request first caused an unrequested edit from LANTERN-PROBE-42 to LANTERN-PROBE-42-FINAL and irrelevant file/contract validation. The model narration falsely called validation requested.
- Then app presented its Trash confirmation; confirmed the disposable test-file deletion. Explorer showed qa-check 0.
- Completion showed Edited 1 file with an Undo affordance and another Canvas artifact instead of emphasizing the deletion. Approximate run cost: 51.2k tokens, 30 seconds including confirmation.
- Final disk check: probe is absent; qa-check directory exists.

## Overall result

Not a pass for the combined workflow. Chat reasoning and basic file tools work, but cross-stage context, model scope discipline, actual result validation, pause/resume reliability, progress accuracy and artifact selection have reproducible failures. The generated dashboard remains incorrect; no successful repair is claimed. Current AI.EXE build remains 12.5.2. This audit changes only QA documentation in the source repository.

## Remediation verified on 24 September, v12.5.7

This section supersedes the earlier build-status statements above. Work remains local; no commit, push, or release.

- Canvas no longer wraps plain completion/interruption text merely because its toggle is on. Explicit document payloads still create Canvas documents. Native live tests with Canvas and Agent enabled returned ordinary chat receipts.
- File-generation context now carries original attachment previews, the original and recent Canvas documents, and recent user corrections. Sources have size limits and truncation labels; quoted file/document content is explicitly untrusted data. A live generated JSON fixture retained the original five-column orders schema, seven rows, 380 total, regional totals, null amount and case-sensitive ID rule. Its file contents were independently inspected.
- Checklist completion requires positive verification evidence tied to the current mutation count. Keyword matches and unconditional final ticks were removed. One repeat audit is allowed after repair, and final receipts list unverified criteria. This remains model-assisted verification, not a proof of every behavior.
- Preview startup wording no longer claims the complete check passed.
- The native WKWebView bridge now rejects messages from subframes, other webviews and URLs other than the loaded application file before parsing the command. Native workspace actions still work in the rebuilt preview. This is a source-level boundary fix; no claim of exhaustive exploit coverage.
- Workspace status probes have a three-second frontend timeout, failed snapshots preserve the current Explorer, and cancelled preflight waits cannot continue the cancelled request. Agent mode bypasses the Canvas-only classifier. The original long-running resume stall has not been reproduced or proven fully resolved.
- Model-provided new/current workspace intent now reaches the router, and the later same-chat override respects an explicit choice. The live final test used the current project with no scope question.
- Read-back after writing is allowed; the old just-written shortcut blocked an explicitly requested verification. Final live receipt contains actual write_file and read_file results for the exact 10 bytes VERIFY-380.
- Large edit excerpts explicitly disclose omitted content. Rename/move/delete prompts require preserving contents unless editing is separately requested. These prompt changes reduce errors but are not a security enforcement boundary.
- UI typography, gray/white interaction colors, colored diff counts, loader placement, narration truncation and excessive activity spacing were addressed in preceding builds 12.5.4/12.5.5; the actual rendered activity fixture was checked.

Validation: native CMake build passes (existing deprecated AppKit file-type API warning); all 88 JavaScript scripts pass after updating obsolete checklist/read-block expectations; local backend access-token tests pass all five checks; archive-extraction smoke test passes. git diff --check passes.

Audit scope: user explicitly chose local-only dependency auditing. No public npm advisory audit was completed. Installed dependency advisories therefore remain unchecked; do not claim all dependencies or all vulnerabilities are cleared.

QA artifacts: the initial context proof is in Downloads/lantern qa (1)/qa-context-proof.json. During the first scope prompt, the test driver submitted the default new-project choice rather than the intended current choice; this is not attributed to the model. The final v12.5.7 test deliberately used that disposable folder and added qa-readback.txt. Original Lantern QA application files were not repaired by these bounded probes.

Remaining limits: original generated dashboard still needs a complete functional rerun/repair; pause/resume under slow inference, storage-denied UX, exhaustive keyboard/action combinations and comprehensive native exploit testing are not certified. Prompt volume is still high (final tiny read-back run displayed about 80.7k cumulative tokens). Stronger source and completion prompts do not guarantee factual web claims or prevent every model scope mistake.
