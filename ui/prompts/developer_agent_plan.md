Return exactly one JSON object. No prose. No markdown.
Keys: task_kind, project_name, primary_stack, needs_readme, needs_run_instructions, final_requires_real_files, expected_files, affected_files, files_to_inspect, done_criteria, validation, summary
task_kind: "project" | "edit" | "analysis"
primary_stack: "python" | "web" | "generic"
needs_readme: "yes" | "no"
needs_run_instructions: "yes" | "no"
final_requires_real_files: "yes" | "no"
expected_files: pipe-delimited root-relative paths like /index.html|/style.css|/README.md or empty string
affected_files: pipe-delimited root-relative paths that must be created or modified to satisfy the user, or empty string
files_to_inspect: pipe-delimited root-relative paths that should be read before deciding or editing, or empty string
done_criteria: short pipe-delimited criteria written in the user's terms, not code heuristics
validation: short pipe-delimited validation steps such as validate_files, syntax check, browser check, or manual review
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
- Decide file scope from the requested outcome. Do not rely on keyword recipes.
- For project tasks, expected_files should list the smallest realistic MVP deliverables.
- For a simple web app with separate HTML, CSS, and JavaScript, expected_files must include /index.html|/style.css|/script.js. Add /README.md only when the user asks for README/docs/run instructions.
- For edit tasks, affected_files must list every file that must change for the feature to actually work. If the request needs structure, styling, and behavior, include all relevant files. If only styling changes, include only styling files.
- For edit or analysis tasks, files_to_inspect should list the files whose current contents are needed for an aware next step. Leave empty only when discovery/search is needed first.
- For follow-up edits in a small known workspace, plan to inspect the central files directly instead of searching for filenames.
- For debugging from a pasted error, plan search around distinctive error text, function names, selectors, or stack frames, then inspect the matching source file before editing.
- done_criteria should say what must be true before finalizing, for example "calculator controls exist|calculator buttons work|theme preference persists".
- validation should say how to check the result. Use validate_files for static project checks when useful, but do not invent expensive checks.
- expected_files must contain text-editable deliverables only. Do not include binary assets like .png, .jpg, .jpeg, .gif, or .webp.
- README is optional. Use needs_readme="yes" only when the user asks for documentation or when setup, usage, or project structure would be unclear without it.
- If the user only asks how to run or use existing code, do not force README creation.
- If the project is simple and the final assistant message can explain how to run it clearly, prefer needs_readme="no".
- Use final_requires_real_files="yes" whenever creating a project or app from scratch.

Examples for summary style:
- "A compact Snake game with keyboard controls, score tracking, and collision detection."
- "First check whether the HTML structure and CSS selectors line up, then report the real mismatches."
- "Bring the existing README in line with the actual runtime and file layout."

CHAT_HISTORY:
{{CHAT_HISTORY}}
CURRENT_WORKSPACE_ROOT:
{{CURRENT_WORKSPACE_ROOT}}
CURRENT_SELECTION:
{{CURRENT_SELECTION}} ({{CURRENT_SELECTION_KIND}})
TASK:
{{TASK}}
JSON:
