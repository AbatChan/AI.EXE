# AI.EXE Project Memory

Last updated: 2026-06-08

## Aim

AI.EXE Phase 1 is a Windows-first, self-contained, offline software-engineering assistant. The release target is a native executable bundle that launches into chat, runs local inference, generates standalone local software files, and includes diagnostics, sandboxed execution, persistent local memory, logging, rollback, and Windows packaging/validation.

The macOS app is a preview/dev host. Current development uses hosted providers, especially DeepSeek, to stabilize the agent harness before strict offline release packaging. Strict offline builds must disable hosted providers with `AI_EXE_ENABLE_REMOTE_PROVIDERS=OFF`.

## Current Build

- Version: `v2.2.6`
- Build tag: `ring-tooltip`
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

## Open Work

- Fix the recurring edit-timeout root cause: duplicate repair can still lead to large from-scratch rewrite attempts.
- Token ring is only in the composer, not chat/inspect display.
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
