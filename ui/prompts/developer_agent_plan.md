Return exactly one JSON object. No prose. No markdown.
{{AGENT_ENVIRONMENT}}
primary_stack must be "python", "web", or "generic".
Keys: task_kind, project_name, primary_stack, needs_readme, needs_run_instructions, final_requires_real_files, expected_files, affected_files, files_to_inspect, done_criteria, validation, summary, phases
task_kind: "project" | "edit" | "analysis"
primary_stack: "python" | "web" | "generic"
needs_readme: "yes" | "no"
needs_run_instructions: "yes" | "no"
final_requires_real_files: "yes" | "no"
expected_files: pipe-delimited root-relative paths like /index.html|/style.css|/README.md or empty string
affected_files: pipe-delimited root-relative paths that must be created or modified to satisfy the user, or empty string
files_to_inspect: pipe-delimited root-relative paths that should be read before deciding or editing, or empty string
done_criteria: the user-facing plan checklist (also injected to guide the agent) — 3 to 5 plain-language outcomes in the user's terms. Group related capabilities into ONE item; never split things that belong together.
validation: short pipe-delimited validation steps such as validate_files, syntax check, browser check, or manual review
summary: one short natural sentence the user can read directly before execution starts
phases: empty string for a small/medium project — a single page/screen (landing page, one-page site, single tool/script) or anything with 4 or fewer expected_files is ALWAYS small: leave phases EMPTY and build it in one pass. Also leave phases EMPTY for a large SINGLE-PAGE APP whose planned files are shared modules only (for example /index.html, /css/style.css, /js/data.js, /js/state.js, /js/router.js, /js/components.js, /js/app.js): building a tiny shell first would under-deliver, so plan the complete modular SPA in one pass. For a LARGE multi-page project with many distinct public HTML pages or language files that can be added independently, use 2-4 build phases separated by " | ". The phases must PARTITION the work — each expected_file/page/feature is built in EXACTLY ONE phase; NEVER repeat a page or feature in two phases, and NEVER add a "polish/restructure/reorganize/finalize" phase that re-touches files earlier phases already built. Phase 1 = a COMPLETE RUNNABLE vertical slice with real user-visible behavior, not an empty shell. STRUCTURE-FIRST file order (same as any language: write the markup/interface before styling/implementing it): for web, the entry HTML comes FIRST so the CSS styles the REAL structure and the JS operates on real markup — order files HTML → CSS (tokens, then base system) → JS (shared components/data/state, then behavior). NEVER style/decoration first. Multi-page sites: create ONE shared stylesheet and ONE shared components script (header/nav/footer) ONCE, reused by every page. Each later phase adds a distinct page/feature/doc deliverable from expected_files. Give each phase a short title, then " :: ", then 2-5 CONCRETE, file-grounded sub-tasks separated by " ; " — each sub-task is an ACTUAL file from expected_files, named for THIS project's real pages/features (do NOT copy generic boilerplate names). Phase order should be structure/core first, then feature groups, then docs/extras. Together the phases must cover every expected_file exactly once. Format (delimiters only — fill in this project's real files, keeping the structure-first HTML→CSS→JS order in phase 1): "<phase one title> :: <entry markup file> ; <stylesheet file> ; <shared components/script file> | <feature phase title> :: <page file> ; <page file> | <docs phase title> :: <readme file>". Phase 1 stands alone; later phases run on Continue.

Rules:
- Infer the task dynamically from the user request and chat history.
- If a workspace is already open and the request can reasonably apply to that current project, prefer task_kind="edit" or task_kind="analysis" over task_kind="project".
- Only use task_kind="project" when the user clearly wants a brand new project, separate workspace, or from-scratch build.
- For requests to create, build, make, or start something from scratch, usually use task_kind="project".
- For requests to explain, review, inspect, compare, verify, correlate, or answer how to use existing code, prefer task_kind="analysis".
- For requests to modify existing files, use task_kind="edit".
- A reported error, pasted stack trace, console output, or "it's broken / not working" is a request to FIX it: use task_kind="edit" and plan the actual code change — never task_kind="analysis". Analysis is only for read-only questions where the user explicitly wants understanding, not a fix.
- If the user asks to inspect first and then make exactly one grounded improvement, do not force an edit when the available files do not show a clear bug, misleading behavior, or documentation issue. In that case prefer task_kind="analysis".
- Requests to document, clarify, onboard, or make an existing project easier for another developer to understand usually belong to task_kind="edit", not task_kind="project".
- If the requested operation targets the workspace root itself and the tools do not support it, do not plan around fake helper files or metadata files. Prefer an explanatory completion instead.
- For project tasks, set project_name from the DISTINCTIVE SUBJECT of the app — what it IS or does — as 2 to 4 meaningful words in kebab-case (e.g. "clinic-scheduler", "inventory-auditor", "training-timer"). Name it the way a developer would name the repo. Skip filler that describes scope/quantity/quality rather than the thing itself (words like "entire", "complete", "full", "whole", "new", "simple", "basic", "modern", "offline"), and never use a single letter, an article ("a"/"an"/"the"), or a bare generic word ("app"/"site"/"project"/"tool"). Example: for "build the entire offline clinic appointment scheduler", the name is "clinic-appointment-scheduler" — NOT "entire" or "offline".
- Write summary like a professional software agent kickoff sentence, not a label.
- Keep summary specific about the deliverable and main capabilities.
- Decide file scope from the requested outcome. Do not rely on keyword recipes.
- PLAN ORDER FOR ANY PROJECT: identify the user-visible flows/screens/commands/data first, then choose the file structure that supports them, then assign shared foundations before dependent files. Web: HTML/page structure + shared components/tokens before page-specific styling. Apps/scripts: entry point + data model/core logic before optional UI polish. Never plan styling, decoration, or helper files before the structure and behavior they support.
- For project tasks, expected_files should list the smallest realistic MVP deliverables: entry point, shared foundations, core behavior files, then only the extra files needed for the requested pages/features.
- For a simple web app with separate HTML, CSS, and JavaScript, expected_files must include /index.html|/style.css|/script.js. Add /README.md only when the user asks for README/docs/run instructions.
- Follow AGENT_ENVIRONMENT for framework/build-step limits. Do NOT downgrade React, Tailwind CSS, TypeScript, Vue, Next, or similar framework requests just because the app has a local/offline fallback; only downgrade when AGENT_ENVIRONMENT says the selected provider is local/offline or the user explicitly asks for a no-build/static-file version.
- A feature-rich SPA is NOT a simple web app. If AGENT_ENVIRONMENT says local/offline and the user requests React, Tailwind CSS, TypeScript, component-based architecture, state management, or many app screens/sections, translate that into a rich offline vanilla architecture instead of dropping it: /index.html, /css/style.css, and split classic scripts such as /js/data.js, /js/state.js, /js/router.js, /js/components.js, and /js/app.js. Use normal <script defer> files in dependency order; do not use ES modules/import/export for the local/offline fallback because file:// support can be fragile.
- When a remote/API provider is selected and the user asks for a framework-style application, plan the actual local framework project files needed for that stack (for example /package.json, /index.html, /src/App.tsx, /src/main.tsx, /src/styles.css, /tsconfig.json, /vite.config.ts) instead of flattening screens into many standalone HTML files.
- For single-page app requests, keep screens/views in the app's component/view files unless the user clearly asks for separate public HTML pages.
- MULTI-PAGE WEBSITES: when the user names several distinct PUBLIC PAGES (for example Overview, Features, Workflow, Help, Request), plan ONE HTML file per page (/index.html plus one root-level HTML file per named page) PLUS shared source-of-truth files: /css/style.css, /js/components.js, and /js/script.js as needed. /js/components.js should render repeated header/nav/logo/footer/CTA elements from one definition (classic script, no modules/fetch). Later pages should link the same shared CSS/JS and use the same component hooks/classes, not paste a new inline theme/nav/footer. Never collapse a multi-page site into a single /index.html.
- BRAND/DESIGN/STRATEGY WORDS ARE NOT AUTOMATIC WEBSITE PAGES: terms like brand strategy, visual identity, typography, design system, motion system, CRO, SEO, content strategy, and implementation guide are usually guidance for HOW to build the site. If the user asks for an N-page website, produce N public HTML pages total unless they explicitly ask for additional navigable documentation pages. Put reusable visual decisions in /css/style.css, repeated markup in /js/components.js, behavior in /js/script.js, and written strategy/notes in /README.md only if docs are requested.
- Do NOT create a separate later "Branding & Design System" phase for a web build unless it is a real documentation deliverable such as README.md. Brand identity, visual design, typography, and motion must be encoded in Phase 1 source-of-truth files before dependent pages are generated.
- Building a several-page website is a real multi-file PROJECT even when the request also says "plan", "content structure", "design direction", "strategy", "SEO", or "implementation guide" — those describe the website to BUILD, not a set of public design-document pages. Only plan a single document file when the user explicitly asks for ONLY a written plan/outline and no actual pages. For such multi-page builds, also fill `phases` (each phase = a coherent set of pages/features/docs from expected_files).
- FILE STRUCTURE — design a clean, CONVENTIONAL folder layout for THIS project's language/stack UP FRONT in expected_files (good engineering: design the structure first, build into it; NEVER plan a later "reorganize/restructure files" step), and keep it across ALL phases. Always have a clear entry point at the project ROOT that the run command targets, with related code/assets grouped into sensible folders following that stack's norms. Examples (apply the spirit to any language): offline static web → /index.html + all HTML pages at root, shared /css/, /js/, /assets/ (relative links like about.html and css/style.css work from file://); Python → entry /main.py (or a package dir), helpers split into modules/folders, /requirements.txt for third-party deps; PHP → entry /index.php, shared code in /src or /includes, /assets; Java/Node/etc → that ecosystem's standard layout. Keep it as simple as the project warrants (small projects can stay flat) — but the entry file must run from the project root.
- For edit tasks, affected_files must list every file that must change for the feature to actually work. If the request needs structure, styling, and behavior, include all relevant files. If only styling changes, include only styling files.
- For edit or analysis tasks, files_to_inspect should list the files whose current contents are needed for an aware next step. Leave empty only when discovery/search is needed first.
- For follow-up edits in a small known workspace, plan to inspect the central files directly instead of searching for filenames.
- For debugging from a pasted error, plan search around distinctive error text, function names, selectors, or stack frames, then inspect the matching source file before editing.
- done_criteria is shown to the user as a checklist AND tells the agent what "done" means — so write it once, naturally, for both. Use 3 to 5 outcomes, each a meaningful chunk of the project, in the user's terms. GROUP related things into a single item instead of over-splitting. Cover the project's main features without exceeding 5 items. Example: "records can be created, edited, and archived|filters and saved views update the list|settings persist locally|import and export work".
- validation should say how to check the result. Use validate_files for static project checks when useful, but do not invent expensive checks.
- expected_files must contain text-editable deliverables only. Do not include binary assets like .png, .jpg, .jpeg, .gif, or .webp.
- README is optional. Use needs_readme="yes" only when the user asks for documentation or when setup, usage, or project structure would be unclear without it.
- If the user only asks how to run or use existing code, do not force README creation.
- If the project is simple and the final assistant message can explain how to run it clearly, prefer needs_readme="no".
- Use final_requires_real_files="yes" whenever creating a project or app from scratch.

Examples for summary style:
- "A local inventory check-in tool with item entry, status filters, and saved records."
- "First check whether the HTML structure and CSS selectors line up, then report the real mismatches."
- "Bring the existing README in line with the actual runtime and file layout."

Examples of task_kind classification (a workspace being open does NOT by itself mean the user wants an edit — classify from the request, not from workspace state):
- User asks "how do I run this?" or "how do I run to test?" with a project open → task_kind="analysis", affected_files="" (the user wants an answer, not file changes). files_to_inspect may list the entrypoint/README to ground the answer.
- User asks "what does site.py do?" or "explain the folder structure" → task_kind="analysis", affected_files="".
- User asks "why is the button not working?" → task_kind="analysis", affected_files="" (inspect/diagnose first; only propose an edit after finding the cause).
- User says "fix the login button" or "make the header sticky" → task_kind="edit", affected_files=the file(s) that must change.
- User says "create a new course catalog site" → task_kind="project", expected_files=the MVP deliverables.

Complete example output (a full plan for "create an inventory check-in web app" — copy the SHAPE and key set; vary every value to fit the real task):
{"task_kind":"project","project_name":"inventory-check-in","primary_stack":"web","needs_readme":"no","needs_run_instructions":"no","final_requires_real_files":"yes","expected_files":"/index.html|/style.css|/script.js","affected_files":"","files_to_inspect":"","done_criteria":"items can be added, edited, and archived|status filters update the list|records persist locally","validation":"validate_files","summary":"An inventory check-in web app for adding items, filtering status, and keeping records locally."}

CHAT_HISTORY:
{{CHAT_HISTORY}}
CURRENT_WORKSPACE_ROOT:
{{CURRENT_WORKSPACE_ROOT}}
CURRENT_SELECTION:
{{CURRENT_SELECTION}} ({{CURRENT_SELECTION_KIND}})
TASK:
{{TASK}}
JSON:
