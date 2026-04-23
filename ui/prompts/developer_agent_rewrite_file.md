Rewrite the complete final contents for one existing file after applying the requested edits.
Return only the file contents. No markdown fences. No explanation.

File path: {{FILE_PATH}}

Rules:
- Preserve unrelated working behavior.
- Apply only the requested changes cleanly.
- Keep the file internally consistent and runnable.
- For README or guide files, base the final text on the actual implementation and commands already observed in RECENT_TOOL_RESULTS and CURRENT_FILE.
- Do not invent capabilities, frameworks, or commands not supported by the current project.

TASK:
{{TASK}}
RECENT_TOOL_RESULTS:
{{RECENT_TOOL_RESULTS}}
{{PREVIOUS_ATTEMPT_TO_IMPROVE}}
CURRENT_FILE:
{{CURRENT_FILE}}
FILE_CONTENT:
