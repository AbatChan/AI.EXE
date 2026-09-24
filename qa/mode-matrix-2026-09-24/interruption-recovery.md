# Interruption recovery — local preview 12.8.1

The active response is checkpointed per signed-in user every second and on normal unload. Stop commits saved output with an interruption note and Continue. Reopening recovers into the original chat branch, with duplicate protection. Incomplete Canvas payloads become explicitly unfinished documents. Agent activity snapshots use the existing interrupted-run renderer.

Manual Continue starts a new response instead of splicing prose into the interruption notice. Canvas continuation includes the saved document content. Pending search state is ended during recovery.

## Verified

- Live Stop retained a partial story and displayed Interrupted by you plus Continue.
- Terminated the local preview process during a Canvas skeleton/stream, then relaunched. The Amber Signal (unfinished) was restored with the app-closed note and Continue. Opening the card showed the saved story content.
- Continue produced a separate final response and document; the saved interruption remained intact.
- Disposable Lighthouse Keeper Brass Key chat and its two artifacts removed; artifact count returned from six to four.
- Recovery regression covers partial Canvas, branch ownership, duplicate prevention, checkpoint cleanup ownership, ended search state, separate continuation, and draft context scoped to the original chat/message.
- Thinking stability/boundary/order, mode selection/artifacts, agent matrix recovery and unified result checks passed. Native preview build passed.

## Limits

Live app-exit testing used SIGTERM, not the window close button. The periodic checkpoint survived that process termination. A sudden exit can lose the newest unsaved fragment; this is resumable saved work, not automatic background execution. The final draft-context addition has regression coverage; the successful live Continue preceded that addition. Agent recovery was covered by regression tests in this pass, not a fresh live Agent run.

## Neutral interruption styling — 12.8.3

User Stop and recovered sessions now have a persisted, compact gray pause notice. Agent interrupted rows use paused state rather than error; running/pending rows are frozen as paused, completed rows remain done, and real errors remain errors. Manual Stop was visually verified in ordinary chat and during an Agent Canvas call, including the expanded Worked panel and Continue. No active loader remained. Connection-unavailable notifications retain their existing warning treatment; failure styling retains red. Recovery and tool-group regression checks pass.
