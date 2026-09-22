# Trading product review — 9 September 2026

Local development only. Client clarification: Canada, USD, no confirmed brokerage account. No release, live trading, account opening or bank transfer is authorized by this document.

## Client requirements reconciled

The original `AI_EXE_Requirements.pdf` in Downloads/Documents/Client Work describes an offline Windows executable with embedded inference, chat and standalone software generation. It contains no trading or banking requirement. The existing private-phase delivery guide describes the later hosted-provider and paper-broker scope, excluding banking and bundled local inference. The subsequent `FINANCIAL_AUTOMATION_REQUIREMENTS.md` is a discovery draft. The current conversation explicitly requests trading research, local UX improvements and funding planning.

These are distinct requirements: offline inference can run locally, but current prices, live trades and bank transfers require network access. Do not claim the original fully offline specification and a connected trading product are simultaneously satisfied. Windows acceptance and local-model performance on the client's RTX 5080 remain unverified here.

## Current strategy evidence

The live local status on 9 September confirms 22 forward observations through 8 September, BAC, SMA 20/50, active, no runner error. The historical lab also currently selects SMA 20/50; the older SMA 10/50 reference is stale. The single BAC share remains the active paper position.

| Experiment | Strategy return | Comparison | Drawdown / costs | Meaning |
|---|---:|---:|---|---|
| BAC historical holdout, 114 days | SMA 20/50 +8.33% | Buy-and-hold +28.26% | SMA 6.88%; 3 fills; $0.78 costs | Behind by 19.93 percentage points |
| Daily paper record, 22 observations | −0.16% | Same-start buy-and-hold −0.16% | 0.73%; zero post-start fills, $0 costs | No measured advantage; little capital exposed |
| Previous six-period AI test, old timing | +3.49% | Momentum +0.86%; equal-weight +19.64% | Previously omitted from UI | Superseded method; not a current performance claim |
| Corrected AI test, 17 March–8 September 2026 | +0.35% | Momentum +2.80%; equal-weight +19.64% | AI 13.01% DD, momentum 15.51%, equal-weight 3.08% | AI behind equal-weight by 19.29 points |

The corrected model run completed in the Mac app with six valid responses, 35.3 seconds provider time. Positive periods: AI 3/6, momentum 2/6, equal-weight 4/6. Modeled cost impact as a fraction of initial equity: 0.59%, 0.58%, 0.64% respectively. Costs are included in returns. Timing changed and model sampling varies, so the difference from the previous run cannot be attributed solely to the code correction.

The SMA lab uses one chronological training/holdout split, not a full rolling walk-forward study. Selecting a candidate from training does not make repeated inspection of its holdout independent. AI results compound independent allocation periods, whereas the forward test measures the actual small paper account. Neither is directly comparable to a published annual profit rate.

## Current open-source projects

