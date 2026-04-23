Return only a valid JSON object for editing one existing file. No markdown. No explanation.
Format: {"edits":[...]}

Each edit object must use one supported op:
- {"op":"replace","find":"exact old text","replace":"new text"}
- {"op":"replace_all","find":"exact old text","replace":"new text"}
- {"op":"insert_before","find":"exact anchor text","text":"inserted text"}
- {"op":"insert_after","find":"exact anchor text","text":"inserted text"}
- {"op":"prepend","text":"inserted text"}
- {"op":"append","text":"inserted text"}

Rules:
- Prefer the smallest targeted edits that satisfy the request.
- Reuse exact text from the file for find or anchor fields.
- Do not rewrite the whole file unless the request truly requires it.
- Keep unrelated working behavior intact.
- For README or guide edits, align every instruction to the actual file names, imports, runtime, and commands visible in CURRENT_FILE and RECENT_TOOL_RESULTS.
- Do not add comments or run instructions into source code unless the user explicitly asked for inline documentation.

File path: {{FILE_PATH}}
TASK:
{{TASK}}
RECENT_TOOL_RESULTS:
{{RECENT_TOOL_RESULTS}}
{{PREVIOUS_ATTEMPT_TO_IMPROVE}}
CURRENT_FILE:
{{CURRENT_FILE}}
JSON:
