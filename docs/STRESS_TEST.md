# AI.EXE Stress Test Checklist (v2.4.4)

Run top to bottom in the Mac preview. Confirm the corner version first. Open the debug trace to verify the markers listed per test.

## 1. Agent — new build (deterministic path)
- Prompt (Agent ON): "Create a monochromatic playing card with perspective hover, iridescent highlights, noise texture, mouse-reactive specular glow, and a tweaks panel."
- Expect: `agent_deterministic_decision` per file → one `validate_files` → `agent_done autoFinalized`. No re-reads of just-written files. Advisory notes (if any) listed but non-blocking.
- Quality: open index.html — controls work on first touch (no scale(50)-style unit bugs), one coherent design.

## 2. Agent — follow-up edit
- In the same chat: "add a control to choose suits and rank".
- Expect: reads each file once → targeted `edit_file`s with "Applied changes:" echoes → validate → grounded final naming the real diffs. Edit card at the bottom: "Edited N files +A −R".
- Trace: no `agent_read_loop_blocked` storms, no `agent_duplicate_decision_repaired` to a different file.

## 3. Finish audit (no-op fix catch)
- Ask for a change, then ask for the SAME change again ("make the layout side by side" twice).
- Expect: second run either makes a real complementary fix or finalizes saying it's already done. If it ships a no-op diff, `agent_criteria_nudge` should appear once before finish.

## 4. Structural guard
- Ask: "remove the controls wrapper div but keep the controls" (bait for unbalanced HTML).
- Expect: if the model emits a tag-breaking edit, `agent_edit_structural_reject` fires, file untouched, run recovers (targeted edit or full rewrite allowed after 1 failed edit).

## 5. Polish-loop breakers
- Ask a vague style task: "make the styling more premium".
- Expect: ONE write/edit per file max unless something failed. If the model tries to read back or rewrite a just-written file: `agent_read_after_own_write_blocked` / `agent_repeat_rewrite_blocked`, then validate → finalize. Run total tokens in the ring tooltip should stay far below the old ~90K flail runs for small tasks.

## 6. Revert / edit card
- After test 2: card shows EDITED files only (a fresh build response shows NO card).
- Hover the +A −R → "Review changes ↗" → expands and scrolls the work panel. Click a file row → opens that file's diff drawer inside the work panel (not the file).
- Undo → files restored to pre-response state (verify in the file viewer); button flips to Redo; toggle back. Trace: `agent_edits_reverted` mode revert/restore.
- Stacking: two edit responses touching the same file → Undo newest = previous response's version; Undo both = original.
- Agent awareness: after a revert, ask the agent a follow-up — it must NOT re-apply the reverted edits (WORKSPACE EVENTS in its context).
- Reload the app: the card and Undo still work (persisted).

## 7. Per-chat gating + send queue
- Start a long agent run, switch to a NEW chat: plus menu opens, modes toggle, attach works, typing works.
- Send a message there: the user bubble posts immediately, notice "Queued — I'll answer here as soon as the other chat finishes", trace `send_queued`; when the run ends, the queued answer starts automatically. The running chat must NOT cancel.
- Queue two messages in two different chats → both answered in order after the run.
- In the RUNNING chat itself, Enter while generating → "press stop to interrupt" (blocked, not queued).
- Timer "Xs" and ring run-stats show only in the running chat; other chats show their own context fill.
- Switch back to the running chat mid-run: live progress row reattaches; Stop (send button) cancels only there.
- Delete a different chat during a run: run unaffected. Delete the running chat: run cancels.

## 8. Token ring
- During a run: tooltip shows `run ≈X tok` climbing per step. After: `last agent run ≈X` + `session ≈Y` persist until the next run.
- Cross-check: sum the `agent_inference_usage` trace entries ≈ the run total.
- Bare number = context fill of the visible chat (small), NOT usage — sanity-check it doesn't jump to 90K after a run ends.

## 9. Think mode
- Think ON + non-thinking model (deepseek-chat): Thoughts panel appears from the prompted `<thinking>` block; visible answer self-contained.
- Think ON + reasoning model (deepseek-reasoner / V4 default): native reasoning streams into the Thoughts panel (reasoning_content path); answer follows after.
- Think OFF: no Thoughts panel, fast responses (thinking-off override active).
- `/think` prefix forces it for one message.

## 10. Context action
- Set context: "All visible UI text must be in French. Use only system fonts."
- Chat: answers obey. Agent run: generated files obey (labels French, no webfonts) — this is new in v2.4.3; previously agent ignored context.
- Clear context → next outputs revert.

## 11. Canvas
- Canvas ON: "write a product spec for a habit tracker" → one intro sentence outside, full content inside the canvas artifact, no generic outro.
- Follow-up "is that section realistic?" → answers in normal chat (soft routing), no new artifact.
- Canvas + Think together: Thoughts panel first, then intro, then canvas (combined ordering rule).

## 12. Inspect
- Agent OFF, workspace open: "what does script.js do?" → read-only streamed answer, "Xs" timer runs, no file mutations in the tree.

## 13. Providers / context windows
- DeepSeek: in a multi-file edit, generation prompts include full sibling files (verify quality: cross-file ids/defaults agree on first try).
- Local model: same task still works (signals/head tier; 24K budget) — slower but no context overflow errors.
- Custom HF model: agent functions with the conservative 16K budget (no window overflow on small models).

## 14. Abuse / edge
- Paste a raw JS error in an open workspace → routes to Agent fix (not a lecture).
- "delete style.css" → pauses for explicit confirmation before trashing.
- Stop button mid-run → run ends cleanly, no background generation continues (no late "request_cancelled" ghosts), partial work committed with Continue available.
- Mash Continue/send during a run → globally gated, no double operation.
- Kill the network mid-run (remote provider) → transient retry once, then a clean failure message, never a frozen "Writing answer…".
- Error wording: break an API key / use a depleted account → chat shows a plain-language message ("rejected the API key — check Settings" / "out of credits — top up or switch provider"), never a raw `(402): {"error":...}` JSON dump. Raw detail remains in the debug trace.

Log failures with the chat's trace excerpt — every guard above has a named trace marker.
