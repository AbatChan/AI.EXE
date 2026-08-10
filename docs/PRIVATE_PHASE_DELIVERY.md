# AI.EXE Private Finance Phase — Delivery Guide

Delivery target: Alex / private internal testing

Build: **AI.EXE 10.2.0 — verified-auto-update**

## Included

- Windows desktop application with bundled local FastAPI backend
- Hosted-provider configuration already supported by the desktop application
- Local finance dashboard, transactions, reserves, split settings, targets, invoices and reports
- Mining economics worksheet and local pilot records
- Abstract broker seam with a local paper-only implementation
- Stage → explicit confirmation → simulated fill workflow
- Positions, cash, fees, realized performance and mark-to-market snapshots
- Hash-chained local broker ledger with instruction and quote provenance
- User-initiated Nasdaq equity and CoinGecko crypto quote lookups

## Not included

- Live broker/exchange orders or credentials
- Bank account connection, EFT, deposit, withdrawal or custody
- Automatic movement of money
- Bundled Windows local LLM/model runtime
- Public release terms, signing, installer or distribution support
- Investment, legal, accounting or tax advice
- Profit or performance guarantee

## Network behavior

The application performs one quiet update check shortly after startup and then
periodically while it remains open. Other external activity requires an operator action:

- **Automatic updates**: `api.github.com` is checked quietly; a newer Windows
  release downloads from GitHub only when its SHA-256 digest is available. The
  verified package installs on quit or when the user chooses restart and update.
- **Use live price / Fetch live & snapshot**: `api.nasdaq.com` for equities or `api.coingecko.com` for supported crypto.
- **Send a hosted-model prompt**: the provider or custom endpoint selected by the operator.

The paper broker itself has no network client. Custom model endpoints remain an operator-controlled capability of the private hosted-provider build and are not part of the future strict public/offline configuration.

## Local data

Finance and paper-broker data lives under the bundled backend's `.data` directory. Finance SQLite files and the broker JSONL ledger are restricted to the current OS user where permission semantics allow it.

Before final packaging, start with a clean delivery data directory. Do not delete the development data until it has been archived and the owner approves the reset.

## Installation and first run

1. Verify the delivered ZIP checksum against the handoff message.
2. Extract the complete ZIP to a user-owned folder.
3. Run `AI.EXE.exe` from the extracted folder.
4. Open Settings and configure the intended hosted provider only if required.
5. Open Finance. Confirm the header says **PAPER** before staging any order.
6. Use mock/local data during the five-business-day review.

No Python installation is required for the packaged Windows build.

## Paper-order safety flow

1. Enter the symbol, side, quantity and paper price, or deliberately click **Use live price**.
2. Optionally record the instruction/rationale.
3. Click **Stage order**. This does not move simulated cash.
4. Review the pending order.
5. Click **Confirm fill** to authorize one simulated fill, or cancel it.

Confirmation tokens expire after 15 minutes. Filled, cancelled and expired orders cannot be confirmed again.

## Handoff fields

Complete these only after the Windows workflow and walkthrough pass:

- Release URL:
- Package filename:
- SHA-256:
- Windows workflow run:
- Test computer / Windows version:
- Tested by / date:
- Five-business-day review starts:
- Review ends:

## Support and review

The signed addendum provides a five-business-day review window after delivery. Defects that contradict the signed private scope should be recorded with the screen, action, expected result, actual result and relevant log. New public/offline, live-money, banking or distribution work requires separate written scope.
