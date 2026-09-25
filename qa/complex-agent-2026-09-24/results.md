# Complex Agent QA

Preview 13.2.5, configured model deepseek-flash. Disposable project: Parcel Bench QA.

## Expected results, recorded before testing

- Seed stock T=5, M=3; prices 1025 and 750 cents.
- Confirm 2 T + 1 M: total 2800 cents, stocks T=3/M=2, active sales 28.00.
- Cancel: stocks 5/3, active sales 0.00; repeated cancel must not add stock.
- Undo cancellation: stocks 3/2, active sale 28.00.
- Insufficient second order / fractional quantities: no mutation.
- Changing catalog price cannot rewrite old order totals.
- CSV quoted product name parses as one field. Duplicate SKU matching is case-insensitive; any invalid row rejects the whole import.
- Customer name containing HTML-like text is visible literally.
- Reload preserves orders, inventory and latest committed state.

## Planned adversarial follow-ups

1. Change requested quantities/maximums after the first implementation; verify old assumptions are replaced.
2. Describe any actual observed failure without a filename or proposed solution; require Agent reproduction before repair.
3. Request a conflicting operation (overdraw inventory), checking that validation survives follow-up edits.

## Results

### Initial build and recovery

- The Agent created the isolated nine-file project. Startup had no syntax error, but Inventory and Orders were blank and sales remained zero after a successful order.
- Chrome confirmed state changed to stocks 3/2 while rendering stayed blank. The first unhinted repair changed aliases and failed to fix the problem.
- Root cause: renderer DOM references were assigned only by `PB.render.init()`, which startup never called.
- Thinking plus an explicit initialization-tracing hint fixed the renderer. This is not a controlled Think-vs-normal comparison: the hint and checker capabilities also changed.
- Agent reported 21 passing checks. Independently verified in Chrome: $28 order, stock 3/2, cancellation 5/3, undo 3/2, and reload preserving the active $28 order. HTML-like customer names appeared literally.

### More difficult cases

- Browser: insufficient stock in the second order line rejected the whole order; stock and prior $28 total stayed unchanged.
- Browser: fractional quantity and case-insensitive duplicate CSV rejected without mutation.
- Source execution found two genuine key-collision bugs: duplicate `__proto__` CSV rows were accepted; ordering `constructor` generated an empty successful order.
- Agent repaired CSV with Map, but neglected the order aggregation bug and drifted into repeatedly checking a Cancelled card while the Active filter hid it. Stopped that run after repeated non-converging checks.
- Agent initially removed success notifications rather than fixing duplicate subscriptions. It later removed the duplicate subscription, but had also removed needed notifications.
- Direct fixture correction: use a null-prototype aggregation dictionary and restore one confirmation/cancel notification. No SKU denylist.
- Independent `domain-checks.cjs`: all six suites pass, covering repeated cancellation, undo, atomic invalid orders, duplicate-line overdraw, quoted CSV, invalid CSV atomicity, historical prices, special-key duplicates and special-key order lines.
- Browser confirmed `constructor` creates a real $1 order and deducts stock 4→3; cancellation restores 4; each notification appears once; duplicate `__proto__` import is rejected.

### AI.EXE checker fix shipped locally

- Preview 13.2.6 (`form-flow-checks`) adds fill and select actions, validates disabled/read-only controls, and rejects mixed action/assertion steps instead of silently dropping assertions.
- Updated live and fallback tool guidance. Meaningful runner regression tests and queue/run-error tests pass; Mac preview build passes. Live Agent used fill/select successfully during the 21-check flow.

### Cross-chat and remaining gaps

- Invoice chat returned the correct 34.00 and explained that shipping was not discountable; no workspace mutation from that chat was observed.
- Its request waited until the first Agent run ended. Concurrent responsiveness is not passed; switching chats alone is not proof of independent execution.
- Stopping the adversarial Agent run showed “Interrupted by you · Progress saved” and Continue.
- Model still speculates about causes, overlooks requested edge cases, repeats narration, and asks whether to run checks already requested. The large repeated source context may contribute, but causality is not established.
- CSV replacement can remove SKUs used by active orders; those orders retain historical totals but then cannot be cancelled. This inventory lifecycle policy remains unresolved, not counted as a clean end-to-end pass.
- Only deepseek-flash was available; no alternate-model comparison performed. No commit, push, or release.
