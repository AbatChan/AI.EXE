# AI.EXE Private Finance Phase — Acceptance Record

Version under review: **10.2.0**

Prepared: **2026-08-10**

Scope source: Phase 3 Finance Foundation Agreement and signed Private AI Development & Testing Addendum 1.

This record covers the private/internal build only. It does not approve live trading, a banking gateway, a bundled offline Windows model, or public distribution.

## Acceptance matrix

| Requirement | Result | Evidence | Remaining external check |
|---|---|---|---|
| Existing desktop stabilized | Pass locally | JavaScript regression suite and backend smoke suite | Clean Windows run |
| Windows hosted-provider package | Pass for 10.1.1 | Published Windows ZIP and successful workflow | Build 10.2.0 |
| Broker abstraction | Pass | `BrokerAdapter` and `PaperBroker` | None |
| Simulation only | Pass | Live adapter construction is blocked; no broker credentials or venue client | None |
| Manual order confirmation | Pass | Staging leaves cash unchanged; a matching one-time token is required to fill | UI confirmation on clean Windows |
| Unaffordable/invalid orders rejected | Pass | Broker smoke tests | None |
| Append-only tamper-evident ledger | Pass | SHA-256 hash chain, replay and tamper tests | Verify packaged data path |
| Instruction and quote provenance | Pass for manual paper orders | Order ledger stores origin, optional instruction, quote source/time/stale status | AI-generated proposals are not in this phase |
| Finance foundation | Pass | Local income/expense/settings/invoice/report/mining-pilot smoke tests | UI walkthrough on clean Windows |
| Protected local finance storage | Pass locally | Owner-only database, WAL/SHM and broker-ledger permissions where supported | Confirm Windows ACL inherited from user profile |
| Controlled automatic update traffic | Pass by code inspection | GitHub Release metadata only; downloads require a SHA-256 digest | Observe startup on clean Windows |
| Approved endpoint boundary | Pass for market data | Quote code contains only Nasdaq and CoinGecko URLs; each request follows a labelled user action | Record client approval of those hosts |
| Local-only backend | Pass | Loopback host and foreign-origin middleware | Confirm Windows firewall prompt is absent |
| Release documentation | Pass | `PRIVATE_PHASE_DELIVERY.md` and this record | Add final ZIP checksum |
| Cost scenarios | Pass | `PRIVATE_PHASE_COST_SCENARIOS.md` | Client/caseworker review |

## Automated evidence

Local result on 2026-08-10:

- UI/agent regression scripts: **54 passed, 0 failed**.
- Backend suites: **11 passed**.
- `smoke_sandbox`, `smoke_generate` and `smoke_pdf` could not complete because the managed macOS test host rejects nested `sandbox-exec` with `Operation not permitted`. These require a normal host/Windows package run and are not recorded as product passes here.
- Finance, broker and price-feed smoke suites passed, including owner-only permissions, confirmation rejection, ledger tamper detection and stubbed offline quote tests.

Run from the repository root:

```bash
node --check ui/ai-exe.js
npm test
backend/.venv/bin/python backend/tests/run_all.py
```

The final delivery record must include the exact command results, Windows workflow URL, package filename, SHA-256 checksum, test computer details and tester/date.

## Required Windows walkthrough

1. Unzip the release into a new folder on a Windows user account.
2. Start `AI.EXE.exe` without installing Python or project dependencies.
3. Confirm the backend binds only to `127.0.0.1`.
4. Leave the app idle for five minutes and confirm it makes no external update request.
5. Open Finance and verify the dashboard, transactions, invoice and report views.
6. Stage a paper order and confirm that balances do not change.
7. Attempt confirmation with a wrong token and confirm rejection.
8. Confirm the displayed order and verify one simulated fill, costs and position state.
9. Click **Use live price** and confirm the UI identifies the source and timestamp.
10. Verify the broker ledger reports an intact chain after restart.
11. Confirm no live broker, bank-transfer or withdrawal control exists.

## Explicit limitations

- Paper simulation only; no real order is transmitted.
- Banking and transfers occur outside AI.EXE.
- Market quotes are informational and may be delayed or stale.
- AI-generated trade proposals are not connected to the broker in this phase.
- The public/offline product is a separate unsigned phase.
