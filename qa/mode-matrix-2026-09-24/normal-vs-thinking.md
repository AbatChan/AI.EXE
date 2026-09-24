# Normal vs Thinking: 2026-09-24

Same self-contained constrained-project optimization question in fresh chats, same DeepSeek API deepseek-flash. Normal had all action toggles off; comparison had only Think on. No prior chat history, search, attachments or tools. Independently enumerated 19 feasible sets.

## Expected answers

1. BEF: budget 14, days 10, strong 36, weak 2, expected 24.10 at p=.65.
2. With weak payoff >=8: BDG, budget 12, days 6, strong 24, weak 12, expected 19.80; sacrifice 4.30.
3. BDG on [0,5/14]; DEG on (5/14,5/8]; BEF on (5/8,10/13); ACD on [10/13,1]. Tie points belong respectively to BDG (lower budget), DEG (fewer days), ACD (lower budget).
4. Ratios do not solve indivisible constrained selection with prerequisites. Budget 2 admits no feasible set, including empty because B or D is required.

## Baseline v12.6.8

| Check | Normal | Thinking |
|---|---|---|
| Provider request duration | 12.416 s | 71.180 s |
| Unrestricted optimum | Wrong: ABD, 23.05 | Correct: BEF, 24.10 |
| Weak constraint | Correct BDG, wrong sacrifice 3.25 | Correct BDG and sacrifice 4.30 |
| All optimal-set intervals and ties | Wrong, omitted DEG and BEF | Correct |
| Budget 2 | Said no nonempty set but incorrectly allowed empty | Correct no feasible set |
| Presentation | Excessively long, visible arithmetic corrections, false exhaustive-check claim | Correct final section but draft reasoning leaked outside Thoughts |

Thinking improved the substantive result on this one test. It is not evidence that Thinking is always correct. Its ratio example also incompletely listed prerequisite closure (B missing from A,C,D,F), although infeasibility and main conclusion were correct.

## UI defects and repair

Thought rendering clipped content at 640 characters. DeepSeek native reasoning was also prompted to emit a second tagged scratchpad, creating ambiguous nested boundaries. The renderer stripped only the first block and exposed drafting text. v12.6.9 preserves complete thought text, uses a separate native reasoning wrapper, handles nested legacy tags and never promotes a reasoning-only response into the final answer. Thinking now precedes search/action routing with request/history context, and Agent stores that initial reasoning as a collapsible step within Worked.

Validation: thinking_boundary_test, thinking_order_test, agent_unified_result_test, mode_priority_test, prompt_fallback_sync_test, agent_matrix_recovery_test, agent_auto_search_test and contextual_search_test passed; Mac build completed (existing deprecated macOS file-picker API warning).

## Live verification after fixes

- v12.6.9, same complex prompt, Think only: clean final answer, 587 whitespace-delimited words, correct BEF/BDG outcomes, 4.3 sacrifice, all three breakpoints and tie assignments. Remaining model error: claimed 20 feasible sets instead of 19. Provider request took 74.020 seconds; UI showed about 80 seconds including initial assessment. Full expanded thoughts exceeded the old 640-character limit with no renderer ellipsis, and no drafting text leaked into final output.
- Agent + Think, read-only existing QA fixture `/result.txt`: a format conflict in the initial assessment blocked the first attempt. Fixed by quoting the old application prompt as context data and accepting a usable prose assessment while retaining normal semantic routing. No tool execution is inferred from malformed JSON.
- v12.7.1: contextual follow-up “Read the same file again” resolved `/result.txt` from history. The assessment completed at 01:11:42.111Z (896 thought characters), before preflight at 01:11:43.201Z and the inspected answer at 01:11:44.946Z. The final answer correctly quoted NESTED-OK and did not claim that this proves a web search ran. No edit or web action was requested/executed in this test.
- v12.7.2: after relaunch, saved UI visibly showed Worked → Thought for 3 seconds → Inspected the workspace, read files → one final answer. Expanded thoughts showed the full text including its ending, beyond the former 640-character cut. Reasoning now remains separate from consecutive tool groups, rather than being nested under their summary label.
- All four disposable comparison/verification chats were deleted through the UI. Existing non-test chats and the pre-existing workspace were preserved; preview left at a blank new chat.

Three dedicated regression tests cover native/legacy nested boundaries, long thought retention, provider switches, a frame containing both reasoning and answer content, reasoning-before-routing with history, cancellation, incomplete output, prose assessment fallback and independent Thought/tool groups. Related mode, search and unified-result regressions passed. Build v12.7.2 is running locally. No commit, push or release.

Limit: this is one complex question, one normal sample and two Thinking samples; it is not a broad model benchmark. Agent + Think was verified live. The full Canvas/Search/attachment combination matrix was not rerun in this pass. Provider-native reasoning was verified with DeepSeek; other providers were not live-tested here.

## Follow-up: editor hint and Thinking continuity (v12.7.3)

Removed the branch explanation from message editing; Cancel/Save remain right-aligned. Verified the native editor has no hint and saving a modified disposable prompt still creates branch 2/2 correctly.

Thinking now keeps the same panel/drawer DOM nodes and disclosure state across stream updates and answer arrival. The initial assessment handoff retains its live row and includes its thoughts during the next stream, instead of destroying the row and only restoring the thoughts on final commit. Agent inspection retains the work panel; tool results no longer take an intermediate answer-only typewriter path. Nested Agent Thought panels are reused across activity updates. Thought duration stops at the end of reasoning rather than advancing throughout final-answer output.

`thinking_stability_test.js` exercises stable panel/drawer identity over 10 updates and final-answer arrival, preserved collapsed state, absence of destructive initial handoff and removed editor hint. Thinking order, boundaries, SSE, mode-priority, unified-result and tool-group tests also pass. Built and relaunched v12.7.3.

Live short conditional-probability test: first provider attempt failed with a transient “Load failed”; the edited-branch retry completed with the correct 12/49 answer and a retained Thought header. The disposable test chat was deleted and the preview left at a blank new chat. Continuous frame-by-frame flicker monitoring was not recorded; DOM stability is covered by regression tests and final native UI was inspected.
