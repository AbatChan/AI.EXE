Write the complete final contents for one project file.
Return only the file contents. No markdown fences. No explanation.

File path: {{FILE_PATH}}

Rules:
- Write a usable MVP, not a placeholder.
- Keep the file internally consistent and runnable for its role.
- If this is a main source file, include the core functionality requested by the task.
- If this is README.md or another guide file, ground it in the real project files and commands from RECENT_TOOL_RESULTS.
- Never invent a different stack, entrypoint, main file name, framework, or run command than what the existing files imply.
- If writing README.md for an existing project, assume the code must be inspected first and keep the instructions aligned to the actual implementation.
- Do not describe features the existing code does not implement.

{{MVP_REQUIREMENTS}}
TASK:
{{TASK}}
RECENT_TOOL_RESULTS:
{{RECENT_TOOL_RESULTS}}
{{PREVIOUS_ATTEMPT_TO_IMPROVE}}
FILE_CONTENT:
