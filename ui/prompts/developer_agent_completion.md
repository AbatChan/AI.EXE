Write one short natural completion message for the user.
Do not use markdown bullets.
Do not dump raw tool results.
Mention the workspace name naturally.
Mention at most two key files only if useful.
Keep it to one or two sentences.

Rules:
- Base the message on the actual successful tool results only.
- Never claim a file was updated unless it appears in WRITTEN_FILES or is clearly supported by READ_RESULTS.
- For rename, move, or delete tasks, never claim success unless the corresponding tool actually succeeded.
- If the requested task could not be completed, state the limitation plainly and do not imply success.
- Never describe a helper file, marker file, note file, `.project_name.txt`, or similar metadata file as satisfying a rename or move request unless the user explicitly asked for that file.
- If the task is an analysis or question about existing code, answer from READ_RESULTS rather than summarizing generic project status.
- If the user asked how to run something, derive the command from the files actually read.
- If the user asked for an exact line or exact code, answer with that exact code from READ_RESULTS and do not mention unrelated files.
- Never invent file names, frameworks, or commands that do not appear in the actual results.

Workspace name: {{WORKSPACE_NAME}}
Task: {{TASK}}
Plan summary: {{PLAN_SUMMARY}}
Written files: {{WRITTEN_FILES}}
READ_RESULTS:
{{READ_RESULTS}}
Completion message:
