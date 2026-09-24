# Recovery changes and verification

Local preview: 12.6.7. No commit, push, release or online dependency audit.

## Changes

- Pass preflight's new-project decision into planning and execution; preserve it in normalized workspace intent.
- Initialize a model-planned new workspace before deterministic file writes. Protect all mutation paths and commands from acting on the previous root before initialization.
- Add a real create_canvas action to parser, provider schema, prompt and executor, with a bounded document-generation fallback when the model omits content. Render an ordinary Canvas artifact and activity receipt.
- Run enabled Web Search before Agent work, keep a visible sources disclosure, and include the actual search event in the evidence ledger and source context.
- Do not use code-ending heuristics to continue completed Markdown/text/CSV files. This caused the duplicated handoff drafts.
- Stopped runs use an explicit incomplete receipt rather than a generated success summary followed by a blocker.
- Include ambient trading figures and unrelated Explorer/recent-work context only when the semantic router determines they are relevant to the current turn.

## Verification

15 selected regression scripts passed: matrix recovery, workflow regression, plan classification, guard truthfulness, completion truth gate, retry/context, decision parsing, mode priority, prompt synchronization, write repair, partial-write guard, preflight router, chat prompt mode, activity grouping and run events.

Live 12.5.8 intermediate retest: Agent+Canvas+Web created Recovery Probe/result.txt containing exactly RECOVERY-OK and delivered a real Canvas document. The previous Matrix Five and Matrix Six files retained their SHA-256 checksums. Remaining unnecessary initialization/empty-Canvas retries and missing search-event evidence were corrected in 12.5.9.

SHA-256 preserved targets:
- Matrix Six/canvas-handoff.md: 411ddbef70602c943b09bac9ed910e1f555a03564640799d8279db746c370a3e
- Matrix Five/index.html: fd18768caf0e519c9dae0b20a9a13602ed6f0c768ae12fc1d7071f84f9e91479

Final live results and QA chat cleanup recorded below after verification.

## Final fixes and retests

- Web research first extracts the external factual question, keeping app-generation instructions out of the search request.
- Canvas generation validates the requested word limit and retries an oversized document once.
- Unverified completion criteria replace optimistic completion claims with an incomplete receipt.
- Search sources, file activities and actual Canvas artifacts now attach to one final assistant message. Canvas remains available while the agent works; it does not create a separate chat bubble.
- 16 regression scripts passed at that checkpoint, including the new unified-result association check. Native preview rebuilt and relaunched as 12.6.2.

Live all-six retest on 12.5.9 created Iris Recovery in a new workspace without the repeated Blocked chain. Its generated CSV app produced 380 total (East 60, North 200, West 120), retained edits after reload, rejected wrong headers, and reset to the fixture. The intermediate search answer and oversized Canvas revealed the additional corrections above.

Live 12.6.1 Agent+Canvas+Search created Final Recovery/result.txt with FINAL-OK and a real 610 B Canvas containing the correct MDN private-storage fact and an explicit untested-browser limitation. A fresh vague prompt did not receive unrelated account figures or a prior project name. The earlier Matrix Five, Matrix Six and Recovery Probe files retained their checksums.

These are regression and representative live checks, not a claim that every model output or security vulnerability is eliminated. The earlier 14-case matrix was not repeated in full after these fixes. No external dependency audit was run.

## Latest UX and automatic search

- Search can be selected semantically for online requests, current/changing facts, or uncertainty without enabling the toggle. Explicit offline/no-browsing instructions are included in the routing policy.
- Agent also has a workspace-independent web_search tool for research discovered during execution; query survives decision parsing and the provider schema.
- Search is a standalone collapsible source step inside Worked, after narration. The duplicate source row outside Worked is suppressed; saved older messages receive the same layout.
- Canvas verification now receives saved content and a measured word count, preventing title-only verification retries. Same-title Canvas revisions within one run update the artifact instead of adding copies.
- File generation ends at its matching closing wrapper fence, excluding outside narration and preserving nested shorter Markdown fences.
- 18 selected regression scripts pass on v12.6.6.

Live intermediate automatic-search test successfully searched with the toggle off and created one Canvas, but its text file included trailing narration outside the closing fence. This was detected by direct file inspection, not accepted as passed despite the model's success statement, and motivated the fence-boundary correction.

Final v12.6.6 Agent+Canvas test with Web Search OFF: Nested Search completed in a displayed 13 seconds without repeated Blocked rows or Canvas retries. Direct disk inspection confirms result.txt is exactly the 9 bytes NESTED-OK. The single assistant bubble contains Worked, its narration followed by a collapsible search step with eight source links, the remaining file/Canvas activities, one final response and one Canvas card. Expanding and collapsing Worked and the source disclosure was verified in the native preview. The same nested layout is applied to older saved QA messages.

The user requested inspecting Codex's own search UI. A real search was run, but computer use denied access to com.openai.codex. The supplied screenshots and the actual AI.EXE screenshot were used for visual comparison; no claim of a captured Codex window is made.

## Final state

v12.6.7 is running. Search uses compact gray rows, matching activity typography, with a globe/chevron header and plain source links instead of pills. Native screenshot verified narration precedes search inside Worked; collapsing Worked removes all its search details. Automatic search was observed with all toggles off in ordinary chat and with only Agent+Canvas enabled in the combined test.

18 selected regression scripts pass on the final source. Ten disposable chats from this recovery pass were deleted through the app, including their associated Canvas artifacts; older unrelated chats remain. The app is left at a blank new chat. Generated project files remain as QA evidence.

### Remaining accuracy gap

The ordinary-chat latest-Node test returned an old release (24.11.0), and after removing the incorrect prompt instruction to treat newly retrieved results as current, its retest still returned stale Current/LTS values (26.9.0 / 24.19.0). Independent official-page lookup showed 26.10.0 Current and 24.21.0 LTS: https://nodejs.org/en/download/current . Automatic routing, source display and layout pass, but latest-fact accuracy is NOT considered passed. The provider's source freshness needs stronger direct-page verification; the prompt correction alone does not solve it. No fixed Node version was hardcoded into the app.

No commit, push, release, or external dependency audit was performed.

## Contextual dated search — v12.6.8

Follow-up research now receives the recent conversation and, for an Agent search step, recent tool observations. The semantic query builder retains relevant public error text and software versions, excludes unrelated/private data from the public query, distinguishes current from historical requests, and identifies market measurement/time window. Current-facing queries have the actual UTC date appended by code after the semantic decision. An unspecified market window is explicitly scoped to 24 hours. The saved search row shows the actual outgoing query rather than a shortened topic.

19 regression scripts pass, including focused tests for contextual bug follow-ups, dated market queries, historical-date preservation and query display. Build/relaunch verified v12.6.8. New end-to-end UI retests were not completed: computer actions were repeatedly interrupted while the user navigated the app. No new QA chat was created. The previous source-freshness limitation is not marked resolved by these tests; date and context improve query specificity but are not independent verification of a provider answer.
