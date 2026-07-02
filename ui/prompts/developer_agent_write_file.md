Write the complete final contents for one project file.
Output contract: your ENTIRE response is the raw file content for the path below and nothing else — no ``` fences, no preamble/explanation, and NEVER any of this prompt's own text inside the file (no "PROJECT_CONTRACT", "MVP_REQUIREMENTS", "TASK", "Current date", rule bullets, etc.).
Example — for a /script.js the response begins straight with code, e.g.: document.addEventListener('DOMContentLoaded', () => {
Do NOT do: a ```javascript fence, a "Here is the file:" preamble, or contract/requirement/date lines pasted into the code.

File path: {{FILE_PATH}}

Rules:
- Write a usable MVP, not a placeholder.
- Keep the file internally consistent and runnable for its role.
- Keep generated files bounded enough to finish in one response; do not overproduce decorative code that risks truncation.
- Treat this as the first implementation pass. Complete the working core now; optional polish can be added later with edit_file after validation.
- Respect the file's budget and role. Do not make one file carry the whole project.
- For CSS specifically, every opened block, string, and comment must be closed before the response ends.
- Follow PROJECT_CONTRACT exactly when present. It is the shared plan for all project files.
- Use PROJECT_STATE as the source of truth for files already written. Do not guess class names, IDs, selectors, or interaction state that conflict with PROJECT_STATE.
- For multi-page web projects with shared CSS/JS in PROJECT_STATE, an HTML page must link those shared files and reuse the same header/nav/footer/component hooks/classes. Do not include a full <style> block, a different inline design system, or a redesigned nav/footer in each page. Shared visual rules belong in the planned CSS files; repeated markup belongs in the planned components script.
- Do not turn brand strategy, visual identity, typography, design system, motion, CRO, SEO, or implementation-guide requirements into standalone public HTML pages unless FILE_PATH is explicitly one of those requested pages. For ordinary site builds, put those decisions into shared tokens/CSS/components and README/docs.
- If this is a main source file, include the core functionality requested by the task.
- If this is README.md or another guide file, ground it in the real project files and commands from RECENT_TOOL_RESULTS.
- Never invent a different stack, entrypoint, main file name, framework, or run command than what the existing files imply.
- If writing README.md for an existing project, assume the code must be inspected first and keep the instructions aligned to the actual implementation.
- Do not describe features the existing code does not implement.

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
FILE_CONTENT:
