(function initAIExeAgentCore(global) {
  function createAgentCore(deps) {
    const normalizeWorkspaceName = typeof deps.normalizeWorkspaceName === 'function'
      ? deps.normalizeWorkspaceName
      : (value) => String(value || '').trim();
    const normalizeWorkspacePath = typeof deps.normalizeWorkspacePath === 'function'
      ? deps.normalizeWorkspacePath
      : (value) => String(value || '').trim();
    const looksLikePlaceholderImplementation = typeof deps.looksLikePlaceholderImplementation === 'function'
      ? deps.looksLikePlaceholderImplementation
      : ((content) => /\b(todo:|coming soon|implement this|placeholder code|placeholder content)\b/i.test(String(content || '')));
    const isLocalInferenceProvider = typeof deps.isLocalInferenceProvider === 'function'
      ? deps.isLocalInferenceProvider
      : () => true;
    const WEB_TASK_HINT_REGEX = /\b(html|css|javascript|website|web|site|landing page|page|frontend|browser|ui)\b/i;

    function sanitizeProjectSlug(candidate, projectKind = '') {
      let slug = String(candidate || '')
        .toLowerCase()
        .replace(/^(can-you|could-you|would-you|please|help-me|i-need|i-want|make-me|build-me|design-me)-?/i, '')
        .replace(/[^a-z0-9\s_-]+/gi, ' ')
        .replace(/^(create|build|make|design|develop|craft|start|setup|set-up|generate|draft)[\s_-]+(a|an|the)?[\s_-]*/i, '')
        .replace(/\b(good|great|simple|nice|modern|clean|beautiful|responsive|basic|small|cool|professional|awesome|best|solid)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(a|an|the)\s+/i, '')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      if (!slug) return '';
      if (projectKind === 'game' && !slug.endsWith('-game')) slug = `${slug}-game`;
      if (projectKind === 'site' && !/(?:-site|-website|-page)$/.test(slug)) slug = `${slug}-site`;
      if (projectKind === 'dashboard' && !slug.endsWith('-dashboard')) slug = `${slug}-dashboard`;
      if (projectKind === 'website' && !/(?:-website|-site|-page)$/.test(slug)) slug = `${slug}-website`;
      if (projectKind === 'api' && !slug.endsWith('-api')) slug = `${slug}-api`;
      if (projectKind === 'cli' && !slug.endsWith('-cli')) slug = `${slug}-cli`;
      if (projectKind === 'tracker' && !slug.endsWith('-tracker')) slug = `${slug}-tracker`;
      if (projectKind === 'manager' && !slug.endsWith('-manager')) slug = `${slug}-manager`;
      if (projectKind === 'generator' && !slug.endsWith('-generator')) slug = `${slug}-generator`;
      if (projectKind === 'editor' && !slug.endsWith('-editor')) slug = `${slug}-editor`;
      return slug;
    }

    function parsedProjectNameLooksUsable(value, taskText = '') {
      const raw = String(value || '').trim();
      if (!raw) return false;
      if (raw.length > 48) return false;
      if (/[/.\\]/.test(raw)) return false;
      if (/\b(return exactly|json object|write_file|read_file|tool|step|rules:|keys:|action:|message:)\b/i.test(raw)) return false;
      const lower = raw.toLowerCase();
      if (/^(?:app|project|site|website|page|tool|ui|style|web|frontend|interface|screen|home|modern)$/i.test(lower)) return false;
      const wordCount = lower.split(/\s+/).filter(Boolean).length;
      if (wordCount > 5) return false;
      if (/\b(can|could|would|please|help|need|want|design|create|build|make|start)\b/.test(lower) && wordCount > 3) return false;
      const derived = String(deriveProjectNameFromTask(taskText || '') || '').toLowerCase();
      if (derived && lower === derived) return true;
      return /^[a-z0-9][a-z0-9\s_-]*$/i.test(raw);
    }

    function deriveProjectNameFromTask(taskText) {
      const source = String(taskText || '').toLowerCase();
      if (!source) return '';
      const landingSubjectMatch = source.match(/\blanding\s+page\s+(?:for|about|of)\s+([a-z0-9][a-z0-9\s_-]{1,44}?)(?=\s+(?:with|featuring|that|which|using|including)\b|[,.!?]|$)/i);
      if (landingSubjectMatch && landingSubjectMatch[1]) {
        return sanitizeProjectSlug(`${landingSubjectMatch[1]} landing`);
      }
      if (/\bdesktop[-\s]?style\b[\s\S]*\b(?:operating system|os|home screen|desktop ui|desktop interface)\b/i.test(source)
        || /\bmodern operating system home screen\b/i.test(source)) {
        return 'desktop-os-interface';
      }
      if (/\bdesktop[-\s]?style\b[\s\S]*\b(?:web app|app|ui|interface)\b/i.test(source)) {
        return 'desktop-ui';
      }
      const cleanedSource = source
        .replace(/^[^a-z0-9]*(can you|could you|would you|please|help me|i want|i need|make me|build me|design me)\b/i, '')
        .replace(/^[^a-z0-9]+/, '')
        .trim();
      const kindMatch = source.match(/\b(project|app|site|tool|game|dashboard|website|page|cli|api|service|bot|assistant|tracker|manager|generator|editor)\b/);
      const projectKind = kindMatch ? kindMatch[1] : '';
      const patterns = [
        /\b(?:create|build|make|design|develop|craft|start)\s+(?:a|an)?\s*new?\s*([a-z0-9][a-z0-9\s_-]{1,40}?)\s+(?:project|app|site|tool|game|dashboard|website|page|cli|api|service|bot|assistant|tracker|manager|generator|editor)\b/i,
        /\b([a-z0-9][a-z0-9\s_-]{1,28}?)\s+(?:project|app|site|tool|game|dashboard|website|page|cli|api|service|bot|assistant|tracker|manager|generator|editor)\b/i,
      ];
      let candidate = '';
      for (const pattern of patterns) {
        const match = cleanedSource.match(pattern);
        if (match && match[1]) {
          candidate = match[1];
          break;
        }
      }
      if (!candidate) {
        const compactMatch = source.match(/\b(?:for|of)?\s*([a-z0-9][a-z0-9\s_-]{1,28}?)\s+(?:project|app|site|tool|game|dashboard|website|page|cli|api|service|bot|assistant|tracker|manager|generator|editor)\b/i);
        if (compactMatch && compactMatch[1]) candidate = compactMatch[1];
      }
      if (candidate && /\b(surprise|reveal|secret|easter egg)\b/i.test(source) && !/\b(surprise|reveal|secret|easter egg)\b/i.test(candidate)) {
        candidate = `${candidate} surprise`;
      }
      const clean = candidate
        .replace(/^(create|build|make|start|set up|setup|generate|draft|design)\s+/gi, ' ')
        .replace(/\b(that|which|with|for|using|in|on|to|from|runs|run|running)\b[\s\S]*$/gi, ' ')
        .replace(/\b(good|great|python|javascript|typescript|react|vue|node|offline|local|simple|desktop|browser|web|style|styled|small|business|businesses|for)\b/gi, ' ')
        .replace(/[^a-z0-9\s_-]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // This regex extractor is only a last-resort fallback; the project name should
      // come from the model's plan (project_name). Keep just a mechanical guard: a
      // 1-character scrap is not a name, so let the caller fall back to the model name.
      if (!clean || clean.trim().length < 2) return '';
      return sanitizeProjectSlug(clean, projectKind);
    }

    function isAgentTaskGameLike(taskText) {
      return /\bgame\b/.test(String(taskText || '').toLowerCase());
    }

    function isAgentTaskSoftwareProject(taskText) {
      const lower = String(taskText || '').toLowerCase();
      return /\b(create|new|start|set up|setup|build|make)\b[\s\S]*\b(project|app|site|tool|game|dashboard|website|page|cli|api|service|bot|assistant|tracker|manager|generator|editor)\b/.test(lower);
    }

    function isAgentTaskPythonRelated(taskText) {
      const lower = String(taskText || '').toLowerCase();
      return /\bpython\b/.test(lower)
        || /\.py\b/.test(lower)
        || /pygame/.test(lower)
        || /snake_game/.test(lower);
    }

    function hasReadmeRunInstructions(content) {
      const text = String(content || '').toLowerCase();
      return /(run|usage|start|launch|open)/.test(text)
        && /(python|pygame|\.py|app\.py|src\/|npm|node|open.*html|browser)/.test(text);
    }

    function isLikelyCompleteReadme(content) {
      const text = String(content || '').trim();
      const lower = text.toLowerCase();
      if (text.length < 100) return false;
      if (looksLikePlaceholderImplementation(text)) return false;
      if (/github\.com\/yourusername|git clone https?:\/\/github\.com\/yourusername/i.test(lower)) return false;
      if (!/(^#\s+|^##\s+)/m.test(text)) return false;
      return hasReadmeRunInstructions(text);
    }

    function isAgentBudgetTrackerTask(taskText) {
      return /\b(budget|expense|finance|tracker)\b/.test(String(taskText || '').toLowerCase());
    }

    function isAgentGeneratedContentTarget(path, taskText) {
      const normalized = normalizeWorkspacePath(path || '');
      const lowerTask = String(taskText || '').toLowerCase();
      if (!normalized || normalized === '/') return false;
      if (normalized === '/README.md') return true;
      if (/\.(py|js|ts|tsx|jsx|html|css|json)$/i.test(normalized)) return true;
      if (normalized.startsWith('/src/')) return true;
      if (isAgentTaskSoftwareProject(lowerTask) && /\.(md|txt|toml|ini|env)$/i.test(normalized)) return true;
      return false;
    }

    function buildAgentFileGenerationHints(taskText, path, options) {
      const normalized = normalizeWorkspacePath(path || '');
      const hints = [];
      const lower = String(taskText || '').toLowerCase();
      const selfContained = !!(options && options.selfContained);
      const frameworkWeb = !!(options && options.frameworkWeb);
      const localOffline = options && typeof options.localOffline === 'boolean'
        ? Boolean(options.localOffline)
        : Boolean(isLocalInferenceProvider());
      if (normalized === '/README.md') {
        hints.push('Describe what the project does.');
        hints.push('Include setup and run instructions.');
        hints.push('Mention the main file and any dependencies.');
        hints.push('Do not invent repository URLs, git clone commands, or placeholder usernames if the project is local-only.');
        hints.push('Reference the actual source file names and commands from RECENT_TOOL_RESULTS. Do not invent a different main file name.');
      }
      if (isAgentTaskSoftwareProject(lower)) {
        hints.push('Build the complete, working feature the request describes. Match the quality and depth you would produce answering this in a normal chat — do not ship a reduced stub or "first pass".');
        hints.push('Prefer self-contained code with as few external runtime requirements as possible unless the user explicitly requested a stack.');
        hints.push('Keep embedded sample/mock/demo data SMALL: a handful of SHORT plain-text examples, not long multi-paragraph essays. Do NOT put markdown code fences (```), backticks, or nested template literals inside canned string data — they break JS string/template parsing and bloat the file. Build the real feature logic; mock content is just placeholder.');
      }
      if (/\b(pdf|printable|brochure|whitepaper|white paper|flyer|invoice|resume|cv|certificate|one[- ]?pager)\b/.test(lower)) {
        hints.push('DOCUMENT/PDF request: a real PDF is binary and CANNOT be authored as text — do NOT output LaTeX or a .pdf file. Produce a single SELF-CONTAINED, print-ready HTML document. Put all CSS in one inline <style> block, use clean document styling (readable body text, generous margins, page-friendly headings, @page margins), and add a fixed "Save as PDF" button at the top that calls window.print(). Hide that button in the print output with @media print { .no-print { display: none } }. The user opens the file and clicks Save as PDF (or Ctrl+P) to get a perfect PDF.');
      }
      if (/\b(spreadsheet|excel|xlsx?|\.ods|google sheets?)\b/.test(lower) || /\.csv$/i.test(normalized)) {
        hints.push('SPREADSHEET request: a real .xlsx is binary and CANNOT be authored as text — produce a .csv instead (it opens directly in Excel/Google Sheets). Output valid CSV: a header row then data rows, comma-separated, quote any field containing a comma/quote/newline. No markdown, no explanation — just the CSV.');
      }
      if (/offline/.test(lower)) {
        hints.push('Use local storage or local files for persistence instead of any network service.');
      }
      hints.push('Problem-solving (apply with judgment when something is wrong): read the actual error — its message + file:line is the real failure point; fix THAT, not a guess. Trace to the ROOT cause (where the bad value originates), not the symptom. When two things must agree (markup↔styles↔script, code↔its data, a function↔its caller), make them follow ONE shared contract and fix it consistently on a single side — do not ping-pong edits between files. Make the smallest change that fixes the cause; prefer a guard/normalize at the source over patching every consumer; then verify and stop.');
      if (/\.html?$/i.test(normalized)) {
        if (selfContained) {
          hints.push('Produce ONE self-contained index.html: put ALL CSS in a single inline <style> in <head>, and ALL JavaScript in a single classic <script> at the end of <body>. A self-contained file always works when double-clicked (file://) — it is the most reliable way to ship a runnable app.');
          hints.push('Do NOT use <script type="module">, import, or export anywhere — ES modules do not load from file:// and silently break the whole page. Keep the script as one plain classic <script>.');
          hints.push('Never load local data with fetch() or XMLHttpRequest — under file:// the browser blocks them and the app silently fails. Embed any data (levels, config, JSON, CSV rows, save state) directly as a JavaScript const/object in the script.');
          hints.push('Keep markup semantic and compact. Use reusable classes and stable IDs that the CSS and JS share. IDs must be unique — never leave two copies of a section.');
          hints.push('Guideline: for UI control icons, prefer clean inline SVG over emoji (emoji render inconsistently and look less polished). Not a hard rule — any consistent icon approach is fine.');
        } else if (frameworkWeb) {
          hints.push('Return only HTML markup for this file.');
          hints.push('For framework web apps, keep index.html as the app shell: include a root mount element and the framework entry script (for example <script type="module" src="/src/main.tsx"></script> for Vite/React).');
          hints.push('Do not inline the full app UI, CSS, or JavaScript into index.html; component/view code belongs in the planned source files.');
        } else {
          hints.push('Return only HTML markup for this file.');
          hints.push('Do not output CSS rules as the main body of this file.');
          hints.push('Do not output JavaScript as the main body of this file.');
          hints.push('SHARED STYLES: this is a multi-file project with a shared stylesheet (e.g. css/style.css — see PROJECT_STATE for the real paths). EVERY page MUST `<link rel="stylesheet" href="...">` that shared stylesheet in <head> and rely on it for the design system (tokens, layout, header/footer, components). Do NOT paste a big inline <style> block re-declaring the whole design system in each page — that duplicates CSS, bloats every page, and makes pages drift out of sync. Only a TINY inline <style> for genuinely page-unique tweaks is acceptable; shared/repeated styling belongs in the shared stylesheet. Use the SAME header/footer/nav markup and the same class names across all pages so the shared CSS styles them identically.');
          hints.push('SHARED COMPONENTS: for multi-page sites, repeated header/nav/logo/footer/CTA markup should come from one classic shared script such as js/components.js. Pages should contain small hooks like <div data-site-header></div> / <div data-site-footer></div>, load the shared component script, and pass the active page via body data-page or location. Do NOT rebuild a different nav/footer/theme inline on each page.');
          if (localOffline) {
            hints.push('Pages are opened directly from disk (file://). Inter-page and asset links must be RELATIVE (menu.html, ./style.css, ../style.css from a subfolder) — root-relative paths like /menu.html resolve to the filesystem root and break.');
            hints.push('OFFLINE: load JS as classic scripts — <script src="js/app.js"></script> in dependency order. Do NOT use <script type="module"> or import/export anywhere; ES modules do not load from file:// and silently break the whole page. Share code via globals on window.');
            hints.push('Never load local data with fetch() or XMLHttpRequest — under file:// the browser blocks them and the app silently fails. Embed any data (levels, config, JSON, CSV rows, save state) directly in the script instead.');
          } else {
            hints.push('Use the script/style loading pattern implied by the planned files. Framework entries may use type="module"; static multi-page sites should use ordinary linked CSS/JS.');
          }
          hints.push('Keep markup semantic and compact. Use reusable classes and stable IDs that CSS and JS can share. IDs must be unique — never leave two copies of a section.');
          hints.push('If a change replaces an existing structure (e.g. moving inline sections into separate pages), remove the superseded markup and links in the same pass — never leave two competing implementations.');
          hints.push('Guideline: for UI control icons, prefer clean inline SVG over emoji (emoji render inconsistently and look less polished). Not a hard rule — any consistent icon approach is fine.');
        }
      }
      if (/\.css$/i.test(normalized)) {
        hints.push('Return only CSS for this file.');
        hints.push('Do not output HTML, <html>, <head>, <body>, <script>, or full document markup.');
        hints.push('Define a style rule for EVERY class and id the HTML and JS reference — see PROJECT_STATE "HTML classes", "HTML ids", "JS class mutations", and "JS queried classes". Include dynamic state classes such as toast/modal/open/visible/active/hiding/hidden so no referenced selector is left unstyled (the validator flags any toggled class with no matching CSS rule).');
        hints.push('Keep CSS complete and bounded: prefer a polished concise stylesheet over excessive effects, and ensure every opened block, string, and comment is closed.');
        hints.push('For multi-section landing pages, style the requested sections with reusable selectors instead of generating oversized repeated CSS.');
        hints.push('Use a small animation system: a few reusable keyframes and transitions, not unique animations for every block.');
        hints.push('Styling guidelines (apply with judgment, skip what does not fit the request): target selectors that actually exist in the HTML; size elements to their content so text is never clipped or overlapping; keep layouts responsive (flex/grid with gaps, allow wrapping); use consistent spacing, hierarchy, and contrast. e.g. a button with a text label should grow to fit the label, not sit in a fixed icon-sized box.');
        hints.push('For alignment repairs, define one shared layout reference (CSS variables or one parent grid/flex model) and derive related positions from it. Do not repeatedly tune unrelated left/top/padding offsets; line, marker, card, and label positions should share the same geometry.');
        hints.push('Layout rules act on DIRECT children: to place blocks side by side (or change their stacking), the flex/grid rule must be on their actual direct parent in the HTML — check the real nesting before choosing the selector.');
      }
      if (/\.(js|ts|jsx|tsx)$/i.test(normalized)) {
        hints.push('Return only JavaScript or TypeScript source for this file.');
        hints.push('Do not output HTML, <script> tags, or CSS rules.');
        if (frameworkWeb || !localOffline) {
          hints.push('Framework/source files may use normal ES module import/export, JSX/TSX, and component composition when the planned stack calls for it.');
          hints.push('Keep mock data local to source files or localStorage unless the user explicitly requested external APIs.');
        } else {
          hints.push('OFFLINE: the page opens directly from disk (file://), where ES modules do NOT load. Do NOT use import/export or <script type="module">. Use plain classic scripts loaded via <script src="..."> in dependency order, and share code by exposing it on window (e.g. window.AppStore = ...). import/export will silently break the whole app offline.');
          hints.push('Never fetch() or XMLHttpRequest local project files (JSON/CSV/text) — under file:// the browser blocks these requests and they silently fail. Embed the data as a JavaScript const/object in the source instead.');
        }
        hints.push('Keep script focused on core behavior and DOM interactions. Avoid large decorative systems unless required.');
        hints.push('Keep one source of truth per setting: a script default must match the corresponding HTML control\'s min/max/value and the unit the code applies (0–1 vs 0–100, px vs unitless), and must not conflict with a CSS variable default. Drive effects through ONE mechanism (either CSS variables or inline styles), and give interactive effects visible non-zero defaults so the result shows before any control is touched.');
      }
      if (/\.py$/i.test(normalized)) {
        hints.push('Prefer the Python standard library; only use a third-party package (pygame, numpy, requests, flask, etc.) when the task genuinely needs one.');
        hints.push('Do NOT install packages at runtime from inside the code (no subprocess pip install, no os.system("pip ..."), no "try import except install" blocks). That fails on modern Python with "externally-managed-environment" (PEP 668). If the project needs third-party packages, list them in a requirements.txt file (one package per line) — the Run button installs them into a virtual environment automatically.');
        hints.push('For Pygame, write `import pygame` as usual but list `pygame-ce` (NOT `pygame`) in requirements.txt — pygame-ce is the drop-in community edition that works on current Python (3.13/3.14); the original pygame package crashes there with a pygame.font circular-import error.');
      }
      if (/(^|\/)requirements\.txt$/i.test(normalized)) {
        hints.push('List exactly the third-party packages this project imports, one per line. No standard-library modules, no version pins unless the task requires a specific version, no comments or prose. For Pygame use `pygame-ce` (drop-in, works on current Python), not `pygame`.');
      }
      return hints;
    }

    function isLikelyCompletePythonGameSource(content) {
      const text = String(content || '');
      const lower = text.toLowerCase();
      let score = 0;
      if (/import\s+pygame/i.test(text) || /from\s+pygame/i.test(text)) score += 1;
      if (/pygame\.init\s*\(/i.test(text) || /pygame\.display\./i.test(text)) score += 1;
      if (/display\.set_mode\s*\(/i.test(text) || /screen\s*=\s*pygame\.display/i.test(text)) score += 1;
      if (/while\s+(?:not\s+\w+|true)\s*:/i.test(text)) score += 1;
      if (/pygame\.KEYDOWN|event\.key/i.test(text)) score += 1;
      if (/\bfood\b|\bapple\b|\benemy\b|\bscore\b/i.test(lower)) score += 1;
      if (/\bplayer\b|\bsnake\b|\bpaddle\b|\bball\b/i.test(lower)) score += 1;
      if (/pygame\.quit\s*\(|quit\s*\(/i.test(text)) score += 1;
      return text.trim().length >= 900 && score >= 6;
    }

    function parseAgentDecision(outputText) {
      const raw = String(outputText || '').trim();
      if (!raw) return null;
      const scrubDecisionNarration = (value) => {
        let s = String(value || '').trim();
        if (!s) return '';
        s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
        {
          const lines = s.split('\n');
          const durationLine = (value) => /^[·•]?\s*\d+(?:\.\d+)?s\s*$/i.test(String(value || '').trim());
          const providerLine = (value) => {
            const t = String(value || '').trim();
            return /^(?:Qwen|Claude|GPT|Gemini|Grok|DeepSeek|Kimi|GLM|MiniMax|NVIDIA|Mistral|Llama|Venice|Gemma|Aion|Mercury)\b.{0,120}\b\d+(?:\.\d+)?s\b/i.test(t)
              || /^(?:Qwen|Claude|GPT|Gemini|Grok|DeepSeek|Kimi|GLM|MiniMax|NVIDIA|Mistral|Llama|Venice|Gemma|Aion|Mercury)\b.{0,120}(?:Turbo|Coder|Pro|Flash|Preview|Opus|Sonnet|Fable|Instruct|Uncensored|Reasoning|VL|A3B|FP8|Nano|Ultra|Mini|Max|V\d|[0-9]{1,4}B)\s*$/i.test(t);
          };
          s = lines.filter((line, index) => {
            const t = line.trim();
            if (!t) return true;
            if (durationLine(t) && (providerLine(lines[index - 1]) || providerLine(lines[index + 1]))) return false;
            if (providerLine(t) && (/\b\d+(?:\.\d+)?s\b/i.test(t) || durationLine(lines[index - 1]) || durationLine(lines[index + 1]))) return false;
            return true;
          }).join('\n').trim();
        }
        const cut = s.search(/<\s*(?:tool_call|function=agent_step|parameter\s*=|decision\b)/i);
        if (cut >= 0) s = s.slice(0, cut).trim();
        const jsonCut = s.search(/\{\s*"action"\s*:/i);
        if (jsonCut >= 0) s = s.slice(0, jsonCut).trim();
        if (/<\s*(?:tool_call|function=agent_step|parameter\s*=)|<\/parameter>/i.test(s)) return '';
        if (/^\s*(?:\{|\[|<)/.test(s)) return '';
        if (/Keys:\s+action,\s+message,\s+tool/i.test(s) || /Rules:\s*-\s*One step only/i.test(s) || /Return EXACTLY ONE JSON object/i.test(s)) return '';
        return s;
      };
      const extractJsonObjects = (text) => {
        const src = String(text || '');
        const candidates = [];
        for (const match of src.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
          const block = String(match[1] || '').trim();
          if (block.includes('{') && block.includes('}')) candidates.push(block);
        }
        let inString = false;
        let escaped = false;
        let depth = 0;
        let start = -1;
        for (let i = 0; i < src.length; i += 1) {
          const ch = src[i];
          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (ch === '\\') {
              escaped = true;
            } else if (ch === '"') {
              inString = false;
            }
            continue;
          }
          if (ch === '"') {
            inString = true;
            continue;
          }
          if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
            continue;
          }
          if (ch === '}' && depth > 0) {
            depth -= 1;
            if (depth === 0 && start >= 0) {
              candidates.push(src.slice(start, i + 1));
              start = -1;
            }
          }
        }
        return Array.from(new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean)));
      };
      let thought = '';
      const firstMarker = [
        raw.indexOf('{'),
        raw.search(/<decision\b/i),
        raw.search(/<tool_call\b/i),
        raw.search(/<function=agent_step\b/i),
        raw.search(/<parameter\s*=/i),
      ].filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? -1;
      if (firstMarker > 0) {
        let t = raw.slice(0, firstMarker).replace(/```[a-z]*\s*$/i, '').trim();
        t = t.replace(/^```[a-z]*\s*/i, '').trim();
        t = t.replace(/^<\/?thought>\s*/gi, '').replace(/<\/?thought>$/gi, '').trim();
        thought = scrubDecisionNarration(t);
      }
      let candidate = raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
      const decisionBlockMatch = candidate.match(/<decision>[\s\S]*?<\/decision>/i);
      if (decisionBlockMatch) candidate = decisionBlockMatch[0];
      const extractTagRegex = (tag, text) => {
        const match = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };
      let action = '';
      let tool = '';
      let path = '';
      let message = '';
      let srcPath = '';
      let dstPath = '';
      let content = '';
      let offset = 0;
      let startLine = 0;
      let endLine = 0;
      let scope = '';
      let command = '';
      let readPathsList = [];

      if (typeof DOMParser !== 'undefined' && /<decision>/i.test(candidate)) {
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(candidate, 'text/html');
          const decisionNode = doc.querySelector('decision');
          if (decisionNode) {
            const textOf = (tag) => {
              const node = decisionNode.querySelector(tag);
              return node && typeof node.textContent === 'string' ? node.textContent.trim() : '';
            };
            action = textOf('action');
            tool = textOf('tool');
            path = textOf('path');
            message = textOf('message');
            srcPath = textOf('src_path') || textOf('srcPath');
            dstPath = textOf('dst_path') || textOf('dstPath');
            const rawContentMatch = candidate.match(/<content>([\s\S]*?)<\/content>/i);
            if (rawContentMatch) {
              content = rawContentMatch[1];
            } else {
              const contentNode = decisionNode.querySelector('content');
              content = contentNode && typeof contentNode.textContent === 'string' ? contentNode.textContent : '';
            }
          }
        } catch (_) { }
      }

      if (!action && /<decision>/i.test(candidate)) {
        action = extractTagRegex('action', candidate);
        tool = extractTagRegex('tool', candidate);
        path = extractTagRegex('path', candidate);
        message = extractTagRegex('message', candidate);
        srcPath = extractTagRegex('src_path', candidate) || extractTagRegex('srcPath', candidate);
        dstPath = extractTagRegex('dst_path', candidate) || extractTagRegex('dstPath', candidate);
        const contentMatch = candidate.match(/<content>([\s\S]*?)<\/content>/i);
        content = contentMatch ? contentMatch[1] : '';
      }

      // qwen / Hermes tool-call format: <tool_call><function=agent_step>
      // <parameter=NAME>VALUE</parameter>... Parse it directly so qwen's primary
      // output doesn't fail and fall to the (slow) repair inference every step.
      if (!action && /<parameter\s*=/i.test(candidate)) {
        const hermes = (key, keepInner) => {
          const m = candidate.match(new RegExp(`<parameter\\s*=\\s*["']?${key}["']?\\s*>([\\s\\S]*?)</parameter>`, 'i'));
          if (!m) return '';
          return keepInner ? m[1].replace(/^\r?\n/, '').replace(/\s+$/, '') : m[1].trim();
        };
        action = hermes('action');
        tool = hermes('tool');
        path = hermes('path');
        message = hermes('message');
        content = hermes('content', true);
        command = hermes('command');
        srcPath = hermes('src_path') || hermes('srcPath');
        dstPath = hermes('dst_path') || hermes('dstPath');
        const th = hermes('thought'); if (th && !thought) thought = th;
        offset = Number(hermes('offset')) || offset;
        startLine = Number(hermes('start_line')) || startLine;
        endLine = Number(hermes('end_line')) || endLine;
      }

      if (!action && /"action"\s*:\s*"[^"]+"/i.test(candidate)) {
        let parsed = null;
        const jsonCandidates = [candidate, ...extractJsonObjects(candidate), ...extractJsonObjects(raw)];
        for (const jsonCandidate of jsonCandidates) {
          if (parsed) break;
          try {
            parsed = JSON.parse(jsonCandidate);
          } catch (_) {
            const start = jsonCandidate.indexOf('{');
            const end = jsonCandidate.lastIndexOf('}');
            if (start >= 0 && end > start) {
              try {
                parsed = JSON.parse(jsonCandidate.slice(start, end + 1));
              } catch (_) {
                parsed = null;
              }
            }
          }
          if (parsed && typeof parsed === 'object' && !String(parsed.action || '').trim()) {
            parsed = null;
          }
        }
        if (!parsed) {
          const start = candidate.indexOf('{');
          const end = candidate.lastIndexOf('}');
          if (start >= 0 && end > start) {
            try {
              parsed = JSON.parse(candidate.slice(start, end + 1));
            } catch (_) {
              parsed = null;
            }
          }
        }
        if (parsed && typeof parsed === 'object') {
          action = String(parsed.action || '');
          tool = String(parsed.tool || '');
          path = String(parsed.path || '');
          message = String(parsed.message || '');
          srcPath = String(parsed.src_path || parsed.srcPath || '');
          dstPath = String(parsed.dst_path || parsed.dstPath || '');
          content = String(parsed.content || '');
          command = String(parsed.command || '');
          if (String(parsed.thought || '').trim()) thought = String(parsed.thought).trim();
          if (parsed.offset != null) offset = Number(parsed.offset) || 0;
          if (parsed.start_line != null) startLine = Number(parsed.start_line) || 0;
          if (parsed.end_line != null) endLine = Number(parsed.end_line) || 0;
          if (parsed.scope != null) scope = String(parsed.scope || '');
          if (Array.isArray(parsed.paths)) readPathsList = parsed.paths.map((p) => String(p || '').trim()).filter(Boolean);
          else if (typeof parsed.paths === 'string' && parsed.paths.trim()) readPathsList = parsed.paths.split(/[|,\n]+/).map((s) => s.trim()).filter(Boolean);
        }
      }

      if (!action) {
        const jsonish = raw.includes('{') ? raw.slice(raw.indexOf('{')) : raw;
        const readStringValue = (key) => {
          const re = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`, 'i');
          const match = jsonish.match(re);
          if (!match || !match[1]) return '';
          try {
            return JSON.parse(`"${match[1]}"`);
          } catch (_) {
            return String(match[1] || '');
          }
        };
        action = readStringValue('action');
        tool = readStringValue('tool');
        path = readStringValue('path');
        message = readStringValue('message');
        srcPath = readStringValue('src_path') || readStringValue('srcPath');
        dstPath = readStringValue('dst_path') || readStringValue('dstPath');
        if (!String(content || '').trim()) content = readStringValue('content');
        if (!String(command || '').trim()) command = readStringValue('command');
        const readNumberValue = (key) => {
          const m = jsonish.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'i'));
          return m ? (Number(m[1]) || 0) : 0;
        };
        if (!offset) offset = readNumberValue('offset');
        if (!startLine) startLine = readNumberValue('start_line');
        if (!endLine) endLine = readNumberValue('end_line');
      }

      if (!action && !tool && !path && !message && !srcPath && !dstPath && !content) {
        return null;
      }
      const normalizedAction = String(action || '').trim().toLowerCase();
      const validTools = ['none', 'new_project', 'generate_project', 'list_dir', 'search_files', 'read_file', 'read_files', 'write_file', 'edit_file', 'validate_files', 'check_code', 'run_app', 'run_command', 'mkdir', 'move', 'delete'];
      let resolvedAction = normalizedAction;
      let resolvedTool = String(tool || '').toLowerCase();
      // Auto-repair: model put tool name in action field (e.g. "action": "read_file")
      if (!['tool', 'final'].includes(resolvedAction) && validTools.includes(resolvedAction)) {
        resolvedTool = resolvedAction;
        resolvedAction = 'tool';
      }
      // Auto-repair: planner emitted a path object with no action and no tool.
      // With substantial content attached — e.g. {"path":"/index.html","content":
      // "<!DOCTYPE html>..."} — the intent is unambiguously a write; inferring
      // read_file here turned recovery rewrites into blocked re-reads. A bare
      // path / line-range object is unambiguously a read; infer read_file instead
      // of hard-failing the whole run (null surfaces as agent_parse_error and
      // STOPS the agent). The write/read guards still police either inference.
      if (!['tool', 'final'].includes(resolvedAction) && !resolvedTool && String(path || '').trim()) {
        const trimmedContent = String(content || '').trim();
        resolvedAction = 'tool';
        resolvedTool = /^\{\s*"edits"\s*:/.test(trimmedContent)
          ? 'edit_file'
          : (trimmedContent.length >= 80 ? 'write_file' : 'read_file');
      }
      if (!['tool', 'final'].includes(resolvedAction)) {
        return null;
      }
      if (resolvedAction === 'tool' && !validTools.includes(resolvedTool)) {
        return null;
      }
      return {
        action: resolvedAction,
        message: scrubDecisionNarration(message),
        tool: validTools.includes(resolvedTool) ? resolvedTool : 'none',
        path: String(path || '').trim(),
        content: String(content || ''),
        command: String(command || '').trim(),
        srcPath: String(srcPath || '').trim(),
        dstPath: String(dstPath || '').trim(),
        thought: scrubDecisionNarration(thought),
        offset: Math.max(0, Number(offset) || 0),
        start_line: Math.max(0, Number(startLine) || 0),
        end_line: Math.max(0, Number(endLine) || 0),
        scope: String(scope || '').trim(),
        paths: Array.isArray(readPathsList) ? readPathsList : [],
        raw,
      };
    }

    function deriveFallbackAgentDecision(taskText, toolEvents, planSpec = null) {
      const taskKind = String(planSpec && planSpec.taskKind ? planSpec.taskKind : '').toLowerCase();
      const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
      if (taskKind === 'project') {
        // Phased = fully model-driven: only new_project below is deterministic.
        const phasedProject = Array.isArray(planSpec && planSpec.phases)
          && planSpec.phases.filter((p) => p && p.title).length >= 2;
        const explicitSeparateWorkspaceIntent = /\b(new project|new workspace|fresh workspace|another project|separate project|different project|start from scratch|from scratch)\b/i.test(String(taskText || ''));
        const hasWorkspace = hasOpenWorkspaceContext();
        const projectCreated = Array.isArray(toolEvents)
          && toolEvents.some((event) => event && event.ok && String(event.tool || '').toLowerCase() === 'new_project');
        if ((!hasWorkspace || explicitSeparateWorkspaceIntent) && !projectCreated) {
          return {
            action: 'tool',
            tool: 'new_project',
            message: `Create the ${String(planSpec && planSpec.projectName ? planSpec.projectName : deriveProjectNameFromTask(taskText) || 'project')} workspace`,
            path: `/${String(planSpec && planSpec.projectName ? planSpec.projectName : deriveProjectNameFromTask(taskText) || 'project')}`,
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-project-new-project]',
          };
        }
        if (phasedProject) return null; // model drives writes/validate/run
        const writtenPaths = Array.isArray(toolEvents)
          ? toolEvents
            .filter((event) => event && event.ok && ['write_file', 'edit_file', 'mkdir'].includes(String(event.tool || '').toLowerCase()))
            .map((event) => normalizeWorkspacePath(event.path || ''))
            .filter(Boolean)
          : [];
        const latestValidationIndex = Array.isArray(toolEvents)
          ? (() => {
            for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
              if (String(toolEvents[i] && toolEvents[i].tool || '').toLowerCase() === 'validate_files') return i;
            }
            return -1;
          })()
          : -1;
        const latestValidation = latestValidationIndex >= 0 ? toolEvents[latestValidationIndex] : null;
        if (latestValidation && latestValidation.validationPassed === false && Array.isArray(latestValidation.validationIssues) && latestValidation.validationIssues.length > 0) {
          const firstIssue = String(latestValidation.validationIssues[0] || '');
          const targetMatch = firstIssue.match(/^(\/[^[\]:\s]+)/);
          const roles = getPlannedFileRoles(expectedFiles);
          let targetPath = normalizeWorkspacePath(targetMatch && targetMatch[1] ? targetMatch[1] : (roles.htmlFile || expectedFiles[0] || '/'));
          const toggledMissingClassMatch = firstIssue.match(/^(\/[^\s:]+):\s+toggles\s+\.([a-z0-9_-]+),/i);
          const issueSourcePath = normalizeWorkspacePath(toggledMissingClassMatch && toggledMissingClassMatch[1] ? toggledMissingClassMatch[1] : '');
          const sourceIsScriptFile = issueSourcePath && /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(issueSourcePath);
          if (toggledMissingClassMatch && sourceIsScriptFile && roles.cssFile) {
            targetPath = roles.cssFile;
          }
          const readAfterValidation = toolEvents.slice(latestValidationIndex + 1).some((event) => (
            event
            && event.ok
            && String(event.tool || '').toLowerCase() === 'read_file'
            && normalizeWorkspacePath(event.path || '') === targetPath
          ));
          const readFailedAfterValidation = toolEvents.slice(latestValidationIndex + 1).some((event) => (
            event
            && !event.ok
            && String(event.tool || '').toLowerCase() === 'read_file'
            && normalizeWorkspacePath(event.path || '') === targetPath
          ));
          const mutationAfterValidation = toolEvents.slice(latestValidationIndex + 1).some((event) => (
            event
            && event.ok
            && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
          ));
          if (!mutationAfterValidation) {
            // Repair attempts that keep failing or getting guard-blocked must not
            // be re-proposed forever — hand the step back to the model instead.
            const failedRepairAttempts = toolEvents.slice(latestValidationIndex + 1).filter((event) => (
              event
              && !event.ok
              && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
              && normalizeWorkspacePath(event.path || '') === targetPath
            )).length;
            if (failedRepairAttempts >= 2) return null;
            // If edit_file already failed for this path, read again and give the next step more grounded context.
            const editAlreadyFailed = readAfterValidation && toolEvents.slice(latestValidationIndex + 1).some((event) => (
              event
              && !event.ok
              && String(event.tool || '').toLowerCase() === 'edit_file'
              && normalizeWorkspacePath(event.path || '') === targetPath
            ));
            const repairTool = (readAfterValidation || readFailedAfterValidation)
              ? (editAlreadyFailed ? 'write_file' : 'edit_file')
              : 'read_file';
            return {
              action: 'tool',
              tool: repairTool,
              message: repairTool === 'read_file'
                ? `Read ${targetPath} before repairing the validation issues.`
                : repairTool === 'write_file'
                ? `Rewrite ${targetPath} to repair the validation issues.`
                : `Repair ${targetPath} using the validation issues and project contract.`,
              path: targetPath,
              content: repairTool !== 'read_file'
                ? `Fix the real validation issues without adding placeholder CSS stubs:\n${latestValidation.validationIssues.join('\n')}`
                : '',
              srcPath: '',
              dstPath: '',
              raw: `[fallback-project-${repairTool}-after-validation]`,
            };
          }
        }
        // Generate in dependency order so files cohere on the first pass instead of
        // needing a repair: markup first (defines structure + IDs), then scripts
        // (which query those IDs and introduce dynamic state classes like
        // .toast-visible / .modal-open), then stylesheets LAST — so the CSS can see
        // and style every class/ID the HTML and JS actually use, rather than being
        // written blind before the JS exists. README always last so it references
        // real, finished files.
        // Single-pass project generation (generate_project) is kept but OFF by default
        // so we generate per-file again (visible progress + investigate the per-file path).
        // Flip ENABLE_SINGLE_PASS_PROJECT_GEN to true to use the one-call path.
        const ENABLE_SINGLE_PASS_PROJECT_GEN = false;
        // Phased: let the model write the current phase's files itself (return null
        // → decision prompt). Skip straight to the all-written validate/run check.
        if (!phasedProject) {
        const codeFilesToCreate = expectedFiles
          .map((path) => normalizeWorkspacePath(path || ''))
          .filter((path) => path && path !== '/src' && path !== '/README.md' && !writtenPaths.includes(path));
        const onePassAlreadyTried = Array.isArray(toolEvents)
          && toolEvents.some((e) => e && String(e.tool || '').toLowerCase() === 'generate_project');
        if (ENABLE_SINGLE_PASS_PROJECT_GEN && codeFilesToCreate.length >= 2 && writtenPaths.length === 0 && !onePassAlreadyTried) {
          return {
            action: 'tool',
            tool: 'generate_project',
            message: 'Generate all project files in one pass',
            path: '/',
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-project-generate-onepass]',
          };
        }
        // Keep the plan's order; only push README last (stable sort).
        const nextPath = expectedFiles
          .map((path) => normalizeWorkspacePath(path || ''))
          .filter((path) => path && path !== '/src' && !writtenPaths.includes(path))
          .sort((a, b) => (a === '/README.md' ? 1 : 0) - (b === '/README.md' ? 1 : 0))[0] || '';
        if (nextPath) {
          const lastAttemptForPath = Array.isArray(toolEvents)
            ? [...toolEvents].reverse().find((event) => (
              event
              && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
              && normalizeWorkspacePath(event.path || '') === normalizeWorkspacePath(nextPath)
            ))
            : null;
          if (lastAttemptForPath && !lastAttemptForPath.ok) return null;
          return {
            action: 'tool',
            tool: 'write_file',
            message: `Create ${nextPath}`,
            path: nextPath,
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-project-write-file]',
          };
        }
        const nonReadmeExpectedFiles = expectedFiles
          .map((path) => normalizeWorkspacePath(path || ''))
          .filter((path) => path && path !== '/README.md' && path !== '/src');
        const allExpectedFilesWritten = nonReadmeExpectedFiles.length > 0
          && nonReadmeExpectedFiles.every((path) => writtenPaths.includes(path));
        if (allExpectedFilesWritten) {
          let latestWriteIndex = -1;
          let projectLatestValidationIndex = -1;
          let projectLatestValidation = null;
          for (let i = 0; Array.isArray(toolEvents) && i < toolEvents.length; i += 1) {
            const event = toolEvents[i];
            const tool = String(event && event.tool || '').toLowerCase();
            if (event && event.ok && ['write_file', 'edit_file'].includes(tool)) {
              const path = normalizeWorkspacePath(event.path || '');
              if (nonReadmeExpectedFiles.includes(path)) latestWriteIndex = i;
            }
            if (event && tool === 'validate_files') {
              projectLatestValidationIndex = i;
              projectLatestValidation = event;
            }
          }
          if (!projectLatestValidation || projectLatestValidationIndex < latestWriteIndex) {
            return {
              action: 'tool',
              tool: 'validate_files',
              message: 'Validate the written project files',
              path: '/',
              content: '',
              srcPath: '',
              dstPath: '',
              raw: '[fallback-project-validate-files]',
            };
          }
          // One-time runtime smoke run after validation: static validation can't see
          // a crash-on-load. A failure hands back to the model for repair.
          const projectIsRunnable = nonReadmeExpectedFiles.some((p) => /\.(html?|js|mjs|cjs)$/i.test(p));
          if (projectIsRunnable && projectLatestValidation.validationPassed !== false) {
            const ranAppSinceWrite = toolEvents.some((event, i) => (
              event && String(event.tool || '').toLowerCase() === 'run_app' && i > latestWriteIndex
            ));
            if (!ranAppSinceWrite) {
              return {
                action: 'tool',
                tool: 'run_app',
                message: 'Run the app to catch load and runtime errors before finishing.',
                path: '/',
                content: '',
                srcPath: '',
                dstPath: '',
                raw: '[fallback-project-run-app]',
              };
            }
          }
        }
        } // end !phasedProject (phased = model drives writes + validate/run per phase)
      }
      if (taskKind === 'analysis') return null;
      const inferredEditTask = taskKind === 'edit' || !/\b(create|build|make|start|setup|set up)\b/i.test(String(taskText || ''));
      if (!inferredEditTask || !Array.isArray(toolEvents)) return null;
      const plannedInspectFiles = Array.isArray(planSpec && planSpec.filesToInspect)
        ? planSpec.filesToInspect.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean)
        : [];
      const plannedAffectedFiles = Array.isArray(planSpec && planSpec.affectedFiles)
        ? planSpec.affectedFiles.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean)
        : [];
      const plannedEditFiles = Array.from(new Set([...plannedInspectFiles, ...plannedAffectedFiles]));
      const successfulPlannedReads = new Set(toolEvents
        .filter((event) => event && event.ok && String(event.tool || '').toLowerCase() === 'read_file')
        .map((event) => normalizeWorkspacePath(event.path || ''))
        .filter(Boolean));
      const successfulPlannedWrites = new Set(toolEvents
        .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
        .map((event) => normalizeWorkspacePath(event.path || ''))
        .filter(Boolean));
      const failedPlannedReads = new Set(toolEvents
        .filter((event) => event && !event.ok && String(event.tool || '').toLowerCase() === 'read_file')
        .map((event) => normalizeWorkspacePath(event.path || ''))
        .filter(Boolean));
      const unreadPlannedFile = plannedEditFiles.find((path) => !successfulPlannedReads.has(path) && !failedPlannedReads.has(path));
      if (unreadPlannedFile) {
        return {
          action: 'tool',
          tool: 'read_file',
          message: `Read ${unreadPlannedFile}; it is part of the planned edit scope.`,
          path: unreadPlannedFile,
          content: '',
          srcPath: '',
          dstPath: '',
          raw: '[fallback-read-planned-edit-file]',
        };
      }
      const untouchedAffectedFile = plannedAffectedFiles.find((path) => !successfulPlannedWrites.has(path));
      if (untouchedAffectedFile && successfulPlannedReads.has(untouchedAffectedFile)) {
        return {
          action: 'tool',
          tool: 'edit_file',
          message: `Update ${untouchedAffectedFile} to satisfy the planned edit scope.`,
          path: untouchedAffectedFile,
          content: '',
          srcPath: '',
          dstPath: '',
          raw: '[fallback-edit-planned-affected-file]',
        };
      }
      const validationSteps = Array.isArray(planSpec && planSpec.validationSteps)
        ? planSpec.validationSteps.map((step) => String(step || '').toLowerCase()).filter(Boolean)
        : [];
      const validateRequested = validationSteps.some((step) => /validate_files|static|syntax|check|test|verify/.test(step));
      const affectedFilesUpdated = plannedAffectedFiles.length > 0
        && plannedAffectedFiles.every((path) => successfulPlannedWrites.has(path));
      if (validateRequested && affectedFilesUpdated) {
        let latestPlannedWriteIndex = -1;
        let latestValidationIndex = -1;
        for (let i = 0; i < toolEvents.length; i += 1) {
          const event = toolEvents[i];
          const tool = String(event && event.tool || '').toLowerCase();
          const path = normalizeWorkspacePath(event && event.path ? event.path : '');
          if (event && event.ok && ['write_file', 'edit_file'].includes(tool) && plannedAffectedFiles.includes(path)) {
            latestPlannedWriteIndex = i;
          }
          if (event && tool === 'validate_files') {
            latestValidationIndex = i;
          }
        }
        if (latestPlannedWriteIndex >= 0 && latestValidationIndex < latestPlannedWriteIndex) {
          return {
            action: 'tool',
            tool: 'validate_files',
            message: 'Validate the updated files before finalizing.',
            path: '/',
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-validate-planned-edit]',
          };
        }
      }
      if (!toolEvents.length) {
        return {
          action: 'tool',
          tool: 'list_dir',
          message: 'Inspect the current workspace files before editing.',
          path: '/',
          content: '',
          srcPath: '',
          dstPath: '',
          raw: '[fallback-list-before-edit]',
        };
      }
      const successfulSearches = toolEvents.filter((event) => event && event.ok && String(event.tool || '').toLowerCase() === 'search_files');
      const successfulReads = new Set(toolEvents
        .filter((event) => event && event.ok && String(event.tool || '').toLowerCase() === 'read_file')
        .map((event) => normalizeWorkspacePath(event.path || ''))
        .filter(Boolean));
      const latestSearch = successfulSearches.length ? successfulSearches[successfulSearches.length - 1] : null;
      if (latestSearch) {
        const resultPaths = [];
        for (const match of String(latestSearch.observation || '').matchAll(/-\s+(\/[^\s:]+):\d+:/g)) {
          const path = normalizeWorkspacePath(match[1] || '');
          if (path && !resultPaths.includes(path)) resultPaths.push(path);
        }
        const taskLower = String(taskText || '').toLowerCase();
        const ranked = resultPaths.slice().sort((left, right) => {
          const score = (path) => {
            let value = 0;
            if (/\b(back to top|scroll|click|button)\b/i.test(taskLower) && /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(path)) value += 4;
            if (/\b(visible|contrast|color|colour|background|overlay|text)\b/i.test(taskLower) && /\.(css|scss|sass|less)$/i.test(path)) value += 4;
            if (/\.html?$/i.test(path)) value += 1;
            return value;
          };
          return score(right) - score(left);
        });
        const unreadResult = ranked.find((path) => !successfulReads.has(path));
        if (unreadResult) {
          return {
            action: 'tool',
            tool: 'read_file',
            message: `Read ${unreadResult}; search_files found relevant matches there.`,
            path: unreadResult,
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-read-search-result]',
          };
        }
      }

      const latestFailedIndex = (() => {
        for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
          const event = toolEvents[i];
          if (event && !event.ok && ['edit_file', 'write_file'].includes(String(event.tool || '').toLowerCase())) return i;
        }
        return -1;
      })();
      const latestFailed = latestFailedIndex >= 0 ? toolEvents[latestFailedIndex] : null;
      const latestFailedPath = normalizeWorkspacePath(latestFailed && latestFailed.path ? latestFailed.path : '');
      const latestFailedObservation = String(latestFailed && latestFailed.observation ? latestFailed.observation : '');
      const failedBinaryOrMissingTarget = latestFailed
        && (
          /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff|mp4|mov|webm|mp3|wav|pdf|zip)$/i.test(latestFailedPath)
          || /binary image assets are not editable|file does not exist|outside the current plan/i.test(latestFailedObservation)
        );
      if (failedBinaryOrMissingTarget) {
        const listedFiles = [];
        toolEvents.forEach((event) => {
          if (!event || !event.ok || String(event.tool || '').toLowerCase() !== 'list_dir') return;
          for (const match of String(event.observation || '').matchAll(/-\s+\[file\]\s+([^\s(]+)/g)) {
            const path = normalizeWorkspacePath(`/${String(match[1] || '').trim()}`);
            if (path && path !== '/') listedFiles.push(path);
          }
        });
        const sourceFiles = Array.from(new Set([...expectedFiles, ...listedFiles]
          .map((path) => normalizeWorkspacePath(path || ''))
          .filter((path) => /\.(html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx|py|java|c|cc|cpp|cxx|h|hpp|cs|go|rs|php|rb)$/i.test(path))));
        const roles = getPlannedFileRoles(sourceFiles);
        const lowerTask = String(taskText || '').toLowerCase();
        const candidates = [];
        const pushCandidate = (path) => {
          const normalized = normalizeWorkspacePath(path || '');
          if (normalized && normalized !== '/' && sourceFiles.includes(normalized) && !candidates.includes(normalized)) candidates.push(normalized);
        };
        if (/\b(click|button|link|back to top|scroll|doesn'?t work|not work|broken|interaction)\b/i.test(lowerTask)) {
          pushCandidate(roles.scriptFile);
          pushCandidate(roles.htmlFile);
          pushCandidate(roles.cssFile);
        }
        if (/\b(visible|visibility|readable|contrast|color|colour|background|overlay|text)\b/i.test(lowerTask)) {
          pushCandidate(roles.cssFile);
          pushCandidate(roles.htmlFile);
        }
        sourceFiles.forEach(pushCandidate);
        const targetPath = candidates.find((path) => !toolEvents.slice(latestFailedIndex + 1).some((event) => (
          event && event.ok && String(event.tool || '').toLowerCase() === 'read_file' && normalizeWorkspacePath(event.path || '') === path
        ))) || candidates[0] || '';
        if (targetPath) {
          const readAfterFailure = toolEvents.slice(latestFailedIndex + 1).some((event) => (
            event && event.ok && String(event.tool || '').toLowerCase() === 'read_file' && normalizeWorkspacePath(event.path || '') === targetPath
          ));
          return {
            action: 'tool',
            tool: readAfterFailure ? 'edit_file' : 'read_file',
            message: readAfterFailure
              ? `Apply the requested change in ${targetPath}.`
              : `Read ${targetPath} as the nearest editable source for the requested change.`,
            path: targetPath,
            content: readAfterFailure
              ? `Fix the user's requested issue by editing this source file. Do not edit ${latestFailedPath || 'the unavailable asset'}.`
              : '',
            srcPath: '',
            dstPath: '',
            raw: readAfterFailure ? '[fallback-edit-source-after-uneditable-target]' : '[fallback-read-source-after-uneditable-target]',
          };
        }
      }

      let latestReadIndex = -1;
      let latestRead = null;
      for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
        const event = toolEvents[i];
        if (!event || !event.ok || String(event.tool || '').toLowerCase() !== 'read_file') continue;
        const path = normalizeWorkspacePath(event.path || '');
        if (!path || path === '/') continue;
        latestReadIndex = i;
        latestRead = { ...event, path };
        break;
      }
      if (!latestRead) return null;

      const listedFilesForFallback = [];
      toolEvents.forEach((event) => {
        if (!event || !event.ok || String(event.tool || '').toLowerCase() !== 'list_dir') return;
        for (const match of String(event.observation || '').matchAll(/-\s+\[file\]\s+([^\s(]+)/g)) {
          const path = normalizeWorkspacePath(`/${String(match[1] || '').trim()}`);
          if (path && path !== '/' && !listedFilesForFallback.includes(path)) listedFilesForFallback.push(path);
        }
      });
      if (listedFilesForFallback.length) {
        const taskLowerForReads = String(taskText || '').toLowerCase();
        const roleCandidates = [];
        const pushRoleCandidate = (path) => {
          const normalized = normalizeWorkspacePath(path || '');
          if (normalized && listedFilesForFallback.includes(normalized) && !successfulReads.has(normalized)) roleCandidates.push(normalized);
        };
        if (/\b(calculator|dark mode|theme|responsive|modern|design|style|layout)\b/i.test(taskLowerForReads)) {
          pushRoleCandidate('/style.css');
          pushRoleCandidate('/script.js');
          pushRoleCandidate('/index.html');
        }
        const nextSourceRead = roleCandidates[0];
        if (nextSourceRead) {
          return {
            action: 'tool',
            tool: 'read_file',
            message: `Read ${nextSourceRead} before editing the coordinated feature.`,
            path: nextSourceRead,
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-read-related-source-before-edit]',
          };
        }
      }

      const alreadyUpdated = toolEvents.slice(latestReadIndex + 1).some((event) => (
        event
        && event.ok
        && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
        && normalizeWorkspacePath(event.path || '') === latestRead.path
      ));
      if (alreadyUpdated) {
        const latestMutationIndex = (() => {
          for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
            const event = toolEvents[i];
            if (event && event.ok && ['write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(event.tool || '').toLowerCase())) return i;
          }
          return -1;
        })();
        const latestValidationIndex = (() => {
          for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
            if (String(toolEvents[i] && toolEvents[i].tool || '').toLowerCase() === 'validate_files') return i;
          }
          return -1;
        })();
        if (latestMutationIndex >= 0 && latestValidationIndex < latestMutationIndex) {
          return {
            action: 'tool',
            tool: 'validate_files',
            message: 'Validate the updated files before finalizing.',
            path: '/',
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[fallback-validate-unscoped-edit]',
          };
        }
        return null;
      }

      const taskLower = String(taskText || '').toLowerCase();
      let message = `Update ${latestRead.path} to satisfy the user's requested changes.`;
      if (/\bcomment|docstring|annotat/.test(taskLower)) {
        message = `Add concise comments to the functions in ${latestRead.path}.`;
      } else if (/\brename\b/.test(taskLower)) {
        message = `Apply the requested renaming changes in ${latestRead.path}.`;
      } else if (/\bfix|bug|error|issue\b/.test(taskLower)) {
        message = `Fix the requested issue in ${latestRead.path}.`;
      }

      return {
        action: 'tool',
        tool: 'edit_file',
        message,
        path: latestRead.path,
        content: '',
        srcPath: '',
        dstPath: '',
        raw: '[fallback-edit-after-read]',
      };
    }

    function parseAgentEditProgram(contentText) {
      const raw = String(contentText || '').replace(/\r/g, '').trim();
      if (!raw) return null;
      let cleaned = raw;
      if (/^```/i.test(cleaned)) {
        cleaned = cleaned.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      let parsed = null;
      // Top-level array form — [{"find":...,"replace":...}, ...] — is a common
      // model variant of the documented {"edits":[...]} shape; accept it.
      const arrayStart = cleaned.indexOf('[');
      const objectStart = cleaned.indexOf('{');
      if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
        const arrayEnd = cleaned.lastIndexOf(']');
        if (arrayEnd > arrayStart) {
          try {
            const arr = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
            if (Array.isArray(arr)) parsed = { edits: arr };
          } catch (_) {
            parsed = null;
          }
        }
      }
      if (!parsed) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
          cleaned = cleaned.slice(start, end + 1).trim();
        }
        try {
          parsed = JSON.parse(cleaned);
        } catch (_) {
          return null;
        }
      }
      const edits = Array.isArray(parsed && parsed.edits) ? parsed.edits : [];
      // Weak models emit the right intent under the wrong key names ("anchor" for
      // "find", "replacement" for "replace", a bare array, etc.). Tolerate the common
      // synonyms instead of rejecting the whole program — reliability lives here.
      const pick = (edit, keys) => {
        for (const k of keys) {
          if (edit && edit[k] != null && String(edit[k]) !== '') return String(edit[k]);
        }
        return '';
      };
      const normalizedEdits = edits.map((edit) => {
        let op = String(edit && edit.op ? edit.op : '').toLowerCase();
        if (op === 'find_replace' || op === 'substitute' || op === 'change' || op === 'edit') op = 'replace';
        if (op === 'insert' || op === 'add') op = 'insert_after';
        const find = pick(edit, ['find', 'anchor', 'search', 'old', 'from', 'target', 'match']);
        const replace = pick(edit, ['replace', 'replacement', 'new', 'to', 'with', 'newText']);
        let text = pick(edit, ['text', 'content', 'value', 'insert', 'add', 'snippet']);
        // Insert-family content that arrived under a replace-family key must not
        // degrade to inserting "" (an applied-but-empty insert silently drops the block).
        if (['insert_before', 'insert_after', 'prepend', 'append'].includes(op) && !text && replace) text = replace;
        // Default the op when the shape is unambiguous.
        if (!op && find && replace) op = 'replace';
        if (!op && !find && !replace && text) op = 'append';
        if (!op && find && !replace && text) op = 'insert_after';
        return { op, find, replace, text };
      }).filter((edit) => ['replace', 'replace_all', 'insert_before', 'insert_after', 'prepend', 'append'].includes(edit.op))
        // An insert with no content is a broken edit, not a no-op success.
        .filter((edit) => !(['insert_before', 'insert_after', 'prepend', 'append'].includes(edit.op) && !edit.text));
      if (!normalizedEdits.length) return null;
      return { edits: normalizedEdits };
    }

    // Collapse interior whitespace runs and trim, so a line compares equal
    // regardless of indentation style (tabs vs spaces) or trailing whitespace.
    function normalizeEditLine(line) {
      return String(line || '').replace(/\s+/g, ' ').trim();
    }

    // Bounded Levenshtein distance between two short (single-line) strings.
    function editLevenshtein(a, b) {
      const m = a.length;
      const n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      let prev = new Array(n + 1);
      for (let j = 0; j <= n; j += 1) prev[j] = j;
      for (let i = 1; i <= m; i += 1) {
        const cur = new Array(n + 1);
        cur[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= n; j += 1) {
          const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
      }
      return prev[n];
    }

    function editLineSimilarity(a, b) {
      if (a === b) return 1;
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) return 1;
      return 1 - editLevenshtein(a, b) / maxLen;
    }

    // Fuzzy-locate an edit's `find` text, tolerating weak-model anchor imperfections
    // (indentation/whitespace/stray char). Returns {start,end,mode} or null.
    function findEditAnchor(source, find) {
      const src = String(source || '');
      const needle = String(find || '');
      if (!needle) return null;

      // Tier 1: exact substring — the dominant, cheapest case (unchanged behavior).
      const exactIdx = src.indexOf(needle);
      if (exactIdx >= 0) return { start: exactIdx, end: exactIdx + needle.length, mode: 'exact' };

      const srcLines = src.split('\n');
      const offsets = new Array(srcLines.length);
      let acc = 0;
      for (let i = 0; i < srcLines.length; i += 1) {
        offsets[i] = acc;
        acc += srcLines[i].length + 1;
      }

      const needleLines = needle.split('\n');
      while (needleLines.length && needleLines[0].trim() === '') needleLines.shift();
      while (needleLines.length && needleLines[needleLines.length - 1].trim() === '') needleLines.pop();
      if (!needleLines.length) return null;
      const needleNorm = needleLines.map(normalizeEditLine);
      const n = needleNorm.length;
      if (n > srcLines.length) return null;

      // Tier 2/3 replace whole lines, so the span runs from the first matched
      // line's start to the last matched line's end (excluding the trailing \n).
      const spanFor = (i) => {
        const last = i + n - 1;
        return { start: offsets[i], end: offsets[last] + srcLines[last].length };
      };

      // Tier 2: whitespace-normalized exact block match.
      let whitespaceMatch = -1;
      for (let i = 0; i + n <= srcLines.length; i += 1) {
        let matched = true;
        for (let j = 0; j < n; j += 1) {
          if (normalizeEditLine(srcLines[i + j]) !== needleNorm[j]) { matched = false; break; }
        }
        if (matched) {
          if (whitespaceMatch >= 0) return null;
          whitespaceMatch = i;
        }
      }
      if (whitespaceMatch >= 0) {
        const span = spanFor(whitespaceMatch);
        return { start: span.start, end: span.end, mode: 'whitespace' };
      }

      // Tier 3: best fuzzy block above a conservative similarity threshold.
      // Per-line Levenshtein keeps each comparison to single-line length; guard
      // against pathological O(lines×needle) cost on very large inputs.
      if ((srcLines.length - n + 1) * n > 200000) return null;
      let bestScore = 0;
      let bestStart = -1;
      let secondScore = 0;
      for (let i = 0; i + n <= srcLines.length; i += 1) {
        let total = 0;
        for (let j = 0; j < n; j += 1) {
          total += editLineSimilarity(normalizeEditLine(srcLines[i + j]), needleNorm[j]);
        }
        const score = total / n;
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          bestStart = i;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      if (bestStart >= 0 && bestScore >= 0.9) {
        if (secondScore >= 0.9 && bestScore - secondScore < 0.04) return null;
        const span = spanFor(bestStart);
        return { start: span.start, end: span.end, mode: 'fuzzy', score: bestScore };
      }
      return null;
    }

    function applyAgentEditProgram(sourceText, program) {
      let output = String(sourceText || '');
      const edits = Array.isArray(program && program.edits) ? program.edits : [];
      let appliedCount = 0;
      let fuzzyCount = 0;
      const anchors = []; // per-applied-edit match mode, for diagnostics
      const noteAnchor = (anchor, op) => {
        appliedCount += 1;
        if (anchor && anchor.mode && anchor.mode !== 'exact') fuzzyCount += 1;
        anchors.push({
          op: String(op || ''),
          mode: anchor && anchor.mode ? String(anchor.mode) : 'direct',
          score: anchor && typeof anchor.score === 'number' ? Math.round(anchor.score * 100) / 100 : null,
        });
      };
      // On a fuzzy match, a keep-and-extend replacement would write the model's
      // (possibly typo'd) anchor text. Re-base the kept part on the real matched text.
      const healReplacement = (anchor, find, replaceText) => {
        const text = String(replaceText || '');
        if (!anchor || anchor.mode === 'exact') return text;
        const matched = output.slice(anchor.start, anchor.end);
        if (matched === find || !find) return text;
        if (text.startsWith(find)) return matched + text.slice(find.length);
        if (text.endsWith(find)) return text.slice(0, text.length - find.length) + matched;
        return text;
      };
      for (const edit of edits) {
        if (!edit || !edit.op) continue;
        if (edit.op === 'prepend') {
          output = String(edit.text || '') + output;
          appliedCount += 1;
          anchors.push({ op: 'prepend', mode: 'direct', score: null });
          continue;
        }
        if (edit.op === 'append') {
          output += String(edit.text || '');
          appliedCount += 1;
          anchors.push({ op: 'append', mode: 'direct', score: null });
          continue;
        }
        const find = String(edit.find || '');
        if (!find) continue;
        if (edit.op === 'replace_all') {
          // Exact replace-all stays exact (a fuzzy global match is unsafe);
          // if the literal is absent, degrade to a single fuzzy replacement.
          if (output.includes(find)) {
            output = output.split(find).join(String(edit.replace || ''));
            appliedCount += 1;
            continue;
          }
          const anchor = findEditAnchor(output, find);
          if (!anchor) continue;
          output = `${output.slice(0, anchor.start)}${healReplacement(anchor, find, edit.replace)}${output.slice(anchor.end)}`;
          noteAnchor(anchor, edit.op);
          continue;
        }
        if (edit.op === 'replace') {
          const anchor = findEditAnchor(output, find);
          if (!anchor) continue;
          output = `${output.slice(0, anchor.start)}${healReplacement(anchor, find, edit.replace)}${output.slice(anchor.end)}`;
          noteAnchor(anchor, edit.op);
          continue;
        }
        if (edit.op === 'insert_before') {
          if (!String(edit.text || '')) continue; // empty insert = broken edit, don't count it applied
          const anchor = findEditAnchor(output, find);
          if (!anchor) continue;
          output = `${output.slice(0, anchor.start)}${String(edit.text || '')}${output.slice(anchor.start)}`;
          noteAnchor(anchor, edit.op);
          continue;
        }
        if (edit.op === 'insert_after') {
          if (!String(edit.text || '')) continue;
          const anchor = findEditAnchor(output, find);
          if (!anchor) continue;
          output = `${output.slice(0, anchor.end)}${String(edit.text || '')}${output.slice(anchor.end)}`;
          noteAnchor(anchor, edit.op);
        }
      }
      return { output, appliedCount, fuzzyCount, anchors };
    }

    // Mechanically mark a doneCriteria item done when a successful edit's target or
    // content matches its distinctive keywords (generic items: any shipped+validated work).
    const AGENT_CHECKLIST_STOPWORDS = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'are', 'should', 'must', 'into',
      'from', 'have', 'has', 'use', 'using', 'make', 'made', 'fix', 'fixed', 'fixing',
      'add', 'added', 'ensure', 'works', 'work', 'working', 'when', 'then', 'all',
      'any', 'its', 'their', 'them', 'they', 'each', 'good', 'great', 'look', 'looks',
      'right', 'correct', 'properly', 'exist', 'exists', 'show', 'shows', 'display',
    ]);

    function agentChecklistKeywords(text) {
      return Array.from(new Set(
        String(text || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !AGENT_CHECKLIST_STOPWORDS.has(w))
      ));
    }

    function computeAgentChecklistProgress(items, toolEvents, planSpec = null) {
      const list = Array.isArray(items) ? items.map((t) => String(t || '').trim()).filter(Boolean) : [];
      const events = Array.isArray(toolEvents) ? toolEvents : [];
      const mutations = events.filter((e) => e && e.ok
        && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase()));
      const anyValidationPassed = events.some((e) => e
        && String(e.tool || '').toLowerCase() === 'validate_files' && e.validationPassed === true);
      const haystacks = mutations.map((e) => `${String(e.path || '')} ${String(e.content || '')} ${String(e.observation || '')}`.toLowerCase());
      // Nothing is "done" until every planned file exists (markup keywords else
      // falsely credit behavior that lives in an unwritten file).
      const norm = (p) => `/${String(p || '').replace(/^\/+/, '')}`;
      const writtenPaths = new Set(mutations.map((e) => norm(e.path)));
      // For an EDIT task only the affected files must change (siblings are read-only context);
      // for a project build every expected file must exist. Using expectedFiles for edits left
      // the plan stuck at 0/N because untouched siblings never get written.
      const taskKind = String(planSpec && planSpec.taskKind || '').toLowerCase();
      const affected = Array.isArray(planSpec && planSpec.affectedFiles) ? planSpec.affectedFiles : [];
      const requiredSource = (taskKind === 'edit' && affected.length)
        ? affected
        : (Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : []);
      const plannedFiles = requiredSource.map(norm).filter((p) => p && p !== '/' && p !== '/README.md');
      const allPlannedWritten = plannedFiles.every((p) => writtenPaths.has(p));
      return list.map((text) => {
        const keywords = agentChecklistKeywords(text);
        let done = false;
        if (!allPlannedWritten) {
          done = false;  // project is incomplete — never report a criterion as met yet
        } else if (keywords.length) {
          done = haystacks.some((h) => keywords.some((k) => h.includes(k)));
        } else if (mutations.length > 0 && anyValidationPassed) {
          // Generic criterion (no distinctive keyword) — credited once work shipped.
          done = true;
        }
        return { text, done };
      });
    }

    function renderAgentChecklist(progress) {
      const rows = Array.isArray(progress) ? progress : [];
      if (!rows.length) return '';
      const doneCount = rows.filter((r) => r && r.done).length;
      const lines = rows.map((r) => `- [${r && r.done ? 'x' : ' '}] ${formatAgentPlanSentence(r && r.text ? r.text : '')}`);
      return `**Plan (${doneCount}/${rows.length})**\n${lines.join('\n')}`;
    }

    function parseAgentExpectedFiles(raw) {
      return String(raw || '')
        .split('|')
        .map((item) => normalizeWorkspacePath(item))
        .filter((item) => item && item !== '/')
        .slice(0, 16);
    }

    function parseAgentPlanPathList(raw) {
      return String(raw || '')
        .split('|')
        .map((item) => normalizeWorkspacePath(item))
        .filter((item) => item && item !== '/')
        .filter((item) => !/\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|mp4|mov|webm|mp3|wav|pdf|zip)$/i.test(item))
        .slice(0, 12);
    }

    function formatAgentPlanSentence(value) {
      const text = String(value || '').trim().replace(/\s+/g, ' ');
      if (!text) return '';
      const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
      return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
    }

    function parseAgentPlanTextList(raw, maxItems = 8) {
      let items = String(raw || '')
        .split('|')
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      // The model sometimes joins DISTINCT criteria with a comma instead of '|'
      // ("...per submission,Create a sample-data.json...") so two requirements collapse
      // into one item ("Plan 1/1"). Recover them only when a single piped item contains
      // a comma immediately before a capital letter (a clause join — in-clause commas
      // have a space after, e.g. "Basic, Pro"), and each piece is substantial.
      if (items.length === 1 && /,(?=[A-Z])/.test(items[0])) {
        const split = items[0].split(/,(?=[A-Z])/).map((s) => s.trim()).filter((s) => s.length >= 8);
        if (split.length >= 2) items = split;
      }
      return items.slice(0, maxItems).map(formatAgentPlanSentence).filter(Boolean);
    }

    // Phases carry sub-tasks: "Title :: task ; task ; task | Title2 :: ...".
    // Also tolerate the model emitting a JSON array of {title, tasks}. Returns
    // [{ title, tasks:[{ text, done:false }] }].
    function parseAgentPlanPhases(raw, maxPhases = 4, maxTasks = 6) {
      const mkTasks = (list) => (Array.isArray(list) ? list : [])
        .map((t) => String(t || '').trim())
        .filter(Boolean)
        .slice(0, maxTasks)
        .map((text) => ({ text: formatAgentPlanSentence(text), done: false }));
      if (Array.isArray(raw)) {
        return raw.map((p) => {
          if (p && typeof p === 'object') {
            const title = String(p.title || p.name || '').trim();
            const tasks = Array.isArray(p.tasks) ? p.tasks : (Array.isArray(p.sub_tasks) ? p.sub_tasks : []);
            return { title, tasks: mkTasks(tasks) };
          }
          return { title: String(p || '').trim(), tasks: [] };
        }).filter((p) => p.title).slice(0, maxPhases);
      }
      const text = String(raw || '').trim();
      if (!text) return [];
      return text.split('|').map((chunk) => {
        const part = String(chunk || '').trim();
        if (!part) return null;
        const idx = part.indexOf('::');
        if (idx < 0) return { title: part, tasks: [] };
        const title = part.slice(0, idx).trim();
        const tasks = part.slice(idx + 2).split(/\s*;\s*|\s*•\s*/);
        return title ? { title, tasks: mkTasks(tasks) } : null;
      }).filter(Boolean).slice(0, maxPhases);
    }

    // .aiexe/plan.md is the cross-run source of truth: `## Phase N · title` +
    // `- [ ]`/`- [x]` sub-tasks. The checkboxes ARE the state.
    function buildAgentPlanMarkdown(planSpec) {
      const spec = planSpec && typeof planSpec === 'object' ? planSpec : {};
      const phases = Array.isArray(spec.phases) ? spec.phases : [];
      const name = String(spec.projectName || 'project').trim();
      const lines = [`# Build plan — ${name}`, ''];
      if (String(spec.summary || '').trim()) {
        lines.push(`> ${String(spec.summary).trim()}`, '');
      }
      phases.forEach((phase, i) => {
        const title = String((phase && phase.title) || `Phase ${i + 1}`).trim();
        lines.push(`## Phase ${i + 1} · ${title}`);
        const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
        if (tasks.length === 0) {
          lines.push(`- [${phase && phase.done ? 'x' : ' '}] ${title}`);
        }
        tasks.forEach((task) => {
          const txt = formatAgentPlanSentence((task && task.text) || task || '');
          if (txt) lines.push(`- [${task && task.done ? 'x' : ' '}] ${txt}`);
        });
        lines.push('');
      });
      return `${lines.join('\n').trim()}\n`;
    }

    // Read plan.md back into phases (source of truth across runs). The first
    // unchecked box is the single resume point.
    function parseAgentPlanMarkdown(markdown) {
      const text = String(markdown || '');
      const phases = [];
      let summary = '';
      let projectName = '';
      let current = null;
      text.split(/\r?\n/).forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        if (!projectName) {
          const title = line.match(/^#\s+Build plan\s*[—:-]\s*(.+)$/i);
          if (title) { projectName = title[1].trim(); return; }
        }
        if (!summary && /^>\s+/.test(line)) { summary = line.replace(/^>\s+/, '').trim(); return; }
        const head = line.match(/^##\s+Phase\s+\d+\s*[·:.\-]?\s*(.*)$/i);
        if (head) {
          current = { title: head[1].trim(), tasks: [] };
          phases.push(current);
          return;
        }
        const box = line.match(/^-\s*\[([ xX])\]\s+(.*)$/);
        if (box && current) {
          current.tasks.push({ text: box[2].trim(), done: box[1].toLowerCase() === 'x' });
        }
      });
      return { phases, summary, projectName };
    }

    // First phase whose tasks aren't all checked — the one resume rule.
    function firstUnfinishedPhaseIndex(phases) {
      const list = Array.isArray(phases) ? phases : [];
      for (let i = 0; i < list.length; i += 1) {
        const tasks = Array.isArray(list[i] && list[i].tasks) ? list[i].tasks : [];
        const allDone = tasks.length > 0
          ? tasks.every((t) => t && t.done)
          : Boolean(list[i] && list[i].done);
        if (!allDone) return i;
      }
      return -1;
    }

    function buildFallbackExpectedFiles(taskKind, primaryStack, projectName = '') {
      if (String(taskKind || '').toLowerCase() !== 'project') return [];
      const base = String(projectName || '')
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
      if (String(primaryStack || '').toLowerCase() === 'python') {
        return [base ? `/${base.replace(/-/g, '_')}.py` : '/main.py'];
      }
      if (String(primaryStack || '').toLowerCase() === 'web') {
        // Default to a single self-contained index.html (inline CSS + classic JS) so a
        // double-clicked file just works (file://). The model can still plan separate
        // style.css/script.js explicitly when a larger structure is warranted.
        return ['/index.html'];
      }
      return base ? [`/${base}.txt`] : ['/main.txt'];
    }

    // File names the user literally typed in the task ("index.html + style.css +
    // app.js") — used only when the model plan is missing/empty, so a lost planner
    // response degrades to the user's own file list instead of one index.html.
    function extractExplicitTaskFilePaths(taskText = '', maxFiles = 12) {
      const libraryNames = new Set(['node.js', 'three.js', 'vue.js', 'next.js', 'express.js', 'd3.js', 'chart.js', 'p5.js', 'react.js', 'jquery.js']);
      const out = [];
      const seen = new Set();
      const re = /(?:^|[\s"'`(,:+])((?:\/?[a-z0-9_-]+\/)*[a-z0-9._-]+\.(?:html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx|json|md|txt|py|php|java|go|rs|c|cpp|cs))\b/gi;
      let match;
      while ((match = re.exec(String(taskText || ''))) && out.length < maxFiles) {
        const raw = String(match[1] || '');
        if (libraryNames.has(raw.toLowerCase())) continue;
        const path = normalizeWorkspacePath(raw);
        if (!path || path === '/' || seen.has(path)) continue;
        seen.add(path);
        out.push(path);
      }
      return out;
    }

    function isSingleHtmlFileRequest(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      return /\b(?:one|single|1)\s+(?:self[-\s]*contained\s+)?(?:html|\.html)\s+file\b/.test(lower)
        || /\bin\s+(?:one|a single|1)\s+(?:html|\.html)\s+file\b/.test(lower)
        || (/\bsingle[-\s]*file\b/.test(lower) && /\b(?:html|web\s+app|page)\b/.test(lower));
    }

    function getPlannedFileRoles(expectedFiles = []) {
      const files = Array.isArray(expectedFiles) ? expectedFiles.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean) : [];
      const htmlFiles = files.filter((path) => /\.html?$/i.test(path));
      const cssFiles = files.filter((path) => /\.(css|scss|sass|less)$/i.test(path));
      const scriptFiles = files.filter((path) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(path));
      return {
        files,
        htmlFiles,
        htmlFile: htmlFiles[0] || '',
        cssFiles,
        cssFile: cssFiles[0] || '',
        scriptFiles,
        scriptFile: scriptFiles[0] || '',
        pythonFile: files.find((path) => /\.py$/i.test(path)) || '',
      };
    }

    function requestedPublicHtmlPageLimit(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      const words = {
        one: 1, two: 2, three: 3, four: 4, five: 5,
        six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      };
      const numeric = lower.match(/\b(\d{1,2})\s*[- ]?\s*(?:page|screen|route)s?\b/);
      if (numeric) return Math.max(1, Math.min(20, Number(numeric[1]) || 0));
      const word = lower.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]?\s*(?:page|screen|route)s?\b/);
      return word ? words[word[1]] : 0;
    }

    function extractPlannedPathFromPhaseTask(task) {
      const text = String((task && task.text) || task || '');
      const match = text.match(/(?:^|\s)(\/?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*\.(?:html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx|md|txt|json|csv|py))\b/i);
      return match ? normalizeWorkspacePath(match[1]) : '';
    }

    function phaseTaskForPath(path) {
      return { text: String(path || '').replace(/^\//, ''), done: false };
    }

    function normalizeWebProjectPhases(phases = [], expectedFiles = [], primaryStack = '') {
      const isWeb = String(primaryStack || '').toLowerCase() === 'web'
        || expectedFiles.some((path) => /\.html?$/i.test(String(path || '')));
      const list = Array.isArray(phases) ? phases.filter((phase) => phase && phase.title) : [];
      if (!isWeb || list.length < 2) return list;
      const expected = expectedFiles.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean);
      const expectedSet = new Set(expected);
      const htmlFiles = expected.filter((path) => /\.html?$/i.test(path));
      if (htmlFiles.length < 2) return list;
      const cssFiles = expected.filter((path) => /\.(css|scss|sass|less)$/i.test(path));
      const scriptFiles = expected.filter((path) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(path));
      const docs = expected.filter((path) => /\.(md|txt)$/i.test(path));
      const primaryHtml = htmlFiles[0] || '';
      // Structure-first: the entry HTML is built FIRST so the CSS styles the real
      // markup and the JS operates on real structure (same as writing markup before
      // styling it). HTML → CSS (tokens, then base) → JS (components, then behavior).
      const foundation = [
        primaryHtml,
        ...cssFiles.filter((path) => /design[-_]?tokens|tokens|theme|variables/i.test(path)),
        ...cssFiles.filter((path) => !/design[-_]?tokens|tokens|theme|variables/i.test(path)),
        ...scriptFiles.filter((path) => /components?|shared|layout/i.test(path)),
        ...scriptFiles.filter((path) => !/components?|shared|layout/i.test(path)),
      ].filter((path, index, arr) => path && arr.indexOf(path) === index);
      const foundationSet = new Set(foundation);
      const normalized = [];
      const first = Object.assign({}, list[0], { tasks: foundation.map(phaseTaskForPath) });
      normalized.push(first);

      const assigned = new Set(foundation);
      list.slice(1).forEach((phase) => {
        const tasks = (Array.isArray(phase.tasks) ? phase.tasks : [])
          .map((task) => {
            const path = extractPlannedPathFromPhaseTask(task);
            return path && expectedSet.has(path) && !foundationSet.has(path) ? phaseTaskForPath(path) : null;
          })
          .filter(Boolean);

        tasks.forEach((task) => {
          const path = extractPlannedPathFromPhaseTask(task);
          if (path) assigned.add(path);
        });

        if (tasks.length > 0) {
          normalized.push(Object.assign({}, phase, { tasks }));
        } else if (docs.length > 0 && /\b(brand|design|identity|typography|motion|style|strategy|seo|cro|guide|docs?|readme|notes?)\b/i.test(`${phase.title} ${(phase.tasks || []).map((task) => String((task && task.text) || task || '')).join(' ')}`)) {
          const docTask = phaseTaskForPath(docs[0]);
          assigned.add(docs[0]);
          normalized.push(Object.assign({}, phase, { tasks: [docTask] }));
        }
      });

      // Safety net: model phase text can be semantic ("Product pages") or capped
      // docs can remove noisy HTML tasks before this normalizer runs. For a real
      // multi-page web project, every non-entry HTML page must still land in a
      // later phase so Continue builds the remaining pages instead of orphaning them.
      const remainingHtml = htmlFiles
        .filter((path) => path && path !== primaryHtml && !assigned.has(path))
        .map(phaseTaskForPath);
      if (remainingHtml.length > 0) {
        const pagePhaseIndex = normalized.findIndex((phase, index) => index > 0 && /\b(page|route|screen|view)s?\b/i.test(String(phase && phase.title || '')));
        if (pagePhaseIndex >= 0) {
          const existingTasks = Array.isArray(normalized[pagePhaseIndex].tasks) ? normalized[pagePhaseIndex].tasks : [];
          normalized[pagePhaseIndex] = Object.assign({}, normalized[pagePhaseIndex], {
            tasks: existingTasks.concat(remainingHtml),
          });
        } else {
          normalized.push({ title: 'Additional pages', tasks: remainingHtml });
        }
      }

      return normalized;
    }

    function buildAgentProjectContract(taskText = '', taskKind = '', primaryStack = '', expectedFiles = []) {
      if (String(taskKind || '').toLowerCase() !== 'project') return '';
      const { files, htmlFiles, htmlFile, cssFiles, cssFile, scriptFile } = getPlannedFileRoles(expectedFiles);
      const lower = String(taskText || '').toLowerCase();
      const frameworkWeb = files.some((path) => (
        /(?:^|\/)package\.json$/i.test(path)
        || /(?:^|\/)(?:vite|next|nuxt|astro|svelte|tsconfig|tailwind\.config|postcss\.config)[^/]*\.(?:js|mjs|cjs|ts|json)$/i.test(path)
        || /\/src\/.+\.(?:tsx|jsx)$/i.test(path)
      ));
      const lines = [];
      lines.push(`Planned files: ${files.join(', ') || '(none)'}`);
      lines.push('Quality contract:');
      lines.push('- Build the complete, working feature the request describes. Match the quality and depth you would produce answering this in a normal chat — do not ship a reduced stub or "first pass".');
      lines.push('- Reuse shared classes, helpers, and patterns so each file stays coherent and finishes cleanly.');
      if (frameworkWeb) {
        lines.push('Framework web project contract:');
        lines.push('- Keep the requested framework architecture: package/config files define the local build/dev setup, source files contain components/state/views, and mock data stays local unless the user asks for APIs.');
        if (files.includes('/package.json')) lines.push('- /package.json: include realistic scripts and dependencies for the planned framework stack.');
        if (htmlFile) lines.push(`- ${htmlFile}: app shell only, with a root mount element and the correct framework entry script.`);
        const sourceFiles = files.filter((path) => /\/src\/.+\.(?:js|jsx|ts|tsx|css|scss|sass|less)$/i.test(path));
        if (sourceFiles.length) lines.push(`- Source files (${sourceFiles.join(', ')}): implement the actual UI, reusable components, state, routing/views, and interactions.`);
        lines.push('- Framework source files may use normal import/export and JSX/TSX when that is the planned stack.');
      } else if (String(primaryStack || '').toLowerCase() === 'web' || htmlFile) {
        lines.push('Web project contract:');
        if (htmlFile && !cssFile && !scriptFile) {
          lines.push(`- ${htmlFile} is the entire web app: include CSS in a <style> block and JavaScript in a <script> block.`);
          lines.push('- Do not reference style.css or script.js unless those files are explicitly planned.');
        }
        if (htmlFile) {
          lines.push(`- ${htmlFile}: semantic structure with the requested sections, shared classes, and stable IDs.`);
        }
        if (htmlFile && cssFile) {
          const cssHrefs = cssFiles.map((path) => path.replace(/^\//, ''));
          const pageList = htmlFiles.length > 1 ? htmlFiles.join(', ') : htmlFile;
          lines.push(`- Every HTML page (${pageList}) must include these stylesheet links in <head>: ${cssHrefs.map((href) => `<link rel="stylesheet" href="${href}">`).join(' ')}`);
          lines.push('- No planned HTML page may contain a <style> block or large inline style attributes when shared CSS is planned.');
          lines.push(`- Planned CSS files (${cssFiles.join(', ')}) must contain the visual design and only CSS.`);
          lines.push(`- ${cssFile}: design tokens, layout, responsive rules, and reusable animation/motion rules; prefer shared selectors over a unique one-off style for every element.`);
        }
        if (htmlFile && scriptFile) {
          const scriptSrc = scriptFile.replace(/^\//, '');
          const pageList = htmlFiles.length > 1 ? htmlFiles.join(', ') : htmlFile;
          lines.push(`- Every HTML page that needs behavior (${pageList}) must include <script src="${scriptSrc}" defer></script>.`);
          lines.push('- Planned HTML pages must not contain inline JavaScript.');
          lines.push(`- ${scriptFile} must only reference IDs/classes/hooks that exist in the planned HTML pages.`);
          lines.push(`- ${scriptFile}: implement the full behavior the request needs, organized with reusable functions.`);
        }
        if (htmlFiles.length > 1 && (cssFile || scriptFile)) {
          lines.push('- Multi-page consistency: use the same logo/header/nav/footer/CTA source of truth on every page. Prefer shared hooks rendered by js/components.js when that file is planned; otherwise copy the exact same class structure, not a redesigned variant.');
          lines.push('- Public HTML pages must match the planned public page count/scope. Strategy, design-system, SEO, CRO, and implementation-guide deliverables belong in shared tokens/CSS/components and README/docs unless the user explicitly requested them as navigable pages.');
        }
        if (/\bsurprise|reveal|secret|easter egg\b/.test(lower)) {
          lines.push(`- Shared interaction contract: include a primary button with id="surprise-btn" and a reveal region with id="surprise-panel"${htmlFile ? ` in ${htmlFile}` : ''}.`);
          if (scriptFile) lines.push(`- ${scriptFile} should attach the surprise interaction to #surprise-btn and update/toggle #surprise-panel.`);
        }
        lines.push('- Keep class and ID names consistent across HTML, CSS, and JavaScript.');
        lines.push('- Prefer local CSS/JS only; do not rely on network assets unless the user explicitly asks.');
      }
      if (String(primaryStack || '').toLowerCase() === 'python') {
        lines.push('Python project contract:');
        lines.push('- Include a complete, runnable script with clear functions and minimal dependencies.');
        lines.push('- Split into additional files only when the plan explicitly includes them or the project needs modules.');
        lines.push('- If the code imports any third-party package (e.g. pygame, numpy, requests), add a requirements.txt listing them (one per line) and do NOT pip-install at runtime — the Run button installs requirements.txt into a virtual environment.');
      }
      if (files.includes('/README.md')) {
        lines.push('README: project purpose, local run instructions, and the actual file names.');
      }
      return lines.join('\n');
    }

    function shouldFallbackPlanNeedReadme(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      if (!lower) return false;
      if (/\b(readme|documentation|docs?)\b/.test(lower)) return true;
      if (/\b(setup|install|usage|run instructions|how to run|getting started)\b/.test(lower)) return true;
      if (/\b(api|service|docker|env|database|server)\b/.test(lower)) return true;
      return false;
    }

    function isExplicitReadmeOrDocsTask(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      return /\b(readme|documentation|docs?|contributing|code of conduct|developer guide|getting started|onboarding|usage guide|setup guide)\b/.test(lower)
        || (/self-explanatory/.test(lower) && /\b(project|workspace|repo|codebase|app|code)\b/.test(lower));
    }

    function isDocsOnlyTask(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      if (!isExplicitReadmeOrDocsTask(taskText)) return false;
      const createsSoftware = /\b(create|build|make|start|setup|set up|design|develop|generate|craft)\b/.test(lower)
        && /\b(project|app|site|website|page|tool|game|dashboard|calculator|frontend|ui)\b/.test(lower);
      return !createsSoftware;
    }

    function isExistingProjectMutationRequest(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      if (!lower) return false;
      const mutationIntent = /\b(add|update|edit|modify|change|fix|delete|remove|rename|refactor|improve|create)\b/.test(lower);
      const existingProjectTarget = /\b(project|workspace|code|file|files|readme|docs?|current|existing|this)\b/.test(lower);
      const explicitNewProject = /\b(new project|new workspace|fresh workspace|from scratch|start from scratch|separate project|brand new)\b/.test(lower);
      return mutationIntent && existingProjectTarget && !explicitNewProject;
    }

    function isOpenWorkspaceFollowupMutation(taskText = '') {
      if (!hasOpenWorkspaceContext()) return false;
      const lower = String(taskText || '').toLowerCase();
      if (!lower) return false;
      if (/\b(new project|new workspace|fresh workspace|from scratch|start from scratch|separate project|brand new)\b/.test(lower)) return false;
      return /\b(add|update|edit|modify|change|fix|delete|remove|rename|refactor|improve|implement|polish|modern|responsive|dark mode|design|style|styles|styling|css|layout|calculator)\b/.test(lower);
    }

    function chatOwnsOpenWorkspace(chatId = '') {
      if (!hasOpenWorkspaceContext()) return false;
      const id = String(chatId || (typeof deps.getActiveChatId === 'function' ? deps.getActiveChatId() : '') || '').trim();
      return Boolean(
        id
        && typeof deps.chatHasPriorAgentWorkspaceWork === 'function'
        && deps.chatHasPriorAgentWorkspaceWork(id)
      );
    }

    function hasOpenWorkspaceContext() {
      if (typeof deps.getWorkspaceContext !== 'function') return false;
      const workspace = deps.getWorkspaceContext() || {};
      const currentPath = normalizeWorkspacePath(workspace.currentPath || '/');
      return Boolean(
        String(workspace.workspaceRootName || '').trim()
        || Number(workspace.rootEntryCount) > 0
        || Boolean(workspace.rootLoaded)
        || currentPath !== '/'
      );
    }

    function normalizeAgentPlanSpec(parsed, taskText = '', options = {}) {
      const lower = String(taskText || '').toLowerCase();
      const explicitViteReactTask = isExplicitViteReactTask(taskText);
      const parsedObj = parsed && typeof parsed === 'object' ? parsed : {};
      const hasAgentPlanShape = ['task_kind', 'project_name', 'primary_stack', 'expected_files', 'affected_files', 'done_criteria', 'validation', 'summary']
        .some((key) => Object.prototype.hasOwnProperty.call(parsedObj, key));
      if (!hasAgentPlanShape && (Object.prototype.hasOwnProperty.call(parsedObj, 'route') || Object.prototype.hasOwnProperty.call(parsedObj, 'intent'))) {
        return buildFallbackAgentPlanSpec(taskText, options);
      }
      const explicitFreshWorkspaceIntent = /\b(new project|new workspace|fresh workspace|from scratch|start from scratch|separate project|brand new)\b/.test(lower);
      const sameChatWorkspaceFollowup = chatOwnsOpenWorkspace(options && options.chatId);
      const projectLikeFallback = (
        /\b(create|build|make|start|setup|set up|design|develop|generate|craft)\b/.test(lower)
        && /\b(project|app|site|website|page|tool|game|dashboard|calculator|frontend|ui)\b/.test(lower)
      );
      const explicitDocsTask = isExplicitReadmeOrDocsTask(taskText);
      const docsOnlyTask = isDocsOnlyTask(taskText);
      const workspaceScopedMutation = hasOpenWorkspaceContext() && isExistingProjectMutationRequest(taskText);
      const openWorkspaceFollowupMutation = isOpenWorkspaceFollowupMutation(taskText);
      const workspaceContext = typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() || {} : {};
      const isWorkspaceEmpty = hasOpenWorkspaceContext() && Number(workspaceContext.rootEntryCount) === 0;
      let taskKind = ['project', 'edit', 'analysis'].includes(String(parsed && parsed.task_kind || '').toLowerCase())
        ? String(parsed.task_kind).toLowerCase()
        : (projectLikeFallback ? 'project' : 'edit');
      if (explicitFreshWorkspaceIntent && projectLikeFallback && !docsOnlyTask) {
        taskKind = 'project';
      }
      if (sameChatWorkspaceFollowup && !explicitFreshWorkspaceIntent && taskKind !== 'analysis') {
        taskKind = 'edit';
      }
      if (openWorkspaceFollowupMutation && !explicitFreshWorkspaceIntent && taskKind !== 'analysis') {
        taskKind = 'edit';
      }
      if (!sameChatWorkspaceFollowup && !workspaceScopedMutation && !openWorkspaceFollowupMutation && projectLikeFallback && taskKind !== 'analysis') {
        taskKind = 'project';
      }
      if ((docsOnlyTask || sameChatWorkspaceFollowup || workspaceScopedMutation || openWorkspaceFollowupMutation) && taskKind === 'project' && !explicitFreshWorkspaceIntent) {
        if (!isWorkspaceEmpty) {
          taskKind = 'edit';
        }
      }
      if (taskKind === 'edit' && isWorkspaceEmpty) {
        taskKind = 'project';
      }
      // The user explicitly approved creating a new project at preflight. Force
      // project scope BEFORE the derived fields (expectedFiles, finalRequiresRealFiles)
      // are computed, so the plan is coherent — not just a relabelled edit/analysis
      // plan that the agent considers "done" after only creating an empty project.
      if (options && options.forceProjectScope) {
        taskKind = 'project';
      }
      let primaryStack = ['python', 'web', 'generic'].includes(String(parsed && parsed.primary_stack || '').toLowerCase())
        ? String(parsed.primary_stack).toLowerCase()
        : (/python|pygame|\.py\b/.test(lower) ? 'python' : ((WEB_TASK_HINT_REGEX.test(lower) || /\bcalculator\b/.test(lower)) ? 'web' : 'generic'));
      const parsedProjectName = normalizeWorkspaceName(parsed && parsed.project_name ? parsed.project_name : '');
      // Trust the model's project name when it is usable. It knows the subject
      // (e.g. "tetris") far better than any keyword rule; deriveProjectNameFromTask
      // is only a last resort for when the model gave nothing usable. (A prior
      // keyword "intent" check used to OVERRIDE the model's name with the regex
      // fallback — it replaced a correct "tetris" with "full-game". Removed.)
      const projectName = parsedProjectNameLooksUsable(parsedProjectName, taskText)
        ? sanitizeProjectSlug(parsedProjectName)
        : deriveProjectNameFromTask(taskText);
      let expectedFiles = parseAgentExpectedFiles(parsed && parsed.expected_files ? parsed.expected_files : '');
      expectedFiles = expectedFiles.filter((path) => !/\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?)$/i.test(String(path || '')));
      // Binary document/sheet formats can't be authored as text — plan the text-native
      // equivalent so the plan, write target, and validation all agree (.pdf/.docx/.pptx
      // → .html; .xlsx/.ods → .csv). Mirrors the executor's write-time redirect.
      const mapBinaryDocPath = (p) => String(p || '')
        .replace(/\.(?:pdf|docx?|rtf|odt|pptx?)$/i, '.html')
        .replace(/\.(?:xlsx?|ods)$/i, '.csv');
      expectedFiles = expectedFiles.map(mapBinaryDocPath);
      let affectedFiles = parseAgentPlanPathList(parsed && parsed.affected_files ? parsed.affected_files : '').map(mapBinaryDocPath);
      let filesToInspect = parseAgentPlanPathList(parsed && parsed.files_to_inspect ? parsed.files_to_inspect : '');
      let doneCriteria = parseAgentPlanTextList(parsed && parsed.done_criteria ? parsed.done_criteria : '', 5); // cap 5
      let phases = parseAgentPlanPhases(parsed && parsed.phases ? parsed.phases : ''); // [{title,tasks}]
      const validationSteps = parseAgentPlanTextList(parsed && parsed.validation ? parsed.validation : '', 6);
      const looksLikeWebProjectTask = taskKind === 'project' && (WEB_TASK_HINT_REGEX.test(lower) || /\bcalculator\b/.test(lower));
      // Trust the model's multi-file plan over the "single html file" keyword match:
      // collapsing a parsed /index.html|/style.css|/app.js plan to one file mutated
      // the project contract after the planner had already honored the user's files.
      const modelPlannedMultiFile = expectedFiles.filter((path) => /\.(?:html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx)$/i.test(String(path || ''))).length > 1;
      const singleHtmlFileProject = taskKind === 'project' && isSingleHtmlFileRequest(taskText) && !modelPlannedMultiFile;
      if (singleHtmlFileProject) {
        primaryStack = 'web';
        expectedFiles = ['/index.html'];
        affectedFiles = [];
        filesToInspect = [];
      }
      const rootEntries = Array.isArray(workspaceContext.rootEntries) ? workspaceContext.rootEntries : [];
      const rootFilePaths = rootEntries
        .filter((entry) => String(entry && entry.kind || '').toLowerCase() !== 'folder')
        .map((entry) => normalizeWorkspacePath((entry && entry.path) || (entry && entry.name ? `/${entry.name}` : '')))
        .filter(Boolean);
      const findRootFile = (regex) => rootFilePaths.find((path) => regex.test(path)) || '';
      const rootFileByBasename = new Map(rootFilePaths.map((path) => {
        const name = String(path || '').split('/').filter(Boolean).pop() || '';
        return [name.toLowerCase(), path];
      }));
      const remapToExistingWorkspaceFile = (path) => {
        const normalized = normalizeWorkspacePath(path || '');
        if (!normalized || normalized === '/') return '';
        if (rootFilePaths.includes(normalized)) return normalized;
        const basename = normalized.split('/').filter(Boolean).pop() || '';
        return rootFileByBasename.get(basename.toLowerCase()) || normalized;
      };
      const currentWorkspaceEdit = taskKind === 'edit' && rootFilePaths.length > 0 && (
        sameChatWorkspaceFollowup || workspaceScopedMutation || openWorkspaceFollowupMutation || hasOpenWorkspaceContext()
      );
      if (currentWorkspaceEdit) {
        const dedupe = (list) => Array.from(new Set(list));
        // The real workspace layout wins over conventional guessed folders
        // (/css/style.css remaps onto an existing root /style.css), but model-named
        // paths with no existing match are planned NEW files (e.g. "split into
        // style.css + app.js") and must survive — dropping them collapsed multi-file
        // edit plans down to the one file that already existed.
        expectedFiles = dedupe(expectedFiles.map(remapToExistingWorkspaceFile).filter(Boolean));
        affectedFiles = dedupe(affectedFiles.map(remapToExistingWorkspaceFile).filter(Boolean));
        filesToInspect = dedupe(filesToInspect.map(remapToExistingWorkspaceFile).filter(Boolean));
        // rootEntries only contains the workspace root, so it cannot prove whether a
        // nested path such as /src/components/Hero.tsx exists. The old "existing only"
        // filter discarded every nested target and replaced it with unrelated root
        // config files. For an edit, the model-named inspect/affected paths are the best
        // grounded targets; a real read failure can still trigger discovery afterward.
        filesToInspect = filesToInspect.length > 0
          ? filesToInspect
          : (affectedFiles.length > 0 ? affectedFiles.slice() : rootFilePaths.slice());
      }
      const webEditNeedsCoordinatedFiles = taskKind === 'edit'
        && hasOpenWorkspaceContext()
        && /\b(design|style|layout|responsive|mobile|dark\s*mode|light\s*mode|theme|toggle|calculator|modern|polish|ui|frontend)\b/i.test(lower);
      if (webEditNeedsCoordinatedFiles) {
        const coordinatedFiles = [
          findRootFile(/\/[^/]+\.html?$/i),
          findRootFile(/\/[^/]+\.(?:css|scss|sass|less)$/i),
          findRootFile(/\/[^/]+\.(?:js|mjs|cjs|ts|jsx|tsx)$/i),
        ].filter(Boolean);
        if (coordinatedFiles.length > 0) {
          if (affectedFiles.length === 0) {
            affectedFiles = coordinatedFiles.slice();
          }
          if (filesToInspect.length === 0) {
            filesToInspect = coordinatedFiles.slice();
          }
        }
      }
      const expectedFilesLookLikeGenericText = expectedFiles.length > 0 && expectedFiles.every((path) => /\.(txt|md)$/i.test(String(path || '')));
      if (looksLikeWebProjectTask && (primaryStack === 'generic' || expectedFilesLookLikeGenericText)) {
        primaryStack = 'web';
        expectedFiles = [];
      }
      if (docsOnlyTask && expectedFiles.length === 0) {
        expectedFiles = ['/README.md'];
      }
      const publicHtmlLimit = taskKind === 'project' && (primaryStack === 'web' || looksLikeWebProjectTask)
        ? requestedPublicHtmlPageLimit(taskText) : 0;
      const plannedHtmlFiles = expectedFiles.filter((path) => /\.html?$/i.test(path));
      if (publicHtmlLimit > 0 && plannedHtmlFiles.length > publicHtmlLimit) {
        const keptHtml = plannedHtmlFiles.slice(0, publicHtmlLimit);
        const keptHtmlSet = new Set(keptHtml.map((path) => normalizeWorkspacePath(path)));
        const removed = new Set(plannedHtmlFiles
          .filter((path) => !keptHtmlSet.has(normalizeWorkspacePath(path)))
          .map((path) => normalizeWorkspacePath(path)));
        expectedFiles = expectedFiles.filter((path) => !removed.has(normalizeWorkspacePath(path)));
        const askedForWrittenNotes = /\b(?:strategy|guide|documentation|docs?|notes?|identity|typography|system|seo|cro|motion|content|implementation|brand)\b/i.test(lower);
        if (askedForWrittenNotes && !expectedFiles.includes('/README.md')) {
          expectedFiles.push('/README.md');
        }
        phases = phases.map((phase) => {
          const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
          const keptTasks = tasks.filter((task) => {
            const text = String((task && task.text) || task || '');
            const normalizedTaskPath = normalizeWorkspacePath(text.split(/\s+/)[0] || '');
            return !removed.has(normalizedTaskPath);
          });
          if (keptTasks.length === 0 && expectedFiles.includes('/README.md')) {
            keptTasks.push({ text: 'README.md project notes', done: false });
          }
          return Object.assign({}, phase, { tasks: keptTasks });
        }).filter((phase) => Array.isArray(phase && phase.tasks) && phase.tasks.length > 0);
      }
      if (taskKind === 'edit' && expectedFiles.length === 0 && affectedFiles.length > 0) {
        expectedFiles = affectedFiles.slice();
      }
      if (taskKind === 'edit' && affectedFiles.length === 0 && expectedFiles.length > 0) {
        affectedFiles = expectedFiles.slice();
      }
      const nonReadmeExpectedFiles = expectedFiles.filter((path) => path && path !== '/README.md');
      const simpleSingleFileProject = taskKind === 'project' && nonReadmeExpectedFiles.length === 1 && !explicitDocsTask;
      const requestedReadme = taskKind === 'project' && (
        String(parsed && parsed.needs_readme || '').toLowerCase() === 'yes'
        || expectedFiles.includes('/README.md')
      ) && !simpleSingleFileProject;
      const requestedRunInstructions = taskKind === 'project' && (
        String(parsed && parsed.needs_run_instructions || '').toLowerCase() === 'yes'
        || requestedReadme
      ) && !simpleSingleFileProject;
      // Run instructions do NOT force a README: the completion message already tells the
      // user how to run it. README only when the plan (or user) actually asked for one.
      const needsReadme = requestedReadme;
      const needsRunInstructions = requestedRunInstructions;
      const finalRequiresRealFiles = !docsOnlyTask && taskKind === 'project' && (
        String(parsed && parsed.final_requires_real_files || '').toLowerCase() === 'yes'
        || taskKind === 'project'
      );
      if (taskKind === 'project' && expectedFiles.length === 0) {
        const explicitTaskFiles = singleHtmlFileProject ? [] : extractExplicitTaskFilePaths(taskText);
        expectedFiles = explicitViteReactTask
          ? buildViteReactExpectedFiles()
          : explicitTaskFiles.length > 0
          ? explicitTaskFiles
          : buildFallbackExpectedFiles(taskKind, primaryStack, projectName || deriveProjectNameFromTask(taskText));
      }
      if (taskKind === 'project' && doneCriteria.length === 0) {
        doneCriteria = buildFallbackDoneCriteria(taskText, expectedFiles);
      }
      if (taskKind === 'project' && !singleHtmlFileProject && !simpleSingleFileProject && (primaryStack === 'web' || looksLikeWebProjectTask)) {
        // Ensure the project has an HTML entry point. Default is a single self-contained
        // index.html; only honor separate style.css/script.js when the model planned them
        // (so a multi-file structure is opt-in, not forced — single files run from file://
        // most reliably). If the model planned css/js but no html, add index.html to host them.
        const hasHtml = expectedFiles.some((item) => /\.html?$/i.test(item));
        if (!hasHtml) expectedFiles.unshift('/index.html');
      }
      if (taskKind === 'project' && needsReadme && !expectedFiles.includes('/README.md')) {
        expectedFiles.push('/README.md');
      }
      phases = normalizeWebProjectPhases(phases, expectedFiles, primaryStack);
      // Internal tool identifiers are backend vocabulary — never surface them in
      // user-visible plan text (checklist/goal/validation). Closed-set mapping of
      // our own tool names, case-insensitive; not content/phrasing dependent.
      const humanizePlanText = (value) => String(value || '')
        .replace(/`?\bcheck_code\b`?/gi, 'the syntax check')
        .replace(/`?\brun_app\b`?/gi, 'the app preview run')
        .replace(/`?\brun_command\b`?/gi, 'the terminal run')
        .replace(/`?\bvalidate_files\b`?/gi, 'static file validation')
        .replace(/`?\bread_files\b`?/gi, 'file reads')
        .replace(/`?\bread_file\b`?/gi, 'a file read')
        .replace(/`?\bwrite_file\b`?/gi, 'a file write')
        .replace(/`?\bedit_file\b`?/gi, 'a file edit')
        .replace(/`?\bsearch_files\b`?/gi, 'a file search')
        .replace(/`?\blist_dir\b`?/gi, 'a folder scan')
        .replace(/`?\bnew_project\b`?/gi, 'project setup')
        .replace(/\b(the|a|an)\s+(?:the|a|an)\s+/gi, '$1 ')
        .trim();
      doneCriteria = doneCriteria.map(humanizePlanText).filter(Boolean);
      // Clip at a word boundary with a visible ellipsis — a hard slice ends the
      // Goal mid-list ("Modal, Avatar,") and reads as a corrupted prompt.
      const rawParsedSummary = humanizePlanText(String(parsed && parsed.summary ? parsed.summary : '').trim());
      const parsedSummary = rawParsedSummary.length > 220
        ? `${rawParsedSummary.slice(0, 220).replace(/\s+\S*$/, '')}…`
        : rawParsedSummary;
      return {
        taskKind,
        projectName: projectName || deriveProjectNameFromTask(taskText),
        primaryStack,
        needsReadme,
        needsRunInstructions,
        finalRequiresRealFiles,
        expectedFiles,
        affectedFiles,
        filesToInspect,
        doneCriteria,
        phases,
        validationSteps: validationSteps.map(humanizePlanText).filter(Boolean),
        projectContract: buildAgentProjectContract(taskText, taskKind, primaryStack, expectedFiles),
        summary: parsedSummary,
      };
    }

    function isExplicitViteReactTask(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      return /\bvite\b/.test(lower) && /\breact\b/.test(lower);
    }

    function buildViteReactExpectedFiles() {
      return [
        '/package.json',
        '/index.html',
        '/vite.config.ts',
        '/tsconfig.json',
        '/tsconfig.app.json',
        '/src/main.tsx',
        '/src/App.tsx',
        '/src/App.css',
        '/src/vite-env.d.ts',
      ];
    }

    function buildFallbackDoneCriteria(taskText = '', expectedFiles = []) {
      const lower = String(taskText || '').toLowerCase();
      const out = [];
      if (/\bhero\b/.test(lower)) out.push('Hero section with the requested theme and CTA.');
      if (/\bfeatures?\b/.test(lower)) out.push('Features section with clear highlight cards.');
      if (/\bgallery\b/.test(lower)) out.push('Gallery section with responsive visual cards or placeholders.');
      if (/\bcta\b|call[-\s]?to[-\s]?action/.test(lower)) out.push('Call-to-action section with a working button.');
      if (isExplicitViteReactTask(taskText)) out.push('Vite React project structure is runnable and verifiable.');
      if (!out.length && Array.isArray(expectedFiles) && expectedFiles.length) out.push('All planned project files are created.');
      return out.slice(0, 5);
    }

    function buildFallbackAgentPlanSpec(taskText = '', options = {}) {
      const lower = String(taskText || '').toLowerCase();
      const explicitViteReactTask = isExplicitViteReactTask(taskText);
      const explicitDocsTask = isExplicitReadmeOrDocsTask(taskText);
      const docsOnlyTask = isDocsOnlyTask(taskText);
      const workspaceScopedMutation = hasOpenWorkspaceContext() && isExistingProjectMutationRequest(taskText);
      const openWorkspaceFollowupMutation = isOpenWorkspaceFollowupMutation(taskText);
      const sameChatWorkspaceFollowup = chatOwnsOpenWorkspace(options && options.chatId);
      const projectLikeFallback = (
        /\b(create|build|make|start|setup|set up|design|develop|generate|craft)\b/.test(lower)
        && /\b(project|app|site|website|page|tool|game|dashboard|calculator|frontend|ui)\b/.test(lower)
      );
      const workspaceContext = typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() || {} : {};
      const isWorkspaceEmpty = hasOpenWorkspaceContext() && Number(workspaceContext.rootEntryCount) === 0;
      let taskKind = docsOnlyTask
        ? 'edit'
        : (sameChatWorkspaceFollowup || workspaceScopedMutation || openWorkspaceFollowupMutation)
        ? 'edit'
        : projectLikeFallback
        ? 'project'
        : (/\b(check|verify|review|inspect|analy[sz]e|compare|correlate|audit|look at)\b/.test(lower) ? 'analysis' : 'edit');
      if (taskKind === 'edit' && isWorkspaceEmpty) {
        taskKind = 'project';
      }
      // User explicitly approved a new project at preflight — force project scope
      // before deriving expectedFiles/finalRequiresRealFiles below.
      if (options && options.forceProjectScope) {
        taskKind = 'project';
      }
      let primaryStack = /python|pygame|\.py\b/.test(lower)
        ? 'python'
        : (((WEB_TASK_HINT_REGEX.test(lower) || /\bcalculator\b/.test(lower))) ? 'web' : 'generic');
      const needsReadme = shouldFallbackPlanNeedReadme(taskText);
      const projectName = deriveProjectNameFromTask(taskText);
      const fallbackSummary = (() => {
        const trimmed = String(taskText || '').replace(/\s+/g, ' ').trim();
        if (!trimmed) return projectName ? `Build ${projectName}.` : 'Build the requested project.';
        return trimmed.length > 220 ? `${trimmed.slice(0, 217).trim()}...` : trimmed;
      })();
      const singleHtmlFileProject = taskKind === 'project' && isSingleHtmlFileRequest(taskText);
      if (singleHtmlFileProject) primaryStack = 'web';
      const rootEntries = Array.isArray(workspaceContext.rootEntries) ? workspaceContext.rootEntries : [];
      const rootFilePaths = rootEntries
        .filter((entry) => String(entry && entry.kind || '').toLowerCase() !== 'folder')
        .map((entry) => normalizeWorkspacePath((entry && entry.path) || (entry && entry.name ? `/${entry.name}` : '')))
        .filter(Boolean);
      const explicitTaskFiles = extractExplicitTaskFilePaths(taskText);
      const fallbackExpectedFiles = docsOnlyTask
        ? ['/README.md']
        : sameChatWorkspaceFollowup && taskKind === 'edit' && rootFilePaths.length > 0
        ? rootFilePaths.slice()
        : singleHtmlFileProject
        ? ['/index.html']
        : explicitViteReactTask
        ? buildViteReactExpectedFiles()
        : taskKind === 'project' && explicitTaskFiles.length > 0
        ? explicitTaskFiles
        : buildFallbackExpectedFiles(taskKind, primaryStack, projectName);
      if (taskKind === 'project' && needsReadme && !fallbackExpectedFiles.includes('/README.md')) {
        fallbackExpectedFiles.push('/README.md');
      }
      return {
        taskKind,
        projectName,
        primaryStack,
        needsReadme,
        needsRunInstructions: needsReadme,
        finalRequiresRealFiles: docsOnlyTask ? false : taskKind === 'project',
        expectedFiles: fallbackExpectedFiles,
        // Never fabricate mutation targets for an edit we have no model signal for —
        // the root files are for inspection context only, not forced "update" demands.
        affectedFiles: taskKind === 'edit' ? [] : fallbackExpectedFiles.slice(),
        filesToInspect: taskKind === 'edit' ? fallbackExpectedFiles.slice() : [],
        doneCriteria: taskKind === 'project' ? buildFallbackDoneCriteria(taskText, fallbackExpectedFiles) : [],
        phases: [],
        validationSteps: taskKind === 'project' ? (explicitViteReactTask ? ['validate_files', 'run_app'] : ['validate_files']) : [],
        projectContract: buildAgentProjectContract(taskText, taskKind, primaryStack, fallbackExpectedFiles),
        summary: fallbackSummary,
      };
    }

    // Harvest shared vocab (stylesheets, tokens, classes, shell hooks) from already-built
    // files so later pages reuse real names. Deterministic, no model call. '' if nothing built.
    function harvestFoundationVocabulary(fileContents = {}) {
      const entries = Object.entries(fileContents || {})
        .map(([p, c]) => [String(p || ''), String(c || '')])
        .filter(([p, c]) => p && c.trim());
      if (!entries.length) return '';
      // drop file-ext/unit false positives
      const stop = new Set(['css', 'scss', 'sass', 'less', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'js', 'mjs', 'cjs', 'json', 'html', 'htm', 'woff', 'woff2', 'ttf', 'eot', 'map', 'min']);
      const cssPaths = [];
      const componentScripts = [];
      const tokens = new Set();
      const classes = new Set();
      const dataHooks = new Set();
      for (const [path, content] of entries) {
        const lower = path.toLowerCase();
        const rel = path.replace(/^\//, '');
        if (/\.(css|scss|sass|less)$/.test(lower)) {
          cssPaths.push(rel);
          let m;
          const tokRe = /--([a-zA-Z][\w-]*)\s*:/g;
          while ((m = tokRe.exec(content)) && tokens.size < 48) tokens.add(`--${m[1]}`);
          const clsRe = /\.([a-zA-Z_][\w-]{1,40})(?=[\s.,#:>{[)]|$)/g;
          while ((m = clsRe.exec(content)) && classes.size < 80) {
            if (!stop.has(m[1].toLowerCase())) classes.add(`.${m[1]}`);
          }
        }
        if (/(?:^|\/)(?:components?|layout|shared|shell)\.[cm]?js$/.test(lower)) componentScripts.push(rel);
        let dm;
        const dataRe = /\bdata-([a-z][\w-]*)\b/g;
        while ((dm = dataRe.exec(content)) && dataHooks.size < 20) dataHooks.add(`data-${dm[1]}`);
      }
      const lines = [];
      const uniq = (arr) => Array.from(new Set(arr));
      if (cssPaths.length) lines.push(`Link these stylesheet(s) — single source of truth for all styling: ${uniq(cssPaths).join(', ')}`);
      if (componentScripts.length) lines.push(`Load shared component script(s) (they render the header/nav/footer): ${uniq(componentScripts).join(', ')}`);
      if (dataHooks.size) lines.push(`Shared component placeholders: ${Array.from(dataHooks).slice(0, 8).map((d) => `<div ${d}></div>`).join(' ')}`);
      if (tokens.size) lines.push(`Design tokens (use via var(--name)): ${Array.from(tokens).join(', ')}`);
      if (classes.size) lines.push(`Existing CSS classes (reuse these — do NOT rename or duplicate): ${Array.from(classes).join(', ')}`);
      return lines.join('\n').slice(0, 1800);
    }

    return {
      deriveProjectNameFromTask,
      isAgentTaskGameLike,
      isAgentTaskSoftwareProject,
      isAgentTaskPythonRelated,
      hasReadmeRunInstructions,
      isLikelyCompleteReadme,
      isAgentBudgetTrackerTask,
      isAgentGeneratedContentTarget,
      buildAgentFileGenerationHints,
      isLikelyCompletePythonGameSource,
      parseAgentDecision,
      deriveFallbackAgentDecision,
      parseAgentEditProgram,
      applyAgentEditProgram,
      computeAgentChecklistProgress,
      renderAgentChecklist,
      parseAgentPlanPhases,
      buildAgentPlanMarkdown,
      parseAgentPlanMarkdown,
      firstUnfinishedPhaseIndex,
      buildFallbackExpectedFiles,
      buildAgentProjectContract,
      getPlannedFileRoles,
      shouldFallbackPlanNeedReadme,
      isExplicitReadmeOrDocsTask,
      isDocsOnlyTask,
      isExistingProjectMutationRequest,
      isOpenWorkspaceFollowupMutation,
      normalizeAgentPlanSpec,
      buildFallbackAgentPlanSpec,
      harvestFoundationVocabulary,
    };
  }

  global.AIExeAgentCore = {
    createAgentCore,
  };
})(window);
