# AI.EXE Financial Automation — Product and Integration Requirements

Status: discovery draft for client approval  
Scope: AI-assisted stock/crypto trading, optional real Bitcoin-mining telemetry, funding, withdrawals, and accounting

## 1. Recommended product

Build an **AI-assisted investing and earnings dashboard**. A text request may create a trade proposal, approve a previously configured action, or display verified earnings. It does not itself mine Bitcoin or guarantee profit.

The first release must use paper trading. Live trading is a later, separately approved release after the broker, payment providers, security review, and applicable legal/compliance requirements are complete.

### Recommended release order

1. Portfolio dashboard and paper trading.
2. AI trade proposals with explicit user confirmation.
3. Rule-based live trading through the user's regulated broker/exchange account.
4. Bank funding and withdrawals through the broker's supported rails.
5. Optional PayPal payouts, only after PayPal approves the business and transaction type.
6. Optional mining dashboard connected to real ASIC hardware and a mining pool.

## 2. Correct interpretation of the client's idea

- A prompt such as “mine Bitcoin” may start or schedule already-connected mining hardware, but mining requires ASIC hash power, a pool or Bitcoin node, electricity, cooling, and a payout wallet.
- A prompt such as “invest $50” produces a structured proposal. It must not place a live order unless the account, legal mode, permissions, risk limits, and required confirmation allow it.
- Bitcoin received from a purchase or transfer must never be described as “mined.”
- Every balance movement must record its true source: `USER_DEPOSIT`, `MINING_PAYOUT`, `CRYPTO_TRADE`, `STOCK_TRADE`, `DIVIDEND`, `FEE`, `REFUND`, or `WITHDRAWAL`.
- “Automatic Bitcoin sale to digital cash” means an exchange sell order followed by settlement to a supported fiat balance. It is not a PayPal conversion performed by AI.EXE.

## 3. Product modes

### A. Personal/owner mode — recommended MVP

One client connects accounts they already own. AI.EXE never pools customer money or becomes the custodian. Use provider OAuth where available; otherwise encrypt narrowly scoped API credentials server-side.

### B. Multi-user commercial mode — later release

End users open or connect individual regulated accounts. This requires a broker/exchange partner that supports embedded accounts, customer onboarding, KYC/AML, funding, statements, and order execution. Legal counsel must confirm broker-dealer, investment-adviser, money-transmitter, custody, consumer-protection, and privacy obligations in every supported jurisdiction.

## 4. Functional requirements

### Account connection

- Connect stock broker, crypto exchange, bank-funding provider, optional PayPal account, and optional mining pool.
- Show connection health, granted permissions, region/currency, and last synchronization time.
- Never request withdrawal permission on a trading API key unless the approved workflow strictly requires it.
- Allow immediate revocation and deletion of credentials.

### AI trading workflow

1. Parse the user's request into asset, side, amount, order type, time horizon, and constraints.
2. Retrieve live account state, buying power, positions, market status, quotes, and configured risk policy.
3. Produce a structured proposal with rationale, estimated fees, risks, and maximum possible loss where determinable.
4. Run deterministic policy checks outside the language model.
5. Require explicit confirmation for live orders in the initial release.
6. Preview the order with the broker/exchange when supported.
7. Submit once with an idempotency key.
8. Store provider request IDs, fills, fees, and an immutable audit event.
9. Notify the user of accepted, rejected, partially filled, filled, or canceled status.

### Automatic-trading controls

- Paper/live mode must be visually unmistakable.
- Per-order, daily-loss, daily-turnover, open-position, and portfolio-exposure limits.
- Asset allowlist; no leverage, options, futures, margin, or shorting in MVP.
- Trading-hours and stale-price checks.
- Cooldown after repeated losses or provider errors.
- Global kill switch, per-strategy pause, and cancel-open-orders control.
- No AI-generated code may bypass the deterministic risk engine.
- No claim or implication of guaranteed earnings.

### Funding and withdrawals

- Brokerage funds remain at the broker/custodian, not in an AI.EXE internal wallet.
- Use the broker's supported bank rail (for example ACH/wire where available) for deposits and withdrawals.
- PayPal Checkout may pay for the AI.EXE service, but must not be assumed to fund securities or crypto trading.
- PayPal Payouts may be offered only as an optional post-settlement payout rail after written provider approval, country/feature validation, identity verification, and fee disclosure.
- Withdrawals require step-up authentication, destination verification, amount/velocity limits, idempotency, and a complete ledger trail.
- Never automatically move money from trading accounts merely because the AI recommends it.

### Mining module — optional and separate

- Connect to client-owned ASIC miners through a mining-pool API or a read-only local controller.
- Display hash rate, accepted/rejected shares, temperature, power draw, uptime, pool balance, network difficulty, estimated electricity cost, and confirmed payouts.
- Only pool-confirmed or on-chain-confirmed amounts may be labeled mining proceeds.
- A sale of mined BTC is a separate exchange order and ledger event.
- No hidden browser/desktop CPU mining and no mining on an end user's device without explicit, informed opt-in.

### Ledger and reporting

- Double-entry ledger for cash, crypto, securities, fees, realized gains/losses, mining income, deposits, and withdrawals.
- Reconcile against broker, exchange, PayPal, bank, pool, and blockchain references.
- Export CSV/PDF statements and a tax-oriented transaction history; do not present this as tax advice.
- Dashboard values must distinguish cash deposited, market gain/loss, mining revenue, fees, and withdrawals.

## 5. Suggested integrations

### MVP

