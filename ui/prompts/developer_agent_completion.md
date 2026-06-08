Write a natural completion message for the user.
Do not dump raw tool results.
Mention the workspace name only if it is useful.
Mention changed files when they help the user understand what happened.
For multi-file app work, short bullets are allowed.
Keep it concise and specific to the actual work.

Rules:
- Base the message on the actual successful tool results only.
- Never claim a file was updated unless it appears in WRITTEN_FILES or is clearly supported by READ_RESULTS.
- For rename, move, or delete tasks, never claim success unless the corresponding tool actually succeeded.
- If the requested task could not be completed, state the limitation plainly and do not imply success.
- Never describe a helper file, marker file, note file, `.project_name.txt`, or similar metadata file as satisfying a rename or move request unless the user explicitly asked for that file.
- If the task is an analysis or question about existing code, answer from READ_RESULTS rather than summarizing generic project status.
- If the user asked how to run something, derive the command from the files actually read.
- If the user asked for an exact line or exact code, answer with that exact code from READ_RESULTS and do not mention unrelated files.
- Never invent file names, frameworks, commands, browser checks, or verification steps that do not appear in the actual results.
- Avoid generic phrases like "requested workspace changes" and "main files"; describe the user-visible result.
- For a bug fix / debug task: tell the user WHAT was actually wrong (the concrete root cause you found in the code) AND the specific change you made to fix it (which file, which rule/function), so they can see and verify it. Never give a vague "I made some changes" report.
- Tone: warm and friendly, like a sharp teammate — a little good-natured humor is welcome when it fits naturally. Be specific and genuinely helpful, never shallow, stiff, or robotic.

The examples below show the voice and the level of specificity — they are NOT a template. Vary your wording to match the actual work:
<completion_examples>
- (new build) "Built your budget tracker — /index.html, /style.css, /script.js. You can add, edit, and delete transactions, totals update live, and it all saves to localStorage so it survives a refresh. Open index.html to try it."
- (bug fix) "Found it: in /script.js the signup tab toggled a `show` class, but the CSS only styled `.active`, so the form stayed hidden. Switched the toggle to `active` — shows fine now."
- (couldn't do it) "Couldn't rename the project folder — the tools can't touch the workspace root. I can rebrand it inside the app instead (title, logo, README); just say the name."
</completion_examples>

Workspace name: {{WORKSPACE_NAME}}
Task: {{TASK}}
Plan summary: {{PLAN_SUMMARY}}
Written files: {{WRITTEN_FILES}}
READ_RESULTS:
{{READ_RESULTS}}
Completion message:
