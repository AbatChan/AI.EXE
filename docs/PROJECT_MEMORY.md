# AI.EXE Project Memory

Last updated: 2026-06-10

## Aim

AI.EXE Phase 1 is a Windows-first, self-contained, offline software-engineering assistant. The release target is a native executable bundle that launches into chat, runs local inference, generates standalone local software files, and includes diagnostics, sandboxed execution, persistent local memory, logging, rollback, and Windows packaging/validation.

The macOS app is a preview/dev host. Current development uses hosted providers, especially DeepSeek, to stabilize the agent harness before strict offline release packaging. Strict offline builds must disable hosted providers with `AI_EXE_ENABLE_REMOTE_PROVIDERS=OFF`.

## Current Build

- Version: `v2.5.2`
- Build tag: `fourth-door-closed`
- Odometer version convention: patch/minor are single digits `0`-`9`; after `x.9`, roll to the next slot. Bump every change.
- Current agent brain in preview: DeepSeek provider, with `deepseek-chat` used in settings.

## Standing Conventions

- Reliability belongs in the harness, not in brittle prompts or a weak model.
- Prefer model semantic judgment over keyword/regex gates. Regex can exist only as a thin fallback.
- Validation blocks only crash-class issues. Cosmetic or subjective issues are advisory.
- Keep comments concise. Put rationale in docs, memory, or PR notes.
- Generated apps should be standalone and local-first: vanilla browser files, local scripts, or other local runnable stacks. Do not require a hosted server, cloud database, external API, or npm/build pipeline unless the user explicitly asks and the limitation is explained.

## Confirmed Changes So Far

- Fuzzy `edit_file` matcher: exact, whitespace-normalized, then Levenshtein similarity `>= 0.9`.
- `parseAgentDecision` repairs path-only and range/offset JSON into safe `read_file` decisions.
- Read guards are truncation/range-aware and allow mutation-aware re-reads.
- Edit oscillation guard blocks flip-flopping a file back to a prior content state.
- Tool timeout is idle-progress-based for large file generation, with a hard cap.
- Abandoned decision/tool inference is aborted so stopped runs do not keep working in the background.
- Remote chat stream stallguard aborts dropped streams, retries once, then fails cleanly.
- Transient remote inference drops retry once; auth/credit failures do not retry.
- Validation tiering removed blocking CSS/id cosmetic gates and kept crash-class checks.
- `getJsReassignedConstIssue` catches `const x = ...; x = ...` runtime failures.
- Pasted errors in an open workspace route to Agent fix through model intent classification.
- Agent plan checklist uses 3-5 grouped `done_criteria` items and renders as structured checkboxes.
- DeepSeek thinking mode is disabled with `thinking: { type: "disabled" }`.
- Composer has a context token ring with custom tooltip and char counter.
- Agent elapsed timer is visible during agent runs and inspect.
- Continue button posts a visible `Continue` user bubble.
- Completion messages are AI-written instead of a fixed template.
- Successful `edit_file`/`write_file` observations echo the applied changes, so the planner does not re-read files it just modified to "verify" them.
- Completion messages are grounded in real per-file diffs (CHANGES block from `buildAgentChangeSummaries`); the model may not claim effects that have no supporting changed lines.
- Before accepting a finish on a run that edited existing files, one evidence-based audit (`verifyAgentDoneCriteria`) checks the actual diffs against the plan's done criteria and nudges once when a change clearly cannot produce the required outcome (catches no-op fixes). Advisory: infra failure means skipped; a reaffirmed finish is always accepted.
- `validate_files` runs a model-driven advisory cross-file coherence review (`reviewAgentProjectCoherence`) after mechanical checks pass — unit/default mismatches, conflicting initializations, dead wiring. Non-blocking, max 5 notes.
- "Checked files" header state comes from a structured `hasIssues` flag, not regex over detail text.
- Token ring counts agent-mode inference: during a run the numerator is the current inference call's prompt+output estimate and the tooltip shows the cumulative run total.
- Structural-regression guard: an edit_file/rewrite/write_file result that would break a previously-sound file (unbalanced required-close HTML tags, JS parse error, unclosed CSS, invalid JSON) is rejected before saving (`getStructuralIssueForPath`); validate_files also flags unbalanced HTML.
- write_file full-rewrite recovery is allowed after ONE failed edit on the path, or whenever the file's current content is structurally broken (was: two failed edits, which trapped recovery).
- A write/edit retry with genuinely different content is not a "duplicate"; duplicate auto-redirects may only target a non-mutating step or the SAME file (a blocked index.html fix was being redirected into from-scratch edits of script.js).
- parseAgentDecision infers write_file from path + substantial content (and edit_file from a path + `{"edits":...}` payload); the no-action fallback parser now extracts `content` at all.
- Every agent inference call logs `agent_inference_usage` (promptChars/outputChars/approx call+run tokens) to the debug trace.
- Removed the repeat-edit hijack in `repairDecisionBeforeExecution` that discarded the model's edit and substituted "update the next planned file" with empty content (it forced inventing changes for files needing none, tripping the streak breaker on finished work). Plan coverage stays advisory (PENDING_REQUIREMENTS + final nudge + criteria audit). The read-before-coordinated-edit redirect remains.
- `parseAgentEditProgram` accepts the top-level array form `[{"find":...,"replace":...}]` and defaults a missing `op` to `replace` (find+replace) / `append` (bare text).
- Guard-stop final messages (`duplicate_target_blocker`, repeated-failure streak) now report the work that actually landed via the grounded completion, with the blocker as a trailing note (`buildStoppedWithWorkText`).
- `isSafeDuplicateRedirect` also bans ESCALATION: a blocked non-mutating decision (read/list/search) may never be auto-redirected into a mutation — a synthesized empty-content edit made the generator invent changes the model never intended (junk inline-style edit on a finished file).
- Token ring keeps the run total readable after a run ends ("last agent run ≈X tok"; reset at next run start, not at stop) and accumulates a session total ("session ≈Y tok"). The bare ring number outside a run is chat-context fill, not usage.
- Per-response revert: each completed agent message stores a `revert` snapshot in agentMeta (pre-run content + per-file LCS line stats, first touch wins; created files revert by trashing; per-file 200K / total 800K caps). Rendered as an edit-summary card (`buildAgentEditCard`, chat-renderer) at the BOTTOM of the bubble after the final message (just above the copy/retry/time icons), not inside the work panel; only when a final message exists. Non-bold typography. Aggregate "+A -R" hover-swaps to "Review changes ↗" which expands + scrolls to the work panel; file rows reveal that file's edit row inside the work panel and open its diff drawer (`revealAgentWorkPanel`, rows tagged `data-activity-path`) — they do NOT open the file. Undo⇄Redo stays. Edited files only; create-only responses get no card; Undo still reverts every snapshot file. `revertAgentMessageEdits` in ai-exe.js; `buildRunRevertSnapshot` + `countRunLineDiffStats` in agent-loop.js.
- The agent KNOWS about reverts: each revert/re-apply appends a note to `chat.agentWorkspaceNotes`, injected as "WORKSPACE EVENTS (authoritative)" into the planner's chat-history context, so the next run treats current disk state as the source of truth instead of re-applying rejected edits. Trace: `agent_edits_reverted`.
- Window-driven budgets for every provider (v2.4.1): `getAgentExpandedReadChars` derives from `MODEL_CONTEXT_WINDOWS` for ALL providers — local uses its real 32K window (capped 24K chars for prefill speed, no longer hard-coded to 8K), unknown models (custom HF, window unconfirmed) default conservatively to 16K. Sibling context has a middle tier: when a file doesn't fit the budget, its HEAD (up to 12K chars — where vars/defaults/refs live) + SIGNALS is included instead of dropping blind to signals only.
- Chat-grade sibling context (v2.4.0, THE structural quality fix): plain chat writes all files in one pass seeing everything — that is why its multi-file output is coherent while the agent's per-file generations drifted (conflicting defaults, dead wiring). `buildAgentProjectStateContext` now includes the FULL current content of sibling expected files (CURRENT <path> sections, "make your file agree with it exactly") when `getAgentExpandedReadChars()` > 20000 (remote large-context providers; up to 60K chars), excluding the prompt's own target file; small/local providers keep the compact SIGNALS. Applies to write/edit/rewrite generation prompts.
- Polish-loop breakers (`lastWriteWithoutFailureSince`, agent-loop): after a clean write_file with no real failure for that path since, both reading the file back AND another full rewrite of it are blocked with steering observations ("the saved file IS the generated content; fix specifics with ONE targeted edit_file, else validate and finalize"). Each rewrite pass regenerated a whole file (~3K output tokens), so this is also the token-burn fix. Guard-generated blocks carry `_guardBlock: true` and are ignored by the failure-since walk-back (and by each other), so guards can't release one another. Traces: `agent_read_after_own_write_blocked`, `agent_repeat_rewrite_blocked`.
- write_file overwrites now capture the pre-overwrite content into `originalContent` (it was declared and NEVER populated for overwrites — revert baselines, edit-card stats, and completion CHANGES were diffing against an empty "before" whenever a run's first touch on a file was a full rewrite).
- Revert semantics: per-response — Undo restores files to their state just before THAT response; to reach an older version, undo the earlier responses' cards too (tooltip now says so).
- Fourth hijack door closed (v2.5.2): the "read all planned files before any edit" redirect in `repairDecisionBeforeExecution` discarded the model's edit to force reads of files irrelevant to the fix — in the Aura retry the model had the correct file:// diagnosis and its script.js edits were hijacked into reads until the inspection budget + duplicate gates deadlocked the run. Removed (the executor already requires the edit TARGET read); the keyword-based "coordinated frontend edit" helpers it used are gone too. Also: exact-repeat search_files with no mutation since is now blocked with "no matches MEANS the text is not in any file" (the run burned 3 steps re-running the same search; events carry `searchQuery`).
- file:// link knowledge (v2.5.1): multi-page sites generated with root-relative links (/menu.html) break when opened from disk — the user sees file:///menu.html in the browser while the source contains no "file:///" strings, so the agent could not diagnose it. Now: the decision-prompt ENVIRONMENT rule and the HTML generation hints state links must be RELATIVE (with the file:/// symptom named); `validateWebProjectConsistency` adds an advisory listing root-relative href/src links. Also: the inspection-budget guard blocks search_files at 12 (reads stay 8) — its own steer message recommends "ONE search_files query", which the old shared cap then blocked.
- No phantom finishes (v2.5.0): auto-finalize now requires at least one successful workspace mutation unless the plan is an analysis task — an inspect-only plan once "completed" after a single read and the completion model invented "I've created sample-tasks.json". Completion prompt receives `WRITTEN_FILES: (none — NO files were created or modified this run)` explicitly, with a template rule that claiming creation then is a lie. "still looks incomplete for the requested MVP" demoted from blocking to an advisory note ("may be thinner than the requested feature set") — it had false-flagged a finished 20KB kanban app because `looksLikePlaceholderImplementation` matched the literal `todo:` (now removed from the placeholder list; kanban columns are named todo).
- Duplicate-id guard + advisory styling check + mixed-revert honesty (v2.4.9): `getHtmlStructureIssue` now flags duplicate HTML ids (the MiniLink run re-added its own page sections — the structural edit guard now REJECTS such saves and validate_files reports them). The "important classes are not styled" heuristic moved from blocking to advisory (`validateWebProjectConsistency(…, advisoryOut)`) — it had trapped a run in 3 repair attempts; cosmetic per validation-tiering. Edit card titles mixed responses honestly: "Edited 1 file · 4 new files" and the Undo tooltip states created files are trashed too. New HTML hints: unique ids; when a change replaces existing structure, remove the superseded markup in the same pass.
- Edit-card row collapse fix (v2.4.8): `.msg-agent-editcard-row` is `display:flex`, which overrides the `hidden` attribute (UA `[hidden]{display:none}` loses to any author display rule) — all rows were always visible and "Show N more files" toggled nothing. Added `.msg-agent-editcard-row[hidden]{display:none}`. Rule of thumb: any element styled with an explicit `display` that is toggled via `hidden` needs the `[hidden]` override.
- Enter-key queue + canvas voice (v2.4.7): the THIRD send-gating layer — `handleKey` (composer keydown) swallowed Enter globally while any op ran, so the v2.4.4 queue never fired from the keyboard; now per-view like the button/handlers. `testPerViewSendGating` (mode_priority_test) pins all three layers via source extraction (handleKey, handleSendButtonClick, sendMessage queue, endInferenceRequest dispatch). Canvas intro/closing rewritten as voice-not-script (`<intro_examples>`/`<closing_examples>`, "vary every time, never reuse an opener/closer, never copy examples verbatim, never say canvas/artifact/tag") — the model had parroted the single example's "Here you go — hope it helps!".
- Canvas flow (v2.4.6): the canvas router prompt now expects CANVAS for any content-creation request (toggle = user intent; CHAT only for conversation/follow-ups); the keyword fallback router was REMOVED — `inferReplyModeDeterministically` returns 'canvas' (trust the toggle when no model judgment is available; the canvas prompt itself lets the model answer conversationally). `commitAssistantMessage` only canvas-wraps plain output when the turn actually resolved to canvas (`options.canvasModeResolved`; the global-toggle wrap on chat-routed turns produced broken artifact cards with mangled titles). Canvas structure: intro sentence → artifact (live loader appears when the tag starts streaming) → ONE short friendly closing line ("here you go…" beat, context-specific) — replaced the "no outro" rule.
- Thinking panel spacing (v2.4.6): `.msg-thought-panel` margin-bottom 20px + drawer body bottom padding so the gap to the final message breathes consistently open or closed (user screenshot request).
- Friendly provider errors (v2.4.5): `humanizeProviderErrorMessage(label, status, body)` maps 402/credits → "out of credits, top up or switch provider in Settings", 401/403 → key rejected, 404/model-not-found → pick a different model, 429 → rate-limited, 5xx → provider-side problem; generic branch keeps a short detail. Used by both streamers + the non-stream completion path; `appendErrorMessageToChat` runs `humanizeAssistantErrorText` as a display safety net for any missed "X request failed (NNN): {json}" string. Retry/hard-fail logic keys off `httpStatus`, not message text.
- Send queue (v2.4.4): sending in another chat (or a new chat) while an operation runs now posts the user message immediately and queues the request (`queuedSends` FIFO, in-memory); `endInferenceRequest` dispatches the next job at idle (50ms decouple). The owning chat still blocks with "press stop to interrupt"; sends from elsewhere never cancel the running op. Trace: `send_queued`. Queue is lost on reload (message stays, answer doesn't start — retry covers it).
- Think mode native reasoning (v2.4.3): with Think ON, the DeepSeek thinking-off override is skipped and `reasoning_content` stream deltas are wrapped as `<thinking>...</thinking>` so the existing Thoughts UI renders native reasoning; for all models (incl. non-thinking) the prompted `<thinking>` scratchpad instruction still applies. Anthropic extended-thinking params not wired yet (prompted CoT only).
- Manual context reaches agent runs (v2.4.3): `getChatManualContext(chatId)` is injected into `planSpec.projectContract` at run start, so the plan summary, every decision prompt, and all file-gen/edit/rewrite prompts carry "USER CUSTOM INSTRUCTIONS". Previously only chat prompts honored the Context action.
- Per-view click guards (v2.4.2): the composer plus menu and every mode/attach/context handler had their own global `pendingInferenceCount > 0` early-returns (separate from the disabled attributes fixed in v2.3.8) — that is why the plus menu still refused to open in a new chat while another chat ran. All 15 composer handlers now use `pendingInferenceCount > 0 && isCurrentViewInferenceChat()`; only `continueMessage` stays globally gated (it starts a new operation).
- Per-chat inference gating: a running operation locks the composer (plus menu, modes, attach, mic) and shows cancel-mode ONLY in the chat that owns it (`setSendLoading(loading, loadingHere)`); other chats keep a usable composer. Clicking send elsewhere can no longer cancel the invisible run — it shows a transient composer notice instead (single-operation architecture: a second op still cannot start; Continue stays globally gated). `isCurrentViewInferenceChat` uses the agent run owner (`agentRunChatId`) during between-call windows. The "Xs" timer and token-ring run stats render only in the owning chat; `renderActiveChat` re-syncs gating + reattaches the live row on every chat switch.

## Open Work

- Fix the recurring edit-timeout root cause: duplicate repair can still lead to large from-scratch rewrite attempts.
- Token ring is only in the composer, not chat/inspect display.
- Token ring tooltip refreshes live while chat/inspect/agent status streams are active.
- Planner prompt assembly can expand one already-read large source file from stored full read content when the selected provider has enough context, without raising every historical tool observation cap.
- Planner prompt assembly injects concise `CURRENT_CODE_DIAGNOSTICS` from stored file content and skips large-read expansion when diagnostics already identify a concrete code error.
- JS validation now reports content-derived syntax locations for unmatched closers/unclosed blocks, and suppresses const-reassignment checks until parse errors are fixed.
- Fuzzy edit matching refuses ambiguous non-exact anchors instead of guessing a splice location.
- Normal chat now gets an explicit Agent-mode ON/OFF instruction. When Agent mode is off, it must provide code inline or ask the user to enable Agent mode, never promise to create/write/place files.
- Elapsed timer is not shown for plain chat.
- Generated file count can undercount because of cosmetic grouping.
- Collapse the remaining README/CSS/content validators into a smaller, clearer validation layer.
- Run the Windows release build, package with real `llama-cli.exe` and `model.gguf`, and validate on the RTX 3060 target.
- Run acceptance: prompt -> generated files -> generated output runs independently without AI.EXE.

## Verification

Focused tests passing as of this memory update:

- `npm run test:preflight-router`
- `npm run test:agent-retry-context`
- `npm run test:agent-fuzzy-edit`
- `npm run test:agent-decision-parse`
- `npm run test:agent-checklist`
- `npm run test:agent-const-reassign`
- `npm run test:agent-grounding`
