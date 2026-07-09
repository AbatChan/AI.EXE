You previously returned invalid output.
Return EXACTLY ONE JSON object block wrapped in ```json. No prose before or after the JSON.
For tool steps, put any short progress note in the JSON `message` field only. The UI shows that message immediately before running the tool, so do not also write a separate thought paragraph. Do not repeat the phase-start narration that was already shown.
Keys: action, message, tool, path, content, src_path, dst_path, paths, command, start_line, end_line
Key use by tool: `path` for read_file/write_file/edit_file/list_dir/check_code/run_app/mkdir/delete (read_file may add `start_line`/`end_line`); `paths` (array) for read_files; `content` for write_file/edit_file payloads and the search_files query; `command` for run_command; `src_path` + `dst_path` for move. Omit keys a tool does not use.
action: "tool" or "final"
tool: "none" | "new_project" | "list_dir" | "search_files" | "read_file" | "read_files" | "write_file" | "edit_file" | "validate_files" | "check_code" | "run_app" | "run_command" | "mkdir" | "move" | "delete"

Valid output examples (your reply is ONE ```json block shaped like these — use your real values, not these):
A tool step:
```json
{"action":"tool","message":"Checking script.js first so the fix is grounded in the actual code.","tool":"read_file","path":"/script.js"}
```
An edit (note: the edit program is a JSON string inside "content"):
```json
{"action":"tool","message":"Found the hidden form rule; adding the active state now.","tool":"edit_file","path":"/style.css","content":"{\"edits\":[{\"op\":\"replace\",\"find\":\".form{display:none}\",\"replace\":\".form{display:none}\\n.form.active{display:block}\"}]}"}
```
Finishing:
```json
{"action":"final","tool":"none","message":"Added the active-form rule in /style.css — the signup form shows now."}
```

Rules:
- For write_file, keep content empty unless a short literal payload is necessary.
- For edit_file, put the JSON edit program inside content.
- If the task is not done yet, return {"action":"tool",...}.
- If the task is complete, return {"action":"final","tool":"none",...}.
- If the same blocker appears twice for the same target or requirement, do not retry the same underlying action with a different tool. Either choose a genuinely different grounded step or finalize with a limitation/explanation.
- Prefer writing files directly: write_file creates needed parent folders automatically. Use mkdir only when the folder itself is a user-visible deliverable or the plan explicitly requires an empty folder.
- If the user is asking for explanation or instructions about existing code, prefer read_file and then final instead of editing files.
- If the next file to edit is unclear, prefer PLAN paths, validation issue paths, and already-listed source files. Use search_files to locate pasted errors, symbols, selectors, or keywords inside files; do not use it as filename discovery.
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
