# Natural conclusions — v12.9.8

Removed file inventories and duplicated detail from deterministic completion fallbacks. Unmet criteria now go back into the model's completion context for a short explanation instead of replacing its answer with a raw checklist. Contradictory generated drafts get one rewrite attempt before a minimal truthful fallback. Run instructions are no longer appended when the Run card already provides the action.

Completion prompts request 1–3 sentences, usually 25–60 words, with outcome and material limitation. Inspection summaries also use concise grounding and cannot claim command execution; execution requests are routed to Agent even when source edits are forbidden.

Validation: syntax, packaged build, completion preservation, completion evidence, matrix recovery, change grounding, semantic routing and build recovery tests pass. Live Agent test executed npm run build, exit 0. Its final response was 28 words, with no file inventory, raw checklist, or appended Run instruction. Earlier saved replies remain historical evidence.

The first live attempt exposed inspection-mode execution hallucination; that attempt did not run a command. The subsequent actual Agent test did run the command and verified success. No dependency install or database reset/seed was performed in this validation.
