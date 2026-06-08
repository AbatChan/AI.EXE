Return only a valid JSON object for editing one existing file. No markdown. No explanation.
Format: {"edits":[...]}

Each edit object must use one supported op:
- {"op":"replace","find":"exact old text","replace":"new text"}
- {"op":"replace_all","find":"exact old text","replace":"new text"}
- {"op":"insert_before","find":"exact anchor text","text":"inserted text"}
- {"op":"insert_after","find":"exact anchor text","text":"inserted text"}
- {"op":"prepend","text":"inserted text"}
- {"op":"append","text":"inserted text"}

Worked example — output ONLY this kind of JSON object (no prose, no ``` fences, no raw file code outside the JSON). Copy each `find`/anchor string EXACTLY from CURRENT_FILE, character for character:
{"edits":[{"op":"replace","find":".auth-form { display: none; }","replace":".auth-form { display: none; }\n.auth-form.active { display: flex; }"},{"op":"insert_after","find":"</header>","text":"\n<button id=\"clear-all\">Clear</button>"}]}

Rules:
- Prefer the smallest targeted edits that satisfy the request.
- Treat edits as bounded passes: repair or polish the specific gap without rewriting unrelated working code.
- Follow PROJECT_CONTRACT exactly when present. It is the shared plan for all project files.
- Use PROJECT_STATE as the source of truth for sibling files and latest validation issues.
- Reuse exact text from the file for find or anchor fields.
- Do not rewrite the whole file unless the request truly requires it.
- Keep unrelated working behavior intact.
- For README or guide edits, align every instruction to the actual file names, imports, runtime, and commands visible in CURRENT_FILE and RECENT_TOOL_RESULTS.
- Do not add comments or run instructions into source code unless the user explicitly asked for inline documentation.

File path: {{FILE_PATH}}
QUALITY_BAR (apply when relevant to this edit):
{{MVP_REQUIREMENTS}}
PROJECT_CONTRACT:
{{PROJECT_CONTRACT}}
PROJECT_STATE:
{{PROJECT_STATE}}
TASK:
{{TASK}}
RECENT_TOOL_RESULTS:
{{RECENT_TOOL_RESULTS}}
{{PREVIOUS_ATTEMPT_TO_IMPROVE}}
CURRENT_FILE:
{{CURRENT_FILE}}
JSON:
