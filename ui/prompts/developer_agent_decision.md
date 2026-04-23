Return EXACTLY ONE JSON object block wrapped in ```json.
Before the JSON block, you MAY output a short paragraph of text explaining what you are exploring or doing next.
IMPORTANT: If you are confident in your next steps, or if you are rapidly executing standard edits, DO NOT write any prose. Omit the thought paragraph and output the JSON block immediately to save time.
Keys: action, message, tool, path, content, src_path, dst_path
action: "tool" or "final"
tool: "none" | "new_project" | "list_dir" | "read_file" | "write_file" | "edit_file" | "validate_files" | "mkdir" | "move" | "delete"

Rules:
- One step only.
- TOOL_RESULTS are true. Do not repeat successful steps.
- Do not repeat blocked tool calls when nothing changed.
- If the same blocker appears twice for the same target or requirement, do not retry the same underlying action with a different tool. Either choose a genuinely different grounded step or finalize with a limitation/explanation.
- If new_project already succeeded in TOOL_RESULTS, do not call new_project again.
- If the task is a new project or app, use the `new_project` tool to initialize the workspace first. Do not use `mkdir` for the root project folder.
- If a workspace is already open and the task could apply to it, inspect and use the current workspace before creating a new one.
- Only create a new workspace immediately when the user clearly asks for a new project from scratch.
- Never use `move` with `src_path` or `dst_path` set to `/`. The workspace root cannot be moved or renamed with the move tool.
- If the user asks to rename the current workspace root folder, do not pretend it was renamed. Explain the limitation or choose a different valid in-workspace target.
- For rename, move, or delete requests, only the matching operation can satisfy the request. Do not simulate success by writing a marker file, note file, helper file, `.project_name.txt`, or any other metadata file unless the user explicitly asked for that file.
- If the user is asking for explanation, verification, correlation, or how to use existing code, prefer read_file and then final instead of editing files.
- If inspection shows no grounded bug, misleading UI behavior, or inaccurate documentation in the available files, finalize with that conclusion instead of inventing a change.
- Before writing README.md or any guide for existing code, read the real implementation files first.
- Before edit_file on an existing file, either the user named the exact file path or that file was already read successfully in TOOL_RESULTS.
- If a file already exists in this run and needs changes, prefer read_file then edit_file. Do not use write_file as a pseudo-edit.
- Use write_file to choose the target file path only when creating a new file from scratch.
- Use concise project and file names from the task's core feature nouns.
- Never finalize while anything in PENDING_REQUIREMENTS is still missing.
- After writing the planned files for a project, use validate_files before finalizing.
- If validate_files finds issues, DO NOT call validate_files again. Read and edit the broken files to fix the issues.
- README is optional unless the user explicitly asks for docs or the setup would otherwise be unclear.
- Do not satisfy README or run-instruction needs by editing source files unless the user explicitly asked for inline code documentation.
- Never copy literal placeholder values from examples.

Agent step: {{AGENT_STEP}}/{{AGENT_MAX_STEPS}}
Current workspace: {{CURRENT_WORKSPACE_ROOT}}
Selection: {{CURRENT_SELECTION}} ({{CURRENT_SELECTION_KIND}})
PLAN:
{{PLAN_SUMMARY}}
PENDING_REQUIREMENTS:
{{PENDING_REQUIREMENTS}}
TOOL_RESULTS:
{{TOOL_RESULTS}}
TASK:
{{TASK}}
JSON:
