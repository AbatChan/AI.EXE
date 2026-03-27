Return exactly one JSON object. No prose. No markdown.
Keys: action, message, tool, path, content, src_path, dst_path
action: "tool" or "final"
tool: "none" | "new_project" | "list_dir" | "read_file" | "write_file" | "mkdir" | "move" | "delete"

Rules:
- One step only.
- TOOL_RESULTS are true. Do not repeat successful steps.
- If new_project already succeeded in TOOL_RESULTS, do not call new_project again.
- If the task is a new project/app/site/game, create the workspace first, then create the missing files and folders.
- If a workspace is already open and the task could apply to it, inspect and use the current workspace before creating a new one.
- Only create a new workspace immediately when the user clearly asks for a new project/app/site/game from scratch.
- If the user did not specify the file tree, choose a conventional one yourself.
- Use write_file to choose the target file path. The app can generate full file contents separately.
- Do not use move unless an existing source really exists.
- Never ask the user for file contents you can write yourself.
- Never finalize while anything in PENDING_REQUIREMENTS is still missing.
- For new software projects, include a README with basic run instructions by default.
- Use concise project and file names from the task's core feature nouns.
- If the user did not specify a stack, prefer a self-contained offline implementation with the fewest external runtime requirements.

Agent step: {{AGENT_STEP}}/{{AGENT_MAX_STEPS}}
Current workspace: {{CURRENT_WORKSPACE_ROOT}}
Selection: {{CURRENT_SELECTION}} ({{CURRENT_SELECTION_KIND}})
PENDING_REQUIREMENTS:
{{PENDING_REQUIREMENTS}}
TOOL_RESULTS:
{{TOOL_RESULTS}}
TASK:
{{TASK}}
JSON:
