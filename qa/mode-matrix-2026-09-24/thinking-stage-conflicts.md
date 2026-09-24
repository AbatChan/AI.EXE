# Thinking stages and chat isolation — 24 September 2026

## Changes

- Preserve the completed pre-search summary and its timestamps. Later reasoning has a separate “Reviewing the response…” indicator rather than rewriting the first panel.
- Extract Code artifacts from visible text outside Canvas; embedded examples remain inside their document.
- Honour an explicit model decision that Canvas creation needs no filesystem mutation. Reading the current project plus creating a chat document must not prompt to create a filesystem project.
- Snapshot selected modes per request, including queued sends. Background prompt building, reasoning, routing and Canvas progress use the request's modes rather than the visible chat's switches.
- Put confirmation actions in their own footer, avoiding nested buttons. Use neutral theme tokens and an SVG Return icon with inherited contrast.
- Rename completion toast to “Ready when you are”.

## Live packaged-preview evidence

- v12.8.4, Think + Search + Canvas: initial summary text and 3-second duration unchanged after search/final result. Official MDN sources visible. One document. Found duplicate Code extraction from an embedded example; fixed subsequently.
- v12.8.5, Think + Search + Canvas + Context: initial summary/duration unchanged; context title and short document honoured; one document and no extra Code artifact. Generated example suggested clearing localStorage: answer-quality failure, not executed.
- v12.8.5, all five modes: incorrect project question; fixed. Initial summary unavailable. Document misinterpreted NESTED-OK as lacking file contents; recorded as a quality failure.
- v12.8.7, all five modes: no incorrect project question. Read current result.txt, searched MDN, produced Birch Safety Note with exact NESTED-OK quote, declared Map fallback, official link. One document, no extra Code artifact. Completion checklist still marked all criteria unverified, so this is not an end-to-end pass.
- v12.8.7 switching: started a Think response in Cedar fixture, created Maple chat while it ran and sent ordinary prompt. Cedar answer remained in original chat with Think; Maple returned MAPLE — 42, no inherited modes/artifacts.
- v12.8.7 Agent switching: while all-five Agent ran, queued a Maple follow-up in the existing Maple chat. It returned MAPLE only; Agent document remained in Agent chat.

The current engine queues responses across chats; these tests do not demonstrate simultaneous generation. Queued jobs remain in memory only across an app restart.

## Checks

Passing: thinking stability, summary, order, stream, mode selection (32 combinations), Canvas boundaries, semantic routing, 32 preflight routing cases, response recovery, agent matrix recovery, and chat-mode isolation regression. Packaged build succeeds.

Read-only fixture SHA-256 remains 6ce95fe261f4db4de291fec3823cdad91f934f3ce98b60799fa9285258296787.

## Remaining issues

Agent criteria verification can disagree with saved document evidence; investigate verifier results/timeouts before changing completion truthfulness. Generated advice needs semantic review even when mode ordering and artifact handling pass. Summary generation can fail without leaking raw reasoning (currently shows Summary unavailable).

## Final visual check and cleanup

v12.8.7 actual project-scope confirmation: both options visible with separate Dismiss/Submit footer; high-contrast SVG Return icon visibly renders in the Submit button. Dismiss tested without filesystem mutations. All disposable chats from these tests removed, returning to the user's Trending News Article with Artifacts 2 / Code 1.

v12.8.8 additionally changes completion notification title to “Ready when you are”; packaged build passed. No dependency metadata sent to a registry, no commit/push/release.