| Project | Useful idea for AI.EXE | Published return evidence and limits |
|---|---|---|
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) | Separate analysis, portfolio proposals and risk review; configurable cloud/local models | Its [original paper](https://arxiv.org/html/2412.20138v1), Table 1, reports AAPL +26.62%, GOOGL +24.36%, AMZN +23.21% cumulative returns. These are author-reported historical simulations, not audited live returns or a reproducible rate for our model. The paper describes differing dataset and simulation dates; inspect the exact experiment before reproduction. The current repository explicitly cautions that results vary and documents recent point-in-time fixes. |
| [FinRL-X](https://arxiv.org/html/2603.21330v1) | One portfolio-weight interface for allocation, timing, risk and execution | March 2026 paper: January 2018–October 2025 tests, 10 bps per side. Table 2 reports DRL with timing 17% annualized / 27% drawdown, versus SPY 14% / 23%, QQQ 19% / 33%. More return than SPY also meant more drawdown; QQQ returned more. Not a promised return for this app. |
| [Qlib](https://github.com/microsoft/qlib) | Reproducible datasets, model experiments and portfolio evaluation | Framework with many model/data configurations; no single defensible project profit rate. Good reference for experiment tracking, not a replacement for evidence. |
| [Freqtrade](https://docs.freqtrade.io/en/latest/lookahead-analysis/) | Automated checks for future-data leakage and separate dry-run validation | Crypto-oriented tooling. Adopt the validation method, not an unrelated advertised strategy return. |

These projects were inspected through their official repositories, documentation and papers; they were not installed or independently reproduced in this pass.

## Broker and USD funding choice

**Proposed first provider: Interactive Brokers Canada, for the client's own account and permitted U.S. securities.** This is a fit assessment, not an opened account or approved integration.

- [IBKR funding instructions](https://gdcdyn.interactivebrokers.com/Universal/servlet/Registration_v3.formHelp?s=p1101) describe Canadian EFT for CAD/USD from eligible same-name Canadian bank accounts. A Canadian USD bank account and a U.S.-domiciled bank account are different cases. The actual bank and account registration determine offered methods, holds and fees.
- [IBKR Web API access](https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-doc/) distinguishes trading access from banking/account-management permissions. Individual Web API access requires a fully open, funded IBKR Pro live account even for its associated paper account. Banking features need separate configuration and are not available to every account type. AI.EXE can continue its independent local paper testing without this account.
- Initially, deposit/withdrawal actions should hand off to the authenticated broker portal. Embedded transfer submission must wait for provider permission, supported authentication and tested reconciliation. Do not use a retail trading key as assumed permission to move money.
- [IBKR's Canada restriction](https://ibkrcampus.com/docs/web-api/v1/requirements-limitations/canadian-residents-restricted-from-programmatically-trading-canadian-products) bars client/third-party API orders for Canadian-market products. Confirm the exact supported U.S. instruments with IBKR before integration.
- [Questrade](https://developer.questrade.com/) permits customer API account/data access but reserves order execution for partner developers; less direct for this prototype.
- [Alpaca Canada](https://alpaca.markets/ca) describes registration applications, while its [non-U.S. account guide](https://alpaca.markets/learn/live-trading-account-non-us) says Canadian residents are unsupported. Sandbox funding documentation does not establish Canadian live retail eligibility.

Required before connection: client account opened/verified, account type, eligible USD bank location/currency, broker API permissions, market-data entitlement, secure authentication, and the actual provider's fee/hold/settlement rules. Do not request credentials or identity documents in chat.

Transfer implementation requirements: distinguish settled cash from buying power; destination verification; explicit transfer review; provider idempotency key; submitted/pending/settled/failed/returned states; reconciliation; audit trail; withdrawals must not sell holdings implicitly. Deposits must never count as trading gains. Keep money at the broker.

## UI/UX direction and changes

The old screen combined a terminal, account balances, algorithm development, model diagnostics and funding questions in one long page. Repeated uppercase headings, neon accents, unexplained terms and tiny truncated rationales made it feel generated and harder to use.

Design uses the existing sans-serif, tabular figures, left-aligned task headings and right-aligned financial comparisons. Tokens: surface #171c24, rules #343e4c, text #e6ebf1, secondary #abb7c7, focus #9cc7e3. The first concept retained too many matching cards; revised it to a joined portfolio summary and comparison tables, with detail behind disclosures. No new font dependency.

Local build separates Portfolio / Strategy tests / Deposits & withdrawals / Business records. It uses sentence-case labels, plain actions, visible keyboard focus, responsive layouts and unclipped model rationales. Loss bars extend left of zero. Valid-response counts explicitly describe format validation, not forecast accuracy. Refresh preserves the last successful AI result within the running page session; it is not a durable experiment archive.

The funding page is a working **review-only UI prototype**, not a banking connection or simulated settlement service. It accepts an amount/direction, reviews them, and explicitly reports not submitted. No bank details are collected and neither paper cash nor the audit ledger changes.

## Research corrections and next experiments

Implemented: reject duplicate dates and non-positive/non-integer prices before AI evaluation; compute factors strictly before the entry day; report daily-close drawdown, dates, positive periods and modeled cost impact. Costs remain a simplified period-end round-trip assumption. Equal-weight rebalances each period; it is not buy-and-hold. Dividends, FX, tax and model fees are excluded.

Next research sequence:

1. Freeze input snapshots, universe, model/prompt version and experiment ID. Save every run, including failures; do not select only the best model sample.
2. Use corporate-action-adjusted, calendar-validated prices. Missing common dates are currently intersected; full missing-day and split/dividend validation remains open. Avoid survivor-only universes.
3. Compare rule-only momentum, AI allocation and equal-weight on the same dates, exposure limits, cash, costs and next-session fills. Add cash and genuine buy-and-hold controls.
4. Use several untouched rolling holdouts across different regimes, plus cost stress and repeated model runs. Report distributions, turnover, exposure, drawdown and excess returns. Six periods do not establish profitability.
5. Run rule and AI shadow portfolios alongside the manual paper account, using a deterministic shared risk policy. Proposed caps need validation; do not automatically expand the existing BAC position. Current AI evaluator permits two assets up to 50% each, which is concentrated and does not represent diversified portfolio risk management.
6. Validate stale data, duplicate orders, restarts, partial fills and settlement with the selected broker's paper environment before considering any live pilot.

Improved presentation and a more rigorous evaluator improve decisions; they do not establish proximity to profit.

## Verification

Local preview 10.9.0 built successfully. All 18 backend suites passed, including new future-price isolation, invalid-price, duplicate-date and intraperiod drawdown checks. Trading stream, background service, AI research and adaptive finance static checks passed. Actual Mac app verified: new tabs, portfolio quote stream, 31-entry verified ledger, unchanged active forward test, background setting enabled, corrected six-period real-provider evaluation and $100 deposit review marked not submitted. Withdrawal preview and invalid amount handling also have a separate behavioral test. No bank connection, live order, client delivery, commit or push occurred.
