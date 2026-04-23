Return exactly one JSON object. No prose. No markdown.
Keys: task_kind, project_name, primary_stack, needs_readme, needs_run_instructions, final_requires_real_files, expected_files, summary
task_kind: "project" | "edit" | "analysis"
primary_stack: "python" | "web" | "generic"
needs_readme: "yes" | "no"
needs_run_instructions: "yes" | "no"
final_requires_real_files: "yes" | "no"
expected_files: pipe-delimited root-relative paths like /index.html|/styles.css|/README.md or empty string
summary: one short natural sentence the user can read directly before execution starts

Rules:
- Infer the task dynamically from the user request and chat history.
- If a workspace is already open and the request can reasonably apply to that current project, prefer task_kind="edit" or task_kind="analysis" over task_kind="project".
- Only use task_kind="project" when the user clearly wants a brand new project, separate workspace, or from-scratch build.
- For requests to create, build, make, or start something from scratch, usually use task_kind="project".
- For requests to explain, review, inspect, compare, verify, correlate, or answer how to use existing code, prefer task_kind="analysis".
- For requests to modify existing files, use task_kind="edit".
- If the user asks to inspect first and then make exactly one grounded improvement, do not force an edit when the available files do not show a clear bug, misleading behavior, or documentation issue. In that case prefer task_kind="analysis".
- Requests to document, clarify, onboard, or make an existing project easier for another developer to understand usually belong to task_kind="edit", not task_kind="project".
- If the requested operation targets the workspace root itself and the tools do not support it, do not plan around fake helper files or metadata files. Prefer an explanatory completion instead.
- For project tasks, choose a concise project_name from the core feature nouns only.
- Write summary like a professional software agent kickoff sentence, not a label.
- Keep summary specific about the deliverable and main capabilities.
- For project tasks, expected_files should list the smallest realistic MVP deliverables.
- expected_files must contain text-editable deliverables only. Do not include binary assets like .png, .jpg, .jpeg, .gif, or .webp.
- README is optional. Use needs_readme="yes" only when the user asks for documentation or when setup, usage, or project structure would be unclear without it.
- If the user only asks how to run or use existing code, do not force README creation.
- If the project is simple and the final assistant message can explain how to run it clearly, prefer needs_readme="no".
- Use final_requires_real_files="yes" whenever creating a project or app from scratch.

Examples for summary style:
- "I’ll build a classic Snake game in Python with keyboard controls, score tracking, and collision detection."
- "I’ll check whether the HTML structure and CSS selectors line up and point out any mismatches."
- "I’ll update the existing README so it matches the actual runtime and file layout."

CHAT_HISTORY:
{{CHAT_HISTORY}}
CURRENT_WORKSPACE_ROOT:
{{CURRENT_WORKSPACE_ROOT}}
CURRENT_SELECTION:
{{CURRENT_SELECTION}} ({{CURRENT_SELECTION_KIND}})
TASK:
{{TASK}}
JSON:
