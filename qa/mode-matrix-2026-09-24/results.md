# Fresh-chat action matrix

Build: 12.5.7. Tests use synthetic data. Dependency audit remains local-only.

Actions: Thinking (T), Canvas (C), Agent (A), Web search (W), Context (X), Files (F).

Coverage target: each action alone, pairs, triples, and four/five/six actions together, with a new chat for each case. Record the exact combinations exercised; do not describe representative combinations as exhaustive.

| Case | Actions | Prompt / expected result | Observed result |
| --- | --- | --- | --- |
| B0 | None | `do it`; clarify without inventing a task | FAIL: clarified, but added unrelated autopilot balances, suggested trades and mounted an autopilot card. |
| T1 | T | Two draws: 3 red/2 blue, exactly one red | PASS: 3/5 with correct arithmetic; collapsed Thought disclosure visible. |
| C1 | C | Canvas tea guide, exactly three steps, under 60 words | PASS: document created and opened; three numbered steps, 33 words. Extra follow-up offer in chat. |
| W1 | W | MDN private localStorage lifetime, exact official link | PARTIAL: correct answer and official URL with 8-source search disclosure; stray leading `]` rendered. |
| X1 | X | Recall MINT-47, violet, NGN from Context note | PARTIAL: recalled all three and obeyed two sentences, but added unrelated trading balance commentary. |
| F1 | F | Attached 6-row CSV: deduplicate, exclude pending, retain unknown, sum adjustment | PASS: total380 West120 East60 North200; one duplicate and one unknown. |
| A1 | A | NEW Matrix A1; create exact MATRIX-A1; read back | PASS: file created, 9 bytes, actual read-back, ordinary receipt; 8s displayed, ~33k cumulative run tokens. |
| TC2 | T+C | Canvas explanation of both token draw orders, <100 words | PASS: Thought disclosure and document both rendered; opened doc shows correct 6/20+6/20=3/5 and pair cross-check. |
| AX2 | A+X | NEW project with Context values in JSON and disk read-back | PASS with quality issue: values correct and real read-back; JSON adds unrequested metadata including a self-asserted verified flag. One retry; ~52.1k tokens for a small file. |
| WF2 | W+F | Compute CSV total/duplicate count; separate MDN finding | FAIL: duplicate count correct but omitted requested revenue total; incorrectly called A5 status empty (it is pending); private-mode lifetime phrased as any tab closing rather than last private tab. |
| TCW3 | T+C+W | Sourced storage note in Canvas | PARTIAL: all three activity types present and doc opens; last-private-tab lifetime correct, but calls export the only durable escape hatch and later loosely says tab close. |
| TCWF4 | T+C+W+F | Sourced CSV audit Canvas memo | PASS with assumption issue: correct380/regional120,60,200/one duplicate/one unknown, correct pending status, valid source links. Added dollar signs although dataset has no currency. All three activity disclosures and attachment present; doc opened. |
| TCAWF5 | T+C+A+W+F | NEW Matrix Five, CSV app, MDN note, Canvas handoff | FAIL combined workflow: working app generated, but Canvas was substituted with blocked README attempts. Browser verified 380 baseline, edit to390, persistence after reload, invalid-header error. ~85.7k run tokens;40s. Web execution not independently confirmed. |
| ALL6 | T+C+A+W+X+F | NEW Matrix Six, ALTO-63/violet/NGN Context, CSV app and actual Canvas handoff | FAIL: edited Matrix Five before creating Matrix Six; Six contains only a47,180-byte duplicated canvas-handoff.md and no index.html. No Canvas artifact. Repeated blocked writes, plan0/5, yet final claims app live and verified. ~358.1k run tokens;1m38s. |

## Runtime evidence and remaining gaps

14 fresh-chat cases completed: baseline, six single actions, three pairs, one triple, one four-action, one five-action and all six. This is representative coverage, not all63 possible nonempty subsets.

The ALL6 run changed `/Users/macbookair2020/Downloads/matrix five/index.html` to show Matrix Six / ALTO-63 and NGN. Reloading its existing localhost preview confirmed the cross-project modification. The actual Matrix Six directory lacks index.html. The modified calculator does compute380 correctly; adding lowercase `a1` separately from `A1` yields390, survives reload, and wrong headers show an error and clear totals. These passing calculations do not establish isolation or Canvas success.

Highest-priority gaps: stale Explorer project survives new chats and can receive edits despite NEW isolated project instructions; Agent does not honor Canvas delivery; repeated retries inflate handoff content and token use; success narration conflicts with failed receipts; unrelated trading context leaks into vague/context-only prompts; Web+Files answer drops or misreads requested facts. UI shows a stray search bracket and truncated final sentence in ALL6. Green/red change counts were visible correctly in the ALL6 receipt. Storage-denied and mobile behavior were not verified in this pass. An enabled Web toggle or citation alone was not treated as proof of an executed search inside Agent.

No application source changes or release were made during this test pass. Test data is synthetic. Dependency auditing remains local-only.

## Cleanup

Deleted all14 chats created for this matrix plus the older disposable Autopilot Change Request test through the app's chat-options confirmation. Verified the sidebar now begins with the unrelated older Version Latest Node.js Version chat; left a blank new chat ready. Other older chats were preserved. Generated QA project folders were retained as file evidence; deleting chats also removed their associated Canvas artifacts through normal app behavior.

Additional observed UX/accessibility issue: the armed Delete for good dialog sometimes remained visually present while missing from the native accessibility tree. Screenshot verification was needed to complete those confirmations safely.
