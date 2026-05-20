(function initAIExeAgentExecutor(global) {
  function createAgentExecutor(deps) {
    function summarizeWorkspaceListForAgent(rawOutput) {
      let parsed = {};
      try {
        parsed = JSON.parse(String(rawOutput || '{}'));
      } catch (_) {
        return 'Directory listing parse failed.';
      }
      const path = deps.normalizeWorkspacePath(parsed && parsed.path ? parsed.path : '/');
      const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
      if (entries.length === 0) {
        return `Directory ${path} is empty.`;
      }
      const lines = entries.slice(0, 80).map((entry) => {
        const item = deps.mapWorkspaceEntry(entry);
        if (item.kind === 'folder') {
          return `- [dir] ${item.name}/ (${Number(item.childCount) || 0} items)`;
        }
        return `- [file] ${item.name} (${item.size || '0 B'})`;
      });
      if (entries.length > 80) {
        lines.push(`- ... ${entries.length - 80} more entries`);
      }
      return [`Directory ${path}:`, ...lines].join('\n');
    }

    function parseWorkspaceListEntries(rawOutput) {
      try {
        const parsed = JSON.parse(String(rawOutput || '{}'));
        return Array.isArray(parsed && parsed.entries)
          ? parsed.entries.map((entry) => deps.mapWorkspaceEntry(entry)).filter((entry) => entry && entry.path)
          : [];
      } catch (_) {
        return [];
      }
    }

    function isSearchableTextPath(path) {
      const normalized = String(path || '').toLowerCase();
      if (/\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff|mp4|mov|webm|mp3|wav|pdf|zip|gz|tar|7z|dmg|app|exe|dll|so|dylib|bin)$/i.test(normalized)) return false;
      return /\.(html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx|json|md|txt|py|java|c|cc|cpp|cxx|h|hpp|cs|go|rs|php|rb|sh|yml|yaml|xml|svg)$/i.test(normalized);
    }

    function buildSearchNeedles(query) {
      const src = String(query || '').trim();
      const quoted = Array.from(src.matchAll(/["'“”‘’`]([^"'“”‘’`]{3,120})["'“”‘’`]/g))
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
      const lines = src.split(/\n+/).map((line) => line.trim()).filter((line) => line.length >= 3 && line.length <= 120);
      const words = src
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !/^(that|this|with|into|your|from|have|maybe|really|clicked|work|worked|excellent|source|files|search)$/i.test(word));
      return Array.from(new Set([...quoted, ...lines, ...words].map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 24);
    }

    function escapeRegExp(text) {
      return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function basenameForSearch(path) {
      return String(path || '').split('/').filter(Boolean).pop() || '';
    }

    function queryLooksLikeFilenameSearch(query, needles = []) {
      const src = String(query || '');
      if (/(?:^|[\s"'`])(?:\*[\w.*?-]*|\.[a-z0-9]{1,8}\b|[\w.-]+\.(?:html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx|json|md|txt|py)\b)/i.test(src)) {
        return true;
      }
      return needles.some((needle) => {
        const item = String(needle || '').trim();
        return /[*?]/.test(item) || /^\.[a-z0-9]{1,8}$/i.test(item) || /\.[a-z0-9]{1,8}$/i.test(item);
      });
    }

    function filePathMatchesSearchNeedle(filePath, needle, rawQuery = '') {
      const normalizedPath = deps.normalizeWorkspacePath(filePath || '');
      const pathWithoutSlash = normalizedPath.replace(/^\//, '').toLowerCase();
      const basename = basenameForSearch(normalizedPath).toLowerCase();
      const lowerNeedle = String(needle || '').trim().toLowerCase();
      if (!lowerNeedle) return false;
      if (/[*?]/.test(lowerNeedle)) {
        const pattern = `^${escapeRegExp(lowerNeedle)
          .replace(/\\\*/g, '.*')
          .replace(/\\\?/g, '.')}$`;
        try {
          const regex = new RegExp(pattern, 'i');
          return regex.test(basename) || regex.test(pathWithoutSlash);
        } catch (_) {
          return false;
        }
      }
      if (/^\.[a-z0-9]{1,8}$/i.test(lowerNeedle)) {
        return basename.endsWith(lowerNeedle);
      }
      if (/\.[a-z0-9]{1,8}$/i.test(lowerNeedle)) {
        return basename === lowerNeedle || pathWithoutSlash.endsWith(lowerNeedle.replace(/^\//, ''));
      }
      if (/\.[a-z0-9]{1,8}\b/i.test(String(rawQuery || ''))) {
        return basename.includes(lowerNeedle) || pathWithoutSlash.includes(lowerNeedle);
      }
      return false;
    }

    function lineMatchesNeedle(line, needle) {
      const haystack = String(line || '').toLowerCase();
      const lowerNeedle = String(needle || '').toLowerCase();
      if (!lowerNeedle) return false;
      if (haystack.includes(lowerNeedle)) return true;
      const normalizedHaystack = haystack.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      const normalizedNeedle = lowerNeedle.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      return normalizedNeedle.length >= 4 && normalizedHaystack.includes(normalizedNeedle);
    }

    async function collectSearchableWorkspaceFiles(rootPath, maxFiles = 80) {
      const queue = [deps.normalizeWorkspacePath(rootPath || '/') || '/'];
      const files = [];
      const seenDirs = new Set();
      while (queue.length && files.length < maxFiles) {
        const dir = deps.normalizeWorkspacePath(queue.shift() || '/');
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const response = await deps.invokeWorkspaceAction('workspaceList', { path: dir });
        if (!response || !response.ok) continue;
        const entries = parseWorkspaceListEntries(response.output || '');
        entries.forEach((entry) => {
          const path = deps.normalizeWorkspacePath(entry.path || '');
          if (!path || path === '/') return;
          if (entry.kind === 'folder') {
            if (!/\/(?:node_modules|vendor|dist|build|\.git|\.cache)(?:\/|$)/i.test(path)) queue.push(path);
            return;
          }
          if (files.length < maxFiles && isSearchableTextPath(path)) files.push(path);
        });
      }
      return files;
    }

    function validateGeneratedFile(path, content, taskText, planSpec) {
      const normalized = deps.normalizeWorkspacePath(path || '');
      const text = String(content || '');
      const issues = [];
      const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
      const htmlFile = expectedFiles.find((candidate) => /\.html?$/i.test(String(candidate || ''))) || '';
      const cssFile = expectedFiles.find((candidate) => /\.(css|scss|sass|less)$/i.test(String(candidate || ''))) || '';
      const scriptFile = expectedFiles.find((candidate) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(String(candidate || ''))) || '';
      if (/```[a-z0-9_+\-]*|^\s*-\s+(?:Write|Keep|If this|Prefer|Respect|Use|Follow|Never|Do not)\b/im.test(text)) {
        issues.push('contains prompt instructions or markdown fences instead of only file contents');
      }
      if (/\.html?$/i.test(normalized)) {
        if (cssFile && /<style[\s>]/i.test(text)) {
          issues.push(`contains inline <style> content even though ${cssFile} exists`);
        }
        if (scriptFile && /<script(?![^>]*\bsrc=)[\s>]/i.test(text)) {
          issues.push(`contains inline <script> content even though ${scriptFile} exists`);
        }
      }
      if (/\.css$/i.test(normalized)) {
        if (/<\/?(?:html|head|body|script|main|section|div)\b|<!doctype html/i.test(text)) {
          issues.push('contains HTML markup instead of pure CSS');
        }
        const cssSyntaxIssue = getCssSyntaxIssue(text);
        if (cssSyntaxIssue) issues.push(cssSyntaxIssue);
      }
      if (/\.(js|ts|jsx|tsx)$/i.test(normalized)) {
        // Strip template literals and innerHTML/textContent string assignments
        // so that valid JS like `el.innerHTML = '<div>...'` is not flagged.
        const strippedForHtmlCheck = text
          .replace(/`[\s\S]*?`/g, '')           // remove template literals
          .replace(/\.innerHTML\s*=\s*['"][\s\S]*?['"]\s*;/g, '')  // remove innerHTML assignments
          .replace(/\.textContent\s*=\s*['"][\s\S]*?['"]\s*;/g, ''); // remove textContent assignments
        if (/<\/?(?:html|head|body|style)\b|<!doctype html/i.test(strippedForHtmlCheck)) {
          issues.push('contains HTML markup instead of pure JavaScript');
        }
        if (!/\b(import|export)\b/.test(text)) {
          try {
            // Syntax-only check for normal script files.
            // eslint-disable-next-line no-new, no-new-func
            new Function(text);
          } catch (err) {
            issues.push(`has a JavaScript syntax error: ${String(err && err.message ? err.message : err || 'unknown error')}`);
          }
        }
      }
      if (/\.(html|js|ts|jsx|tsx|py)$/i.test(normalized) && !deps.isLikelyCompletePrimarySource(normalized, text, taskText)) {
        issues.push('still looks incomplete for the requested MVP');
      }
      return issues;
    }

    function getCssSyntaxIssue(css) {
      const text = String(css || '');
      const trimmed = text.trim();
      if (!trimmed) return 'is empty';
      if (/^:\s*\/\*/.test(trimmed)) return 'starts with a stray colon before a CSS comment';
      let depth = 0;
      let quote = '';
      let inComment = false;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const next = text[i + 1] || '';
        if (inComment) {
          if (ch === '*' && next === '/') {
            inComment = false;
            i += 1;
          }
          continue;
        }
        if (quote) {
          if (ch === '\\') {
            i += 1;
            continue;
          }
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '/' && next === '*') {
          inComment = true;
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
        if (depth < 0) return 'has an unmatched closing brace';
      }
      if (inComment) return 'has an unterminated CSS comment';
      if (quote) return 'has an unterminated CSS string';
      if (depth > 0) return 'has unclosed CSS blocks';
      if (/[{:;,]$/.test(text.trim().slice(-1))) return 'appears truncated at the end';
      return '';
    }

    function extractHtmlIds(html) {
      return Array.from(String(html || '').matchAll(/\bid=["']([^"']+)["']/gi)).map((match) => String(match[1] || '').trim()).filter(Boolean);
    }

    function extractHtmlDataActions(html) {
      return Array.from(String(html || '').matchAll(/\bdata-action=["']([^"']+)["']/gi)).map((match) => String(match[1] || '').trim()).filter(Boolean);
    }

    function extractHtmlClasses(html) {
      const classes = [];
      for (const match of String(html || '').matchAll(/\bclass=["']([^"']+)["']/gi)) {
        String(match[1] || '').split(/\s+/).forEach((name) => {
          const value = String(name || '').trim();
          if (value) classes.push(value);
        });
      }
      return classes;
    }

    function extractCssClassSelectors(css) {
      const cleaned = String(css || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/url\s*\((?:[^)(]|\([^)(]*\))*\)/gi, ' ')
        .replace(/(["'])(?:\\.|(?!\1)[\s\S])*\1/g, ' ');
      const junkTokens = new Set(['css', 'com', 'http', 'https', 'org', 'svg', 'w3', 'www', 'xmlns']);
      return Array.from(cleaned.matchAll(/(^|[,{>+~\s.])\.([a-z_][a-z0-9_-]*)/gi))
        .map((match) => String(match[2] || '').trim())
        .filter((name) => name && !junkTokens.has(name.toLowerCase()));
    }

    function extractCssIdSelectors(css) {
      return Array.from(String(css || '').matchAll(/#([a-z_][a-z0-9_-]*)/gi))
        .map((match) => String(match[1] || '').trim())
        .filter((id) => {
          if (!id) return false;
          // Ignore typical hex color signatures
          if (/^[0-9a-f]{3}$/i.test(id)) return false;
          if (/^[0-9a-f]{4}$/i.test(id)) return false;
          if (/^[0-9a-f]{6}$/i.test(id)) return false;
          if (/^[0-9a-f]{8}$/i.test(id)) return false;
          return true;
        });
    }

    function extractJsHtmlExpectations(js) {
      const src = String(js || '');
      const createdIds = Array.from(src.matchAll(/(?:\.id\s*=\s*|setAttribute\s*\(\s*['"]id['"]\s*,\s*)['"]([^'"]+)['"]/g))
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
      const createdClasses = [];
      for (const match of src.matchAll(/(?:\.className\s*=\s*|setAttribute\s*\(\s*['"]class['"]\s*,\s*)['"]([^'"]+)['"]/g)) {
        String(match[1] || '').split(/\s+/).forEach((className) => {
          const value = String(className || '').trim();
          if (value) createdClasses.push(value);
        });
      }
      for (const match of src.matchAll(/\bclass\s*=\s*["']([^"']+)["']/g)) {
        String(match[1] || '').split(/\s+/).forEach((className) => {
          const value = String(className || '').trim();
          if (value) createdClasses.push(value);
        });
      }
      const classMutations = [];
      for (const match of src.matchAll(/classList\.(?:add|remove|toggle|contains)\s*\(([^)]*)\)/g)) {
        const args = String(match[1] || '');
        for (const argMatch of args.matchAll(/['"]([^'"]+)['"]/g)) {
          const value = String(argMatch[1] || '').trim();
          if (value) classMutations.push(value);
        }
      }
      return {
        ids: Array.from(src.matchAll(/getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/g)).map((match) => String(match[1] || '').trim()).filter(Boolean),
        dataActions: Array.from(src.matchAll(/\[data-action=["']([^"']+)["']\]/g)).map((match) => String(match[1] || '').trim()).filter(Boolean),
        queriedClasses: Array.from(src.matchAll(/querySelector(?:All)?\s*\(\s*['"]\.([a-z_][a-z0-9_-]*)['"]\s*\)/gi)).map((match) => String(match[1] || '').trim()).filter(Boolean),
        classMutations,
        createdIds,
        createdClasses,
      };
    }

    function validateWebProjectConsistency(fileContents, planSpec) {
      const issues = [];
      const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
      const htmlFile = expectedFiles.find((path) => /\.html?$/i.test(String(path || ''))) || '';
      const cssFile = expectedFiles.find((path) => /\.(css|scss|sass|less)$/i.test(String(path || ''))) || '';
      const scriptFile = expectedFiles.find((path) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(String(path || ''))) || '';
      if (!htmlFile || (!cssFile && !scriptFile)) return issues;
      const html = String(fileContents[htmlFile] || '');
      const css = cssFile ? String(fileContents[cssFile] || '') : '';
      const js = scriptFile ? String(fileContents[scriptFile] || '') : '';
      if (!html) return issues;

      if (cssFile) {
        const cssHref = cssFile.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`href=["'][^"']*${cssHref}["']`, 'i').test(html)) {
          issues.push(`${htmlFile}: does not link ${cssFile}`);
        }
      }
      if (scriptFile) {
        const scriptSrc = scriptFile.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`src=["'][^"']*${scriptSrc}["']`, 'i').test(html)) {
          issues.push(`${htmlFile}: does not load ${scriptFile}`);
        }
      }

      const htmlIds = new Set(extractHtmlIds(html));
      const htmlDataActions = new Set(extractHtmlDataActions(html));
      const htmlClasses = new Set(extractHtmlClasses(html));
      const cssClasses = new Set(extractCssClassSelectors(css));
      const cssIds = new Set(extractCssIdSelectors(css));
      const jsExpectations = extractJsHtmlExpectations(js);
      const pushIssue = (issue) => {
        const text = String(issue || '').trim();
        if (text && !issues.includes(text)) issues.push(text);
      };

      jsExpectations.ids.forEach((id) => {
        if (!htmlIds.has(id) && !jsExpectations.createdIds.includes(id)) {
          pushIssue(`${scriptFile || 'script file'}: references #${id}, but ${htmlFile} does not define that id`);
        }
      });
      jsExpectations.dataActions.forEach((action) => {
        if (!htmlDataActions.has(action)) {
          pushIssue(`${scriptFile || 'script file'}: expects data-action="${action}", but ${htmlFile} does not provide it`);
        }
      });
      jsExpectations.queriedClasses.forEach((className) => {
        if (!htmlClasses.has(className) && !cssClasses.has(className) && !jsExpectations.createdClasses.includes(className)) {
          pushIssue(`${scriptFile || 'script file'}: queries .${className}, but ${htmlFile} does not define that class`);
        }
      });
      jsExpectations.classMutations.forEach((className) => {
        if (!cssClasses.has(className) && !htmlClasses.has(className) && !jsExpectations.createdClasses.includes(className)) {
          pushIssue(`${scriptFile || 'script file'}: toggles .${className}, but neither ${htmlFile} nor ${cssFile || 'stylesheet'} define that class`);
        }
      });

      const unusedCssIds = Array.from(cssIds).filter((id) => !htmlIds.has(id));
      unusedCssIds.slice(0, 4).forEach((id) => {
        pushIssue(`${cssFile || 'stylesheet'}: styles #${id}, but ${htmlFile} does not define that id`);
      });
      const jsUsedClasses = new Set([
        ...jsExpectations.classMutations,
        ...jsExpectations.createdClasses,
        ...jsExpectations.queriedClasses,
      ]);
      const unusedCssClasses = Array.from(cssClasses).filter((className) => !htmlClasses.has(className) && !jsUsedClasses.has(className));
      if (unusedCssClasses.length > Math.max(3, Math.floor(cssClasses.size * 0.35))) {
        pushIssue(`${cssFile || 'stylesheet'}: many class selectors do not match ${htmlFile} (${unusedCssClasses.slice(0, 6).map((name) => `.${name}`).join(', ')})`);
      }
      const importantHtmlClasses = Array.from(htmlClasses).filter((className) => (
        /hero|panel|button|btn|card|section|content|title|subtitle|footer|nav|header|quote|badge|logo|overlay/i.test(className)
      ));
      const unstyledImportantClasses = importantHtmlClasses.filter((className) => !cssClasses.has(className));
      if (css && unstyledImportantClasses.length > 3) {
        pushIssue(`${htmlFile}: important classes are not styled in ${cssFile || 'stylesheet'} (${unstyledImportantClasses.slice(0, 6).map((name) => `.${name}`).join(', ')})`);
      }

      if (cssClasses.has('buttons-grid') && !htmlClasses.has('buttons-grid') && htmlClasses.has('buttons')) {
        pushIssue(`${cssFile || 'stylesheet'}: styles .buttons-grid, but ${htmlFile} uses .buttons for the calculator grid`);
      }
      if (htmlClasses.has('buttons') && !cssClasses.has('buttons') && cssClasses.has('buttons-grid')) {
        pushIssue(`${htmlFile}: uses .buttons, but ${cssFile || 'stylesheet'} only defines .buttons-grid for the button layout`);
      }
      return issues;
    }

    async function executeDeveloperToolCall(chatId, decision, taskText, toolEvents = [], planSpec = null) {
      const tool = String(decision && decision.tool ? decision.tool : '').toLowerCase();
      const taskLower = String(taskText || '').toLowerCase();
      const mustExplicitlyDelete = /\b(delete|remove|trash)\b/.test(taskLower);
      const planExpectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
      const projectTask = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'project';
      const workspaceContext = typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() : null;
      const workspaceStatusSnapshot = typeof deps.requestWorkspaceStatusSnapshot === 'function'
        ? await deps.requestWorkspaceStatusSnapshot()
        : null;
      const rootNode = deps.getWorkspaceTreeState ? deps.getWorkspaceTreeState().get('/') : null;
      const openWorkspaceEntryCount = rootNode && Array.isArray(rootNode.children)
        ? rootNode.children.length
        : 0;
      const normalizedCurrentPath = deps.normalizeWorkspacePath(
        workspaceStatusSnapshot && workspaceStatusSnapshot.ok
          ? (workspaceStatusSnapshot.currentPath || '/')
          : (workspaceContext && workspaceContext.currentPath ? workspaceContext.currentPath : '/')
      );
      const canonicalWorkspaceRootName = String(
        (workspaceStatusSnapshot && workspaceStatusSnapshot.ok
          ? (workspaceStatusSnapshot.rootName || '')
          : (workspaceContext && workspaceContext.workspaceRootName ? workspaceContext.workspaceRootName : '')
        ) || ''
      ).trim();
      const hasOpenWorkspace = Boolean(
        canonicalWorkspaceRootName
        || normalizedCurrentPath !== '/'
      );
      const workspaceCreatedThisTurn = Array.isArray(toolEvents)
        && toolEvents.some((event) => event && event.tool === 'new_project' && event.ok);
      const needsProjectWorkspaceFirst = projectTask && !hasOpenWorkspace && !workspaceCreatedThisTurn;
      const existingProjectMutationRequest = typeof deps.isExistingProjectMutationRequest === 'function'
        ? deps.isExistingProjectMutationRequest(taskText)
        : false;
      const rawSeparateIntent = /\b(new project|new workspace|another project|separate project|different project|start from scratch|from scratch)\b/.test(taskLower);
      const isNegatedSeparateIntent = /\b(no\b|not\b|dont\b|don't\b|never\b|instead of\b).{0,25}?(new project|new workspace|another project|start from scratch)/i.test(taskLower);
      const explicitSeparateWorkspaceIntent = rawSeparateIntent && !isNegatedSeparateIntent;
      const isUnsupportedBinaryAssetPath = (candidatePath) => /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?)$/i.test(String(candidatePath || ''));
      const planAllowsPath = (candidatePath) => {
        const normalized = deps.normalizeWorkspacePath(candidatePath || '');
        if (!normalized || normalized === '/') return true;
        if (!projectTask) return true;
        if (!planExpectedFiles.length) return true;
        if (normalized === '/README.md') return Boolean(planSpec && planSpec.needsReadme);
        return planExpectedFiles.includes(normalized);
      };
      const listedExistingFiles = new Set();
      if (Array.isArray(toolEvents)) {
        toolEvents.forEach((event) => {
          if (!event || !event.ok || String(event.tool || '').toLowerCase() !== 'list_dir') return;
          for (const match of String(event.observation || '').matchAll(/-\s+\[file\]\s+([^\s(]+)/g)) {
            const listedPath = deps.normalizeWorkspacePath(`/${String(match[1] || '').trim()}`);
            if (listedPath && listedPath !== '/') listedExistingFiles.add(listedPath);
          }
        });
      }
      let mutated = false;
      let observation = '';

      if (tool === 'new_project') {
        const alreadyCreatedWorkspace = Array.isArray(toolEvents)
          && toolEvents.some((event) => event && event.tool === 'new_project' && event.ok);
        if (alreadyCreatedWorkspace) {
          return {
            ok: false,
            mutated,
            observation: 'new_project blocked: the workspace for this task was already created. Continue by creating or editing files inside the current workspace instead.',
          };
        }
        const workspaceStateComparison = typeof deps.getWorkspaceStateComparison === 'function'
          ? deps.getWorkspaceStateComparison()
          : null;
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_new_project_workspace_state', {
            chatId: String(chatId || ''),
            hasOpenWorkspace: String(hasOpenWorkspace),
            rootEntryCount: String(openWorkspaceEntryCount),
            workspaceRootName: canonicalWorkspaceRootName,
            currentPath: String(normalizedCurrentPath || '/'),
          }, {
            chatId: String(chatId || ''),
            tool,
            taskText: String(taskText || ''),
            workspaceContext,
            openWorkspaceEntryCount,
            normalizedCurrentPath,
            workspaceStateComparison,
            workspaceStatusSnapshot,
          });
        }
        if (hasOpenWorkspace && canonicalWorkspaceRootName && openWorkspaceEntryCount > 0 && !explicitSeparateWorkspaceIntent) {
          const confirmationMessage = `A project is already open in the workspace explorer (${canonicalWorkspaceRootName}). I can keep working in that project, or create a separate new project if you want. Say "use current project" or "create a new project".`;
          if (typeof deps.recordDebugTrace === 'function') {
            deps.recordDebugTrace('agent_new_project_confirmation_required', {
              chatId: String(chatId || ''),
              workspaceRootName: canonicalWorkspaceRootName,
              taskPreview: deps.debugPreview(taskText, 220),
            }, {
              chatId: String(chatId || ''),
              taskText: String(taskText || ''),
              workspaceContext,
              openWorkspaceEntryCount,
              explicitSeparateWorkspaceIntent,
              confirmationMessage,
            });
          }
          return {
            ok: false,
            mutated,
            requiresProjectScopeConfirmation: true,
            observation: `new_project blocked: an existing non-empty workspace (${canonicalWorkspaceRootName}) is already open, so confirmation is required before creating another project.`,
            userFacingMessage: confirmationMessage,
            workspaceOpen: true,
          };
        }
        const projectName = String(planSpec && planSpec.projectName ? planSpec.projectName : deps.deriveProjectNameFromTask(taskText)).trim();
        const response = await deps.invokeWorkspaceAction('workspaceNewProject', projectName ? { name: projectName } : {});
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `new_project failed: ${(response && response.message) || 'unknown error'}` };
        }
        try {
          const statusRes = await deps.invokeWorkspaceAction('status', {});
          if (statusRes && statusRes.status && statusRes.status.rootPath) {
            const rp = String(statusRes.status.rootPath).replace(/[/\\]+$/, '');
            const rootName = rp ? rp.split(/[/\\]/).pop() || '' : '';
            deps.setWorkspaceRootName(rootName);
            deps.saveWorkspaceRootPath(statusRes.status.rootPath);
          }
        } catch (_) { }
        deps.resetWorkspaceForNewProject();
        mutated = true;
        observation = `new_project ok: workspace root is ${deps.getWorkspaceRootName() || 'new project'}`;
        return { ok: true, mutated, observation };
      }

      if (!hasOpenWorkspace && !workspaceCreatedThisTurn && existingProjectMutationRequest) {
        const confirmationMessage = 'I do not see a project open in the workspace explorer. If you want, I can create a new project for this request, or you can open an existing folder first.';
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_missing_workspace_confirmation_required', {
            chatId: String(chatId || ''),
            tool,
            taskPreview: deps.debugPreview(taskText, 220),
          }, {
            chatId: String(chatId || ''),
            tool,
            taskText: String(taskText || ''),
            workspaceContext,
            confirmationMessage,
          });
        }
        return {
          ok: false,
          mutated,
          requiresUserInput: true,
          observation: `no open workspace found for ${tool}; confirmation is required before creating a new project.`,
          userFacingMessage: confirmationMessage,
        };
      }

      if (tool === 'list_dir') {
        const workspace = deps.getWorkspaceContext();
        const path = deps.normalizeWorkspacePath(decision.path || workspace.currentPath || '/');
        const response = await deps.invokeWorkspaceAction('workspaceList', { path });
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `list_dir failed for ${path}: ${(response && response.message) || 'unknown error'}` };
        }
        observation = summarizeWorkspaceListForAgent(response.output || '');
        return { ok: true, mutated, observation };
      }

      if (tool === 'search_files') {
        const workspace = deps.getWorkspaceContext();
        const path = deps.normalizeWorkspacePath(decision.path || workspace.currentPath || '/');
        const query = String(decision.content || decision.message || taskText || '').trim();
        const needles = buildSearchNeedles(query);
        if (!needles.length) {
          return { ok: false, mutated, observation: 'search_files requires search text in content.' };
        }
        const files = await collectSearchableWorkspaceFiles(path || '/', 80);
        const results = [];
        if (queryLooksLikeFilenameSearch(query, needles)) {
          for (const filePath of files) {
            if (results.length >= 60) break;
            if (!needles.some((needle) => filePathMatchesSearchNeedle(filePath, needle, query))) continue;
            results.push(`- ${filePath}:1: filename match`);
          }
        }
        for (const filePath of files) {
          if (results.length >= 60) break;
          const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path: filePath });
          if (!response || !response.ok) continue;
          const lines = String(response.output || '').split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < 60; i += 1) {
            const line = lines[i];
            if (!needles.some((needle) => lineMatchesNeedle(line, needle))) continue;
            const snippet = line.trim().replace(/\s+/g, ' ').slice(0, 180);
            results.push(`- ${filePath}:${i + 1}: ${snippet || '(blank)'}`);
          }
        }
        observation = [
          `search_files ${path || '/'} for ${JSON.stringify(needles.slice(0, 8).join(' | '))}`,
          results.length ? results.join('\n') : `(no matches in ${files.length} text files)`,
        ].join('\n');
        return { ok: true, mutated, observation };
      }

      if (tool === 'read_file') {
        const path = deps.normalizeWorkspacePath(decision.path || '');
        if (!path || path === '/') {
          return { ok: false, mutated, observation: 'read_file requires a valid file path.' };
        }
        const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `read_file failed for ${path}: ${(response && response.message) || 'unknown error'}` };
        }
        const body = String(response.output || '');
        const clipped = body.length > deps.agentMaxToolOutputChars
          ? `${body.slice(0, deps.agentMaxToolOutputChars)}\n...[truncated]`
          : body;
        deps.syncFileTabFromWorkspaceWrite(path, body, deps.workspaceBaseName(path));
        observation = `read_file ${path}\n${clipped || '(empty file)'}`;
        return { ok: true, mutated, observation, readPath: path, readContent: body };
      }

      if (tool === 'write_file') {
        const path = deps.normalizeWorkspacePath(decision.path || '');
        if (!path || path === '/') {
          return { ok: false, mutated, observation: 'write_file requires a valid file path.' };
        }
        if (projectTask && explicitSeparateWorkspaceIntent && hasOpenWorkspace && !workspaceCreatedThisTurn) {
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: the user asked for a separate new project, so create the new project workspace first with new_project before writing files.`,
          };
        }
        if (needsProjectWorkspaceFirst) {
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: create the project workspace first with new_project, then write the planned files inside it.`,
          };
        }
        if (!planAllowsPath(path)) {
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: this file is outside the current plan. Continue with the planned deliverables instead.`,
          };
        }
        if (isUnsupportedBinaryAssetPath(path)) {
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: this tool can only write text-editable files. Do not create binary image assets here; use CSS, inline SVG, or text placeholders instead.`,
          };
        }
        const creatingNewFile = deps.isLikelyNewAgentFileTarget(toolEvents, path) && !listedExistingFiles.has(path);
        let originalContent = '';
        if (!creatingNewFile) {
          const alreadyReadThisFile = Array.isArray(toolEvents) && toolEvents.some((event) => (
            event
            && event.ok
            && String(event.tool || '').toLowerCase() === 'read_file'
            && deps.normalizeWorkspacePath(event.path || '') === path
          ));
          if (!alreadyReadThisFile) {
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: this file already exists in the current run. Read it first, then use edit_file to change it instead of blindly rewriting it.`,
            };
          }
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: this file already exists in the current run. Use edit_file for repairs or follow-up changes after reading it.`,
          };
        }
        deps.setActiveAgentStreamStatus(chatId, `${creatingNewFile ? 'Writing' : 'Editing'} ${path}...`);
        let content = String(decision.content || '');
        const shouldAutoGenerate = deps.isAgentGeneratedContentTarget(path, taskText);
        if (shouldAutoGenerate) {
          const generated = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, content, planSpec);
          if (generated) content = generated;
        } else if (!String(content).trim()) {
          const generated = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, '', planSpec);
          if (generated) content = generated;
        }
        if (!String(content).trim()) {
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: content is empty. When creating a new file from scratch, use write_file with the complete final contents.`,
          };
        }
        const projectStyleTask = deps.isAgentTaskSoftwareProject(taskText) || /\bcomplete\b/.test(taskLower);
        const gameLikeTask = deps.isAgentTaskGameLike(taskText);
        const primaryTarget = /\.(py|js|ts|jsx|tsx|html)$/i.test(path);
        const cssTarget = /\.css$/i.test(path);
        const pythonTarget = /\.py$/i.test(path);
        const readmeTarget = deps.normalizeWorkspacePath(path) === '/README.md';
        const latestPrimarySourceWrite = deps.getLatestSuccessfulAgentSourceWrite(toolEvents);
        if (
          projectStyleTask
          && readmeTarget
          && !deps.isExplicitReadmeOrDocsTask(taskText)
          && ((planSpec && planSpec.finalRequiresRealFiles) || !planSpec)
          && !latestPrimarySourceWrite
        ) {
          return {
            ok: false,
            mutated,
            observation: `write_file blocked for ${path}: write the main implementation file first, then create the README so it can reference the actual file names and run commands.`,
          };
        }
        if (projectStyleTask && readmeTarget && !deps.isLikelyCompleteReadme(content)) {
          const generated = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, content, planSpec);
          if (generated) content = generated;
          if (!deps.isLikelyCompleteReadme(content)) {
            const strengthened = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, content, planSpec);
            if (strengthened) content = strengthened;
          }
          if (!deps.isLikelyCompleteReadme(content)) {
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: README still looks incomplete. Include a short project description plus clear local setup and run instructions without fake repository URLs.`,
            };
          }
        }
        if (projectStyleTask && cssTarget) {
          let cssIssues = validateGeneratedFile(path, content, taskText, planSpec);
          if (cssIssues.length) {
            const generated = await deps.generateAgentWriteFileContent(
              taskText,
              toolEvents,
              path,
              `Previous CSS failed validation:\n${cssIssues.join('\n')}\n\n${content}`,
              planSpec
            );
            if (generated) content = generated;
            cssIssues = validateGeneratedFile(path, content, taskText, planSpec);
          }
          if (cssIssues.length) {
            const strengthened = await deps.generateAgentWriteFileContent(
              taskText,
              toolEvents,
              path,
              `Rewrite complete valid CSS. Fix:\n${cssIssues.join('\n')}`,
              planSpec
            );
            if (strengthened) content = strengthened;
            cssIssues = validateGeneratedFile(path, content, taskText, planSpec);
          }
          if (cssIssues.length) {
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: generated CSS did not pass validation: ${cssIssues.join('; ')}`,
            };
          }
        }
        if (projectStyleTask && primaryTarget) {
          const shouldUsePythonGameGate = gameLikeTask && pythonTarget;
          const isValidPrimaryContent = shouldUsePythonGameGate
            ? deps.isLikelyCompletePythonGameSource(content)
            : deps.isLikelyCompletePrimarySource(path, content, taskText);
          if (!isValidPrimaryContent) {
            const generated = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, content, planSpec);
            if (generated) content = generated;
          }
          const afterFirstRepair = shouldUsePythonGameGate
            ? deps.isLikelyCompletePythonGameSource(content)
            : deps.isLikelyCompletePrimarySource(path, content, taskText);
          if (!afterFirstRepair) {
            const strengthened = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, content, planSpec);
            if (strengthened) content = strengthened;
          }
          const validAfterExpansion = shouldUsePythonGameGate
            ? deps.isLikelyCompletePythonGameSource(content)
            : deps.isLikelyCompletePrimarySource(path, content, taskText);
          if (!validAfterExpansion) {
            return {
              ok: false,
              mutated,
              observation: shouldUsePythonGameGate
                ? `write_file blocked for ${path}: the content still looks too small or incomplete for a runnable game implementation. Write a real MVP game with a loop, controls, rendering, and state handling.`
                : `write_file blocked for ${path}: the content still looks too small or placeholder-like for a usable project file. Write a real MVP implementation, not a stub.`,
            };
          }
        }
        const parentPath = deps.parentWorkspacePath(path);
        if (parentPath && parentPath !== '/' && parentPath !== '.') {
          const mkdirResponse = await deps.invokeWorkspaceAction('workspaceMkdir', { path: parentPath });
          if (!mkdirResponse || !mkdirResponse.ok) {
            return {
              ok: false,
              mutated,
              observation: `write_file failed for ${path}: could not create parent folder ${parentPath}: ${(mkdirResponse && mkdirResponse.message) || 'unknown error'}`,
            };
          }
        }
        deps.setActiveAgentStreamStatus(chatId, `${creatingNewFile ? 'Creating file' : 'Saving edits to'} ${path}...`);
        const response = await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content });
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `write_file failed for ${path}: ${(response && response.message) || 'unknown error'}` };
        }
        deps.setWorkspaceSelection(path, 'file');
        deps.upsertWorkspaceTreeEntry({
          kind: 'file',
          path,
          name: deps.workspaceBaseName(path),
          sizeBytes: deps.estimateTextBytes(content),
          updatedAt: deps.nowTs(),
          optimisticUntil: deps.nowTs() + 5000,
        });
        deps.syncFileTabFromWorkspaceWrite(path, content, deps.workspaceBaseName(path));
        mutated = true;
        observation = `write_file ok: ${path} (${content.length} chars)`;
        return {
          ok: true,
          mutated,
          observation,
          writtenPath: path,
          writtenContent: content,
          originalContent,
          createdNewFile: creatingNewFile,
        };
      }

      if (tool === 'edit_file') {
        const path = deps.normalizeWorkspacePath(decision.path || '');
        if (!path || path === '/') {
          return { ok: false, mutated, observation: 'edit_file requires a valid file path.' };
        }
        if (needsProjectWorkspaceFirst) {
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: create or open the project workspace first before editing project files.`,
          };
        }
        if (!planAllowsPath(path)) {
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: this file is outside the current plan. Continue with the planned deliverables instead.`,
          };
        }
        if (isUnsupportedBinaryAssetPath(path)) {
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: binary image assets are not editable through this text tool.`,
          };
        }
        if (deps.isLikelyNewAgentFileTarget(toolEvents, path) && !listedExistingFiles.has(path)) {
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: the file is not known yet. Use list_dir/search_files or read_file first; use write_file only when creating a genuinely new file.`,
          };
        }
        const alreadyReadOrWrittenThisFile = Array.isArray(toolEvents) && toolEvents.some((event) => (
          event
          && event.ok
          && ['read_file', 'write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
          && deps.normalizeWorkspacePath(event.path || '') === path
        ));
        if (!alreadyReadOrWrittenThisFile) {
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: read the file first so the edit can target the actual current content.`,
          };
        }
        const readResponse = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
        if (!readResponse || !readResponse.ok) {
          return { ok: false, mutated, observation: `edit_file failed for ${path}: could not read existing file.` };
        }
        const originalContent = String(readResponse.output || '');
        deps.setActiveAgentStreamStatus(chatId, `Editing file ${path}...`);
        let program = deps.parseAgentEditProgram(decision.content || '');
        if (!program) {
          const generated = await deps.generateAgentEditFileProgram(taskText, toolEvents, path, originalContent, decision.content || '', planSpec);
          program = deps.parseAgentEditProgram(generated);
        }
        if (!program) {
          const rewritten = await deps.generateAgentRewriteExistingFileContent(taskText, toolEvents, path, originalContent, decision.content || '', planSpec);
          if (String(rewritten || '').trim() && rewritten !== originalContent) {
            const rewriteResponse = await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content: rewritten });
            if (rewriteResponse && rewriteResponse.ok) {
              deps.setActiveAgentStreamStatus(chatId, `Saving edits to ${path}...`);
              deps.setWorkspaceSelection(path, 'file');
              deps.upsertWorkspaceTreeEntry({
                kind: 'file',
                path,
                name: deps.workspaceBaseName(path),
                sizeBytes: deps.estimateTextBytes(rewritten),
                updatedAt: deps.nowTs(),
                optimisticUntil: deps.nowTs() + 5000,
              });
              deps.syncFileTabFromWorkspaceWrite(path, rewritten, deps.workspaceBaseName(path));
              mutated = true;
              observation = `edit_file ok: ${path} (full-file rewrite fallback)`;
              return {
                ok: true,
                mutated,
                observation,
                writtenPath: path,
                writtenContent: rewritten,
                originalContent,
                createdNewFile: false,
              };
            }
          }
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: invalid edit instructions and rewrite fallback did not succeed.`,
          };
        }
        const applied = deps.applyAgentEditProgram(originalContent, program);
        if (!applied || applied.appliedCount <= 0 || String(applied.output || '') === originalContent) {
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: no edits were applied. Use exact existing text in find/anchor fields.`,
          };
        }
        const response = await deps.invokeWorkspaceAction('workspaceWriteFile', { path, content: applied.output });
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `edit_file failed for ${path}: ${(response && response.message) || 'unknown error'}` };
        }
        deps.setActiveAgentStreamStatus(chatId, `Saving edits to ${path}...`);
        deps.setWorkspaceSelection(path, 'file');
        deps.upsertWorkspaceTreeEntry({
          kind: 'file',
          path,
          name: deps.workspaceBaseName(path),
          sizeBytes: deps.estimateTextBytes(applied.output),
          updatedAt: deps.nowTs(),
          optimisticUntil: deps.nowTs() + 5000,
        });
        deps.syncFileTabFromWorkspaceWrite(path, applied.output, deps.workspaceBaseName(path));
        mutated = true;
        observation = `edit_file ok: ${path} (${applied.appliedCount} edits)`;
        return {
          ok: true,
          mutated,
          observation,
          writtenPath: path,
          writtenContent: applied.output,
          originalContent,
          createdNewFile: false,
        };
      }

      if (tool === 'validate_files') {
        const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
        const targets = expectedFiles.filter((path) => path && path !== '/README.md' && path !== '/src');
        if (!targets.length) {
          return { ok: false, mutated, observation: 'validate_files blocked: there are no planned project files to validate yet.' };
        }
        const issues = [];
        const fileContents = {};
        for (const path of targets) {
          const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
          if (!response || !response.ok) {
            issues.push(`${path}: could not be read for validation`);
            continue;
          }
          const content = String(response.output || '');
          fileContents[path] = content;
          const fileIssues = validateGeneratedFile(path, content, taskText, planSpec);
          fileIssues.forEach((issue) => issues.push(`${path}: ${issue}`));
        }
        const webConsistencyIssues = validateWebProjectConsistency(fileContents, planSpec);
        webConsistencyIssues.forEach((issue) => issues.push(issue));
        if (!issues.length) {
          return {
            ok: true,
            mutated,
            observation: `validate_files ok: no obvious file-role, syntax, or MVP completeness issues found in ${targets.join(', ')}`,
            validationPassed: true,
          };
        }
        return {
          ok: true,
          mutated,
          observation: `validate_files found issues:\n- ${issues.join('\n- ')}\n\nIMPORTANT: Do NOT call validate_files again right now. Read and fix these specific files using edit_file first.`,
          validationPassed: false,
          validationIssues: issues,
        };
      }

      if (tool === 'mkdir') {
        const path = deps.normalizeWorkspacePath(decision.path || '');
        if (!path || path === '/') {
          return { ok: false, mutated, observation: 'mkdir requires a valid folder path.' };
        }
        if (projectTask && explicitSeparateWorkspaceIntent && hasOpenWorkspace && !workspaceCreatedThisTurn) {
          return {
            ok: false,
            mutated,
            observation: `mkdir blocked for ${path}: the user asked for a separate new project, so create the new project workspace first with new_project instead of making folders inside the current workspace.`,
          };
        }
        // Deduplicate: skip if this exact folder was already created successfully this turn
        const alreadyCreated = Array.isArray(toolEvents) && toolEvents.some((e) =>
          e && e.ok && String(e.tool || '').toLowerCase() === 'mkdir'
          && deps.normalizeWorkspacePath(e.path || '') === path
        );
        if (alreadyCreated) {
          return { ok: true, mutated, observation: `mkdir skipped: ${path} was already created this session.` };
        }
        const response = await deps.invokeWorkspaceAction('workspaceMkdir', { path });
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `mkdir failed for ${path}: ${(response && response.message) || 'unknown error'}` };
        }
        deps.setWorkspaceSelection(path, 'folder');
        deps.upsertWorkspaceTreeEntry({
          kind: 'folder',
          path,
          name: deps.workspaceBaseName(path),
          updatedAt: deps.nowTs(),
          childCount: 0,
          optimisticUntil: deps.nowTs() + 5000,
        });
        mutated = true;
        observation = `mkdir ok: ${path}`;
        return { ok: true, mutated, observation };
      }

      if (tool === 'move') {
        const srcPath = deps.normalizeWorkspacePath(decision.srcPath || '');
        const dstPath = deps.normalizeWorkspacePath(decision.dstPath || '');
        if (!srcPath || !dstPath) {
          return { ok: false, mutated, observation: 'move requires valid src_path and dst_path.' };
        }
        if (srcPath === '/' || dstPath === '/') {
          return {
            ok: false,
            mutated,
            observation: 'Cannot move or rename the workspace root (`/`) with move. Choose a different in-workspace path or explain the limitation to the user.',
          };
        }
        const response = await deps.invokeWorkspaceAction('workspaceMove', { srcPath, dstPath });
        if (!response || !response.ok) {
          const reason = String((response && response.message) || 'unknown error');
          const hint = /source path not found/i.test(reason)
            ? ' If the goal is to create a new file from scratch, use write_file with full contents instead of move.'
            : '';
          return { ok: false, mutated, observation: `move failed ${srcPath} -> ${dstPath}: ${reason}.${hint}` };
        }
        deps.setWorkspaceSelection(deps.parentWorkspacePath(dstPath), 'folder');
        deps.removeWorkspaceTreeEntry(srcPath);
        deps.upsertWorkspaceTreeEntry({
          kind: deps.guessWorkspaceTargetKind(dstPath),
          path: dstPath,
          name: deps.workspaceBaseName(dstPath),
          updatedAt: deps.nowTs(),
          optimisticUntil: deps.nowTs() + 5000,
        });
        deps.syncMovedFileTab(srcPath, dstPath);
        mutated = true;
        observation = `move ok: ${srcPath} -> ${dstPath}`;
        return { ok: true, mutated, observation };
      }

      if (tool === 'delete') {
        if (!mustExplicitlyDelete) {
          return {
            ok: false,
            mutated,
            observation: 'delete blocked: user did not explicitly request delete/remove/trash.',
          };
        }
        const path = deps.normalizeWorkspacePath(decision.path || '');
        if (!path || path === '/') {
          return { ok: false, mutated, observation: 'delete requires a valid file/folder path.' };
        }
        const response = await deps.invokeWorkspaceAction('workspaceTrash', { path });
        if (!response || !response.ok) {
          return { ok: false, mutated, observation: `delete failed for ${path}: ${(response && response.message) || 'unknown error'}` };
        }
        deps.setWorkspaceSelection(deps.parentWorkspacePath(path), 'folder');
        deps.removeWorkspaceTreeEntry(path);
        deps.removeWorkspaceTab(path);
        mutated = true;
        observation = `delete ok: moved ${path} to Trash`;
        return { ok: true, mutated, observation };
      }

      return { ok: false, mutated, observation: `Unknown tool "${tool}".` };
    }

    function describeAgentToolPhase(tool, targetInfo, phase = 'start') {
      const name = String(tool || '').toLowerCase();
      const target = String(targetInfo || '').trim();
      const withTarget = (base) => (target ? `${base} ${target}` : base);
      if (phase === 'start') {
        if (name === 'new_project') return 'Creating project workspace';
        if (name === 'list_dir') return withTarget('Scanning folder');
        if (name === 'search_files') return withTarget('Searching files');
        if (name === 'read_file') return withTarget('Reading file');
        if (name === 'write_file') return withTarget('Writing file');
        if (name === 'edit_file') return withTarget('Editing file');
        if (name === 'validate_files') return 'Checking written files';
        if (name === 'mkdir') return withTarget('Creating folder');
        if (name === 'move') return withTarget('Moving');
        if (name === 'delete') return withTarget('Deleting');
        return withTarget(`Running ${name || 'tool'}`);
      }
      if (phase === 'done') return withTarget('Completed');
      return withTarget('Failed');
    }

    return {
      summarizeWorkspaceListForAgent,
      executeDeveloperToolCall,
      describeAgentToolPhase,
    };
  }

  global.AIExeAgentExecutor = {
    createAgentExecutor,
  };
})(window);
