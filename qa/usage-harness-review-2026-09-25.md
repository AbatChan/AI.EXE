# Usage and harness review — 25 September 2026

Reviewed Claude's uncommitted 13.6.0 changes; preserved them and built/reran the Mac preview as 13.6.1 (`usage-stream-review`). No commit or release was made at that point.

## Findings fixed

- Native OpenAI-compatible completion responses bypassed usage accounting. They now record provider-reported usage, including paid empty responses, and return usage/model metadata.
- Streaming parsers could lose the final event without a blank-line terminator and did not handle CRLF boundaries. Shared incremental frame reader now preserves those events, split UTF-8, and releases its reader lock. Both OpenAI-compatible and Anthropic streams use it.
- Monthly dollar estimate used one Luna rate for all calls. The official model page specifies request-size and processing-tier differences that monthly aggregates cannot reconstruct. Removed this estimate; retained real locally tracked counts and explicitly labeled them as tracked usage rather than account-wide consumption.
- Non-finite ledger inputs could throw OverflowError. Invalid counts now safely normalize to zero.
- Decision instructions prohibited revalidation after repairs while agent-loop.js required it. Both live and fallback prompts now permit relevant rechecks after a repair and discourage unchanged passing repeats. No new intent regex or action-blocking guard.

## Verification

- All 119 JS scripts were run. Only thinking_stream_test initially failed because its isolated VM lacked the new helper; fixture updated and that test rerun successfully. No remaining JS test failure.
- New provider_stream_frames_test exercises split CRLF, byte-split Unicode, an EOF usage event, reader release and native usage wiring.
- Provider normalization/cache and reasoning-budget suites pass.
- All 27 backend suites pass outside the outer sandbox. Initial sandboxed run failed sandbox/generate/PDF subprocess tests because nested macOS sandbox execution was unavailable.
- CMake configure/build, JS syntax check and git diff --check pass.
- Packaged app visibly shows v13.6.1.

## Live Luna Agent test

Disposable project `Usage Review QA`.

Requested a Python standard-library CSV reconciliation CLI, case-insensitive first-ID wins, signed exact decimal totals, invalid-input atomicity, and unittest verification. Agent created the project, found a gap in its own CLI atomicity coverage, edited the test, reran validation and tests, and finished in 1m17s with a two-sentence answer reporting seven passing tests.

Independent subprocess checks passed: duplicate/signed total 7.75; quoted ID total 1.50; NaN and excess precision exit 2 with no partial stdout; empty input 0.00; a value beyond Decimal's default precision adds exactly to 1000000000000000000000000000000.00.

Actual API usage reports show a 4,721-token cache write followed by reads of that prefix. The composer visibly displayed 128.1k input (29% cached) / 6.8k output for the app session. The provider usage panel displayed 30 tracked monthly calls, 179.2k input (24% cached), 15.4k output. Persistent local ledger updated during the run.

## Limits

One successful live Luna regression is not proof of general model superiority or that all harness issues are solved. Other provider normalization is fixture-tested, not live-account tested. Interrupted streams may lack a provider's final usage report; local tracked totals are not the provider's bill or remaining balance. Windows packaging was not tested in this review.

Official references checked:
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/guides/evaluation-best-practices

## Usage dashboard — v13.6.2

Added Settings > Usage with a month filter, daily input/output chart, expandable chat rankings and provider/model details, and links back to chats. Settings has more vertical padding. The composer tooltip now shows context only.

New usage records preserve the originating chat ID even if the active chat changes while the provider responds. Older monthly totals remain separate as Earlier usage; daily and chat attribution starts with this update.

Validation: ledger tests cover daily/chat separation, empty periods and legacy totals. Streaming tests cover attribution across a chat switch. All 119 JavaScript scripts passed after updating the affected fixtures and configuring the new version; the Mac preview build passed. Native UI checks confirmed a real request under Usage Review Qa (2,527 input, 90 output across three provider calls), daily detail interaction, expanded cache/reasoning metrics, an empty August view, restoration of September, and Open chat navigation. The live composer showed only “Context: 2k of 256k tokens (1%).” Screenshot inspection confirmed the dashboard layout and expanded rows. Git whitespace checks passed.

## Python Run and Agent recovery — v13.7.0

The project's `reconcile.py` requires a CSV path. The Explorer Run control previously launched Python without arguments, so the process printed usage and exited. Run now asks for Python arguments and forwards each as a quoted argument to the native launcher. The Agent instructions now prefer a clearly labeled demonstration with sample input when a CLI needs data and the user asks to run it without supplying any. Tests alone are not treated as a CLI run.

In the Mac preview, the Run dialog appeared centered and the generated launch command contained the supplied CSV path. A live Agent retest of the ambiguous request “run it” eventually executed the CLI with temporary sample data, reported `Total: 1.00`, and passed all six tests. It made two failed input-creation attempts before recovering; that is a remaining efficiency issue, not a verified CLI bug. No user CSV was processed. All 119 JavaScript scripts and 27 backend suites passed; the Mac preview built. The Windows launcher was statically reviewed but not built or run.
