# Canvas + Thinking recovery, 24 September 2026

Local preview verified: v12.7.5 (thinking-summaries). No commit, push or release.

## Reproduced

User's tortoise-and-hare story, Canvas + Think, DeepSeek API deepseek-flash:
- Native reasoning leaked into the final bubble as raw tags and internal routing/format discussion.
- An example Canvas block in reasoning created a spurious three-byte document named `...`.
- Expanded thoughts contained a complete draft of the story. Prompt-only instructions did not prevent this in a live retry.

## Fixed

- Canvas extraction and loading state now use only the answer channel. Reasoning cannot create Canvas or code artifacts.
- Routing deliberation stays internal. A separate isolated, non-thinking call produces a labeled task-level thinking summary. Main response reasoning is also summarized for display; it is not cut short internally.
- Failed/malformed summaries never fall back to raw reasoning. Cancellation is checked before committing.
- Live response row remains visible during summary preparation.

## Evidence

- Replayed the original failing raw response through the fixed parser: exactly one real story document and clean intro/outro.
- Regression scripts passed: canvas_thinking_boundary, thinking_summary, thinking_boundary, thinking_order, thinking_stream, thinking_stability, mode_priority, prompt_fallback_sync, agent_unified_result, agent_tool_group_consistency_static.
- Native build passed and v12.7.5 visibly launched.
- Live retry in the user's existing conversation: one card, `The Underground River`, clean intro/outro, Thought for 15 seconds with a labeled summary. Expanded panel had no full draft, raw control tags or system/routing discussion. Opened the document and verified actual story text.
- Original response branches preserved. Corrected `tutoise` to `tortoise` in an edited branch after a transient provider `Load failed` error. No user conversations deleted.

## Remaining limits

- The model produced 480 whitespace-delimited words for a 500-word request. Exact length compliance is not enforced by these UI fixes.
- Old saved branches retain their original rendered content/artifacts; they were not silently migrated or removed.
- Native reasoning can still contain drafts internally; the UI displays a model-generated summary rather than exposing that raw stream. Summary generation adds calls/latency and is not a blanket guarantee about all future model phrasing.
- A transient provider connection error occurred on one attempt. Error messages currently lack a direct retry control; recovery used the message editor. This separate recovery UX issue remains open.
- This pass verified Canvas + Thinking, not the entire action-combination matrix.

## Card polish follow-up (v12.7.7)

- Loading uses the same document-card geometry with an icon placeholder and two skeleton lines, no premature title. The loader node is retained across stream updates and remains until commit; new cards reveal with a reduced-motion-aware fade.
- Removed sizes from chat chips, artifact list metadata and document details. Renamed the user's story conversation via UI to `Story of tortoise 500 words`; verified detail metadata reads `Document · 7 mins ago · Story of tortoise 500 words`.
- Removed the redundant Thinking summary heading from new output and older saved panel rendering. Summary prompt now asks for direct first-person wording.
- Live retry showed one Writing document status followed by one finished card. Found a duplicate typing indicator restored by the watchdog; fixed the guard and verified both suppression with live content and restoration with missing content in the DOM regression test.
- Rebuilt/relaunched v12.7.7. Tests passed for stable thinking/Canvas nodes, summary handling, Canvas boundaries, mode priority, prompt synchronization and unified results.
- The latest summary still mentions Canvas formatting in one sentence despite the instruction excluding implementation detail. Removing the heading is verified; fully natural summary wording remains model-dependent.

## Selection and action order (v12.7.8)

- Agent, Canvas and Context now set the same aria-pressed state as Think/Search. Exercised all 32 combinations in mode_selection_artifacts_test.js; native screenshot showed all five selected icons/labels in the accent color. Context uses actual saved context, not merely opening its editor.
- Initial thought summary creates its live row before research. Search pending/completed rows remain between Thinking and Canvas, including while the skeleton is displayed. Agent fallback insertion preserves reasoning before search.
- Removed the conflicting one-artifact instruction for Canvas+Think; distinct requested deliverables can share a response/chat. Runtime storage test preserves text/code artifacts across multiple message timestamps.
- Native disposable test with Think+Search+Canvas+Context and Agent off: initial Thought visible above Searching the web, then two separately openable documents, Private Storage Guide and Storage Checklist. First contained a short guide with MDN link; second contained four bullets. Single response, two distinct cards, no workspace change.
- Trace chat_muew214l_ylm2mz: assessment 02:04:15.721Z, Canvas route 02:04:17.124Z, answer request after search 02:04:32.315Z, finish 02:04:37.928Z.
- Deleted the disposable chat after checking both documents; artifact count restored from six to four. User's Morning Brief chat preserved and reopened.
- Model-content caveat: guide claimed writes can silently fail whereas the checklist correctly described catching QuotaExceededError. This pass validates mode/order/artifact mechanics, not factual perfection of generated prose.
- Build, syntax, selection/artifact test, Canvas boundary, thinking order/stability, mode priority, automatic/contextual search, prompt sync and unified-result checks passed.