- **Stocks:** Alpaca Paper Trading/Trading API for an owner-operated prototype.
- **Market data:** Alpaca Market Data or the chosen broker's licensed feed.
- **Crypto:** Coinbase Advanced Trade API or a region-approved exchange with order preview, scoped authentication, fills, fees, and webhooks/polling.
- **Funding:** broker-supported ACH/wire; Alpaca's U.S. embedded flow uses Plaid processor tokens.
- **PayPal:** Checkout/Orders for product subscription payments; Payouts only if approved for this use case.
- **Secrets:** managed secrets vault/KMS; never store API secrets in the UI, logs, prompts, or model context.

### Commercial platform

- Broker API/embedded brokerage agreement rather than one shared retail trading account.
- Provider-led account opening, identity verification, sanctions screening, agreements, statements, and custody.
- OAuth authorization for individual exchange accounts where supported.
- Compliance case-management and transaction-monitoring provider selected with counsel and the broker.

Provider availability and permitted products must be confirmed for the client's company country and each user's residence before implementation.

## 6. API credentials and approvals required from the client

Start with sandbox/paper credentials only. Production secrets must be entered directly into the deployment secret store, not sent in chat or email.

- Alpaca paper account and API key/secret, or Broker API sandbox approval for a multi-user product.
- Coinbase developer application/OAuth configuration or a dedicated, scoped sandbox/test account where supported.
- Plaid sandbox `client_id` and secret if the selected U.S. broker funding flow requires Plaid.
- PayPal Business sandbox account, REST client ID/secret, webhook ID, and later written Payouts approval.
- Mining-pool API token with read-only scope, worker names, payout address, and pool endpoint if mining is included.
- Market-data subscription/API credentials if the broker's included feed is insufficient.
- Email/SMS/push provider credentials for order and withdrawal alerts.
- Cloud account, domain/DNS access, deployment environment, KMS/secrets service, database, monitoring, and backup policy.

## 7. Decisions and information required from the client

The client must answer and approve the following before live-money development:

1. Company legal name, incorporation country, operating address, and responsible officers.
2. Target user countries, citizenship/residency restrictions, minimum age, and supported currencies.
3. Personal tool or multi-user commercial product.
4. Whether AI.EXE gives general information, personalized recommendations, discretionary trading, or execution-only commands.
5. Who legally holds customer cash, crypto, and securities at every step.
6. Chosen licensed broker, crypto exchange, custody model, and evidence that each supports the target countries.
7. Exact asset universe: U.S. stocks, ETFs, spot crypto, or other products.
8. Confirmation policy: proposal only, confirm every order, or pre-authorized bounded automation.
9. Risk limits: maximum deposit, trade size, daily loss, exposure per asset, withdrawal, and automation schedule.
10. Fee model: subscription, fixed service fee, assets-under-management fee, performance fee, spread, or none. Counsel/provider approval is required before selecting transaction- or performance-based fees.
11. PayPal's role: subscription checkout, client-funded payout, or user withdrawal. Written approval is needed for investment/crypto-related use.
12. Whether real mining is included. If yes: ASIC model/count, location, electricity tariff, cooling, pool, wallet, expected uptime, and hardware-control permission.
13. Required identity/KYC, AML, sanctions, fraud, source-of-funds, transaction-monitoring, tax, privacy, and record-retention policies.
14. Legal opinions/licenses/registrations and provider contracts covering every launch jurisdiction.
15. Customer agreements, risk disclosures, privacy policy, terms, complaint process, and incident-response owner.
16. Branding, supported platforms, accessibility targets, notification channels, and launch date/budget.

## 8. Security and audit requirements

- OAuth with least privilege where available; otherwise envelope-encrypted API secrets.
- Separate sandbox and production credentials, accounts, databases, and UI indicators.
- MFA/passkey for the AI.EXE account; step-up authentication for live-mode changes and withdrawals.
- Signed webhooks, replay protection, idempotency keys, rate limits, and tamper-evident audit logs.
- Provider-reported positions and balances remain authoritative; reconcile local projections continuously.
- Human-readable record of the prompt, parsed intent, market inputs, policy decision, confirmation, provider request, and final fill.
- Never place secrets, full identity documents, or private keys into an LLM prompt.
- Independent penetration test and incident-response rehearsal before live launch.

## 9. MVP acceptance criteria

- Paper account connects and synchronizes balances, positions, orders, and fills.
- A natural-language request becomes a structured, reviewable proposal—not an immediate live trade.
- Invalid, ambiguous, oversized, stale-price, disallowed-asset, and market-closed requests fail safely.
- Confirmed paper orders are idempotent and reconcile with provider fills and fees.
- Dashboard clearly separates deposited funds, simulated P/L, fees, mining proceeds, and withdrawals.
- No screen uses “mined” for purchased/transferred Bitcoin or promises profit.
- PayPal and live-money controls remain disabled until provider approval and production-readiness sign-off are recorded.

## 10. Delivery gates

- **Gate 1 — Discovery:** client answers Section 7 and selects jurisdictions/providers.
- **Gate 2 — Sandbox:** paper trading, simulated funding, ledger, risk engine, and audit tests pass.
- **Gate 3 — Compliance:** counsel and providers approve the precise live business model and customer flow.
- **Gate 4 — Security:** production architecture, key handling, monitoring, penetration test, and incident plan pass review.
- **Gate 5 — Limited live pilot:** low limits, confirm-every-order, allowlisted users/assets, daily reconciliation.
- **Gate 6 — Bounded automation:** enabled only after measured pilot performance, provider approval, and revised risk sign-off.

