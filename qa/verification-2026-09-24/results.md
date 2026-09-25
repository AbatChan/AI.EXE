# Agent verification audit — 2026-09-24

Local preview: 13.2.1 baseline; 13.2.2 intermediate; 13.2.3 corrected script scheduling.
Model: deepseek-flash (selected in the app).

## Observations

- QA Tally One: Agent generated an offline counter, then claimed several interaction checks failed. In Chrome, Reset/Subtract at zero showed 0; Add/Add/Subtract showed 1; reload preserved 1; delayed Saved appeared.
- On 13.2.2, Agent repeated the tests and moved DOM queries into init(). Its 12 checks then passed. This was a workaround for an AI.EXE verifier defect, not evidence that the original app was broken: the source used a deferred head script, which Chrome runs after parsing, while the smoke inliner discarded defer.
- Claude's most recent Mini Sheets run repeatedly chased a module diagnostic. The old smoke diagnostic could replace actual errors when a keyword and any syntax failure coincided. This review does not certify Mini Sheets functionality.

## Product fixes

- Preserve deferred external-script order after body parsing in offline smoke HTML.
- Poll expected values for up to one second rather than treating every UI update as synchronous.
- Accept smoke messages only from the current iframe; report unfinished runs as unverified.
- Preserve runtime errors alongside explicit module-preview limitations; remove keyword-based module inference.
- Use the already-bundled JavaScript parser on original module source; no regex rewriting of imports/exports.
- Track the line ranges actually carried in the next prompt. Allow rereading omitted content, prioritize newly requested ranges, retain the bounded read-loop guard.
- Remove prompt advice to weaken compiler flags to pass a build. Treat plans as revisable based on evidence.

## Regression evidence

`node scripts/agent_verification_scenarios_test.js` covers duplicate import bindings, malformed/valid modules, export text within templates, regex literals, omitted/visible/refocused line ranges, delayed/missing assertions, deferred script placement, foreign iframe messages, and original runtime-error preservation.

Related passing suites: queue_steer_and_run_errors, smoke_inline_dollar, agent_change_grounding, agent_guard_deadlock_replay, agent_completion_truth_gate, agent_build_recovery, agent_decision_parse, agent_completion_evidence, agent_file_fence_boundary, agent_contract_checker, agent_validation_advisory.

Build succeeds with the pre-existing NSSavePanel deprecation warning. No commit or release.

## Limits

The built-in check runner dispatches synthetic events. Native browser verification remains necessary for keyboard/default behavior, persistence and asynchronous behaviors longer than the assertion bound. The loop guard still limits repeated reads; this fix does not make prompt context unlimited.

## Follow-up scenarios

- Fresh QA Tally Two on 13.2.3: generated cleanly but stopped after startup, admitting it had not run requested arithmetic assertions. Explicit tool guidance in the same chat produced 14/14 passing checks without file edits.
- Changed requirement on the same project: steps of 2, range 0–5. Agent reported 13/13 checks; native Chrome clicks independently confirmed saturation at 5, subtraction to 3 and then 0. Its conclusion falsely claimed css/style.css was absent. The 8,389-byte file exists and the browser page is styled. This remains a response-grounding failure, not a missing-file defect.
- The model picker exposes only deepseek-flash. No second-model comparison was possible with the configured selection.
- QA Defer Probe on 13.2.4: explicit head/defer plus top-level DOM bindings passed the 0→1 Agent checks. The first narration fix missed the plan-activity intro path; the automatic startup prose generator was subsequently removed in 13.2.5.
- Additional prompt guidance now explicitly requires attempting requested interaction checks, and diagnostic wording distinguishes a preview mismatch from proof that the user-facing app is broken.

## Final packaged verification

13.2.5 is running. The fresh deferred-script fixture passed 0→1 checks again with a classic deferred head script and top-level DOM captures. Expanded Work visibly shows one model intro, then the created-project/files/checks group, then genuinely new check/read updates. The redundant deterministic scaffolding narration is gone.

Another pending finding: the last request named the new fixture QA Defer Final, but the new workspace/chat was named qa defer probe (1), while the conclusion used the requested name. It did create a separate folder; naming provenance still needs investigation. Conclusions also remain longer than a requested one sentence. These are not claimed fixed.
