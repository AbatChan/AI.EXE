You previously returned invalid output.
Return EXACTLY ONE JSON object block wrapped in ```json.
Before the JSON block, you MAY output a short paragraph of text explaining what you are exploring or why the previous output was invalid.
IMPORTANT: If you are confident in your next steps, DO NOT write any prose. Omit the thought paragraph and output the JSON block immediately to save time.
Keys: action, message, tool, path, content, src_path, dst_path
action: "tool" or "final"
tool: "none" | "new_project" | "list_dir" | "search_files" | "read_file" | "write_file" | "edit_file" | "validate_files" | "mkdir" | "move" | "delete"

Rules:
- For write_file, keep content empty unless a short literal payload is necessary.
- For edit_file, put the JSON edit program inside content.
- If the task is not done yet, return {"action":"tool",...}.
- If the task is complete, return {"action":"final","tool":"none",...}.
- If the same blocker appears twice for the same target or requirement, do not retry the same underlying action with a different tool. Either choose a genuinely different grounded step or finalize with a limitation/explanation.
- If the user is asking for explanation or instructions about existing code, prefer read_file and then final instead of editing files.
- If the next file to edit is unclear, prefer PLAN paths, validation issue paths, and already-listed source files. Use search_files only when no grounded candidate file is known.
- For a new app/project that includes README.md, do not stop to inspect before writing it; use the planned files and recent writes. Only read implementation files first for docs-only or existing-code documentation tasks.
- If validate_files finds issues, DO NOT call validate_files again. Read and fix the specific files.
- Never copy literal placeholder values from examples.
- Never use `move` with `src_path` or `dst_path` set to `/`. The workspace root cannot be moved or renamed with the move tool.
- If the user asked to rename the current workspace root and that is the blocked target, do not claim success. Explain the limitation or choose a different valid path.
- For rename, move, or delete requests, only the matching operation can satisfy the request. Do not simulate success by writing a marker file, note file, helper file, `.project_name.txt`, or any other metadata file unless the user explicitly asked for that file.
- If inspection showed no grounded change to make, finalize with that conclusion rather than inventing a fix.
- Before edit_file on an existing file, either the user named the exact file path or that file was already read successfully in TOOL_RESULTS.

Agent step: {{AGENT_STEP}}/{{AGENT_MAX_STEPS}}
TASK:
{{TASK}}
PENDING_REQUIREMENTS:
{{PENDING_REQUIREMENTS}}
TOOL_RESULTS:
{{TOOL_RESULTS}}
INVALID_OUTPUT_TO_AVOID:
{{INVALID_OUTPUT_TO_AVOID}}
JSON:
