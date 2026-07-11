(function initAIExeAgentExecutor(global) {
  function createAgentExecutor(deps) {
    // Strip placeholder repository URLs / clone commands from a README so an
    // otherwise-complete file the model wrote is not discarded just because it
    // included a fake "github.com/yourusername" link.
    function sanitizeReadmeContent(content) {
      const lines = String(content || '').split(/\r?\n/);
      const cleaned = [];
      for (const line of lines) {
        if (/git\s+clone\s+https?:\/\/github\.com\/yourusername/i.test(line)) continue;
        cleaned.push(
          line
            .replace(/https?:\/\/github\.com\/yourusername[^\s)`'"]*/gi, '')
            .replace(/[ \t]+$/, '')
        );
      }
      return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function summarizeWorkspaceListForAgent(rawOutput) {
      let parsed = {};
      try {
        parsed = JSON.parse(String(rawOutput || '{}'));
      } catch (_) {
        return 'Directory listing parse failed.';
      }
      const path = deps.normalizeWorkspacePath(parsed && parsed.path ? parsed.path : '/');
      const rawEntries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
      const entries = typeof deps.isIgnoredWorkspaceEntryName === 'function'
        ? rawEntries.filter((entry) => {
          const name = String((entry && entry.name) || ((entry && entry.path ? String(entry.path) : '').split('/').filter(Boolean).pop()) || '');
          return !deps.isIgnoredWorkspaceEntryName(name);
        })
        : rawEntries;
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
      // Treat "emoji" as a search intent, not merely the ASCII identifier. Models
      // sometimes emit an enormous pipe-delimited emoji inventory; the old ASCII-only
      // word pass collapsed that whole request to just "emoji", so literal icons in
      // JSX/HTML were invisible. Bound the input and use one sentinel that matches any
      // pictographic emoji instead of carrying thousands of repeated glyphs around.
      const raw = String(query || '').trim();
      const src = raw.slice(0, 2000);
      const wantsEmoji = /\bemojis?\b/i.test(src) || /\p{Extended_Pictographic}/u.test(src);
      const quoted = Array.from(src.matchAll(/["'“”‘’`]([^"'“”‘’`]{3,120})["'“”‘’`]/g))
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
      const lines = src.split(/\n+/).map((line) => line.trim()).filter((line) => line.length >= 3 && line.length <= 120);
      const words = src
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !/^(that|this|with|into|your|from|have|maybe|really|clicked|work|worked|excellent|source|files|search)$/i.test(word));
      return Array.from(new Set([
        ...(wantsEmoji ? ['__aiexe_any_emoji__'] : []),
        ...quoted,
        ...lines,
        ...words,
      ].map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 24);
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
      if (needle === '__aiexe_any_emoji__') {
        return /\p{Extended_Pictographic}/u.test(String(line || ''));
      }
      const haystack = String(line || '').toLowerCase();
      const lowerNeedle = String(needle || '').toLowerCase();
      if (!lowerNeedle) return false;
      if (haystack.includes(lowerNeedle)) return true;
      const normalizedHaystack = haystack.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      const normalizedNeedle = lowerNeedle.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      return normalizedNeedle.length >= 4 && normalizedHaystack.includes(normalizedNeedle);
    }

    function describeSearchNeedle(needle) {
      return needle === '__aiexe_any_emoji__' ? 'emoji characters' : String(needle || '');
    }

    function getRecentSearchHitLines(toolEvents = [], path = '') {
      const normalizedPath = deps.normalizeWorkspacePath(path || '');
      const hitLines = [];
      for (let i = Array.isArray(toolEvents) ? toolEvents.length - 1 : -1; i >= 0; i -= 1) {
        const event = toolEvents[i];
        if (!event || !event.ok || String(event.tool || '').toLowerCase() !== 'search_files') continue;
        const observation = String(event.observation || '');
        for (const match of observation.matchAll(/-\s+(\/[^\s:]+):(\d+):/g)) {
          const matchPath = deps.normalizeWorkspacePath(match[1] || '');
          const lineNumber = Number(match[2]) || 0;
          if (matchPath !== normalizedPath || lineNumber <= 0) continue;
          if (!hitLines.includes(lineNumber)) hitLines.push(lineNumber);
        }
        if (hitLines.length > 0) break;
      }
      return hitLines.slice(0, 6).sort((left, right) => left - right);
    }

    function buildFocusedReadFromLineHits(path, body, hitLines = [], maxChars = 3200) {
      const normalizedPath = deps.normalizeWorkspacePath(path || '');
      const lines = String(body || '').split(/\r?\n/);
      const windows = [];
      hitLines.forEach((lineNumber) => {
        const start = Math.max(1, lineNumber - 8);
        const end = Math.min(lines.length, lineNumber + 12);
        const previous = windows[windows.length - 1];
        if (previous && start <= previous.end + 3) {
          previous.end = Math.max(previous.end, end);
          return;
        }
        windows.push({ start, end });
      });
      const chunks = [];
      let used = 0;
      windows.forEach((window) => {
        if (used >= maxChars) return;
        const rendered = [];
        for (let line = window.start; line <= window.end; line += 1) {
          const marker = hitLines.includes(line) ? '>' : ' ';
          rendered.push(`${marker} ${line}: ${lines[line - 1] || ''}`);
        }
        const chunk = [`${normalizedPath}:${window.start}-${window.end}`, ...rendered].join('\n');
        if (used + chunk.length > maxChars && chunks.length > 0) return;
        chunks.push(chunk.slice(0, Math.max(0, maxChars - used)));
        used += chunk.length + 2;
      });
      if (!chunks.length) return '';
      return [
        `Focused read for ${normalizedPath} around search hit${hitLines.length === 1 ? '' : 's'} ${hitLines.join(', ')}:`,
        chunks.join('\n\n'),
        '',
        `[focused excerpt from ${lines.length} lines; use search_files with a more specific keyword if another area is needed]`,
      ].join('\n');
    }

    function normalizePlanFileList(items) {
      const normalize = typeof deps.normalizeWorkspacePath === 'function'
        ? deps.normalizeWorkspacePath
        : (path) => {
          const clean = String(path || '').replace(/\\/g, '/').trim();
          if (!clean || clean === '/') return '/';
          return `/${clean.split('/').filter((part) => part && part !== '.' && part !== '..').join('/')}`;
        };
      return Array.from(new Set((Array.isArray(items) ? items : [])
        .map((path) => normalize(path || ''))
        .filter((path) => path && path !== '/' && path !== '/src')));
    }

    function getActivePlannedFiles(planSpec) {
      return normalizePlanFileList(planSpec && planSpec.expectedFiles);
    }

    function getAllPlannedFiles(planSpec) {
      const all = normalizePlanFileList(planSpec && planSpec._allExpectedFiles);
      return all.length ? all : getActivePlannedFiles(planSpec);
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

    // Echo applied edits into the observation so the planner doesn't re-read.
    function summarizeAppliedEditsForObservation(program) {
      const edits = Array.isArray(program && program.edits) ? program.edits : [];
      const clip = (value, max) => {
        const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, max)}…` : text;
      };
      const lines = edits.slice(0, 8).map((edit) => {
        const op = String((edit && edit.op) || 'replace');
        const anchor = clip(edit && edit.find, 110);
        const payload = clip(edit && (edit.replace != null ? edit.replace : edit.text), 220);
        return anchor ? `- ${op}: "${anchor}" -> "${payload}"` : `- ${op}: "${payload}"`;
      });
      if (edits.length > 8) lines.push(`- …and ${edits.length - 8} more edits`);
      return lines.join('\n');
    }

    function validateGeneratedFile(path, content, taskText, planSpec) {
      const normalized = deps.normalizeWorkspacePath(path || '');
      const text = String(content || '');
      const issues = [];
      if (/\.html?$/i.test(normalized)) {
        const htmlStructureIssue = getHtmlStructureIssue(text);
        if (htmlStructureIssue) issues.push(htmlStructureIssue);
      }
      if (/\.css$/i.test(normalized)) {
        const cssSyntaxIssue = getCssSyntaxIssue(text);
        if (cssSyntaxIssue) issues.push(cssSyntaxIssue);
      }
      if (/\.(js|ts|jsx|tsx)$/i.test(normalized)) {
        const eslintResult = /\.(js|jsx|mjs|cjs)$/i.test(normalized)
          ? getJsCorrectnessIssues(text)
          : null;
        if (eslintResult) {
          if (eslintResult.syntaxIssue) {
            issues.push(`has a JavaScript syntax error: ${eslintResult.syntaxIssue}`);
          } else {
            issues.push(...eslintResult.issues);
          }
        } else if (/\.(js|mjs|cjs)$/i.test(normalized) && !/\b(import|export)\b/.test(text)) {
          // Last-resort fallback when the bundled parser is unavailable.
          try {
            // eslint-disable-next-line no-new, no-new-func
            new Function(text);
          } catch (err) {
            const syntaxIssue = getJsSyntaxIssue(text, err);
            issues.push(`has a JavaScript syntax error: ${syntaxIssue || String(err && err.message ? err.message : err || 'unknown error')}`);
          }
          const constIssue = getJsReassignedConstIssue(text);
          if (constIssue) issues.push(constIssue);
        }
      }
      // "Looks incomplete" is a subjective heuristic — advisory only, never a
      // blocking issue (it false-flagged a finished 20KB app and looped a run).
      return issues;
    }

    // Tag balance for required-close containers; optional-close tags excluded.
    function getHtmlStructureIssue(html) {
      const text = String(html || '');
      if (!text.trim()) return 'is empty';
      // Content after </html> is invalid — usually raw CSS/JS dumped into the HTML.
      const closeHtmlIdx = text.toLowerCase().lastIndexOf('</html>');
      if (closeHtmlIdx >= 0) {
        const trailing = text.slice(closeHtmlIdx + '</html>'.length).replace(/<!--[\s\S]*?-->/g, ' ').trim();
        if (trailing) {
          const preview = trailing.replace(/\s+/g, ' ').slice(0, 60);
          return `has content after the closing </html> tag ("${preview}${trailing.length > 60 ? '…' : ''}") — likely CSS or JS dumped into the HTML file by mistake`;
        }
      }
      const cleaned = text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
      const strictTags = new Set([
        'div', 'section', 'main', 'header', 'footer', 'article', 'aside', 'nav', 'form',
        'table', 'thead', 'tbody', 'ul', 'ol', 'select', 'button', 'textarea', 'label',
        'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption',
        'dialog', 'details', 'summary', 'fieldset', 'canvas', 'svg', 'video', 'audio',
        'picture', 'iframe', 'html', 'head', 'body',
      ]);
      const counts = {};
      for (const match of cleaned.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9-]*)\b[^>]*?>/gi)) {
        const closing = match[1] === '/';
        const tag = match[2].toLowerCase();
        if (!strictTags.has(tag)) continue;
        if (!closing && /\/\s*>$/.test(match[0])) continue;
        counts[tag] = counts[tag] || { open: 0, close: 0 };
        if (closing) counts[tag].close += 1;
        else counts[tag].open += 1;
      }
      const unbalanced = Object.entries(counts)
        .filter(([, c]) => c.open !== c.close)
        .map(([tag, c]) => `<${tag}> ${c.open} opened vs ${c.close} closed`);
      if (unbalanced.length) return `has unbalanced HTML tags (${unbalanced.slice(0, 4).join('; ')})`;
      // Duplicate ids are invalid and break getElementById wiring (the classic
      // symptom of a model re-adding sections it already added).
      const idCounts = {};
      for (const match of cleaned.matchAll(/\bid=["']([^"']+)["']/gi)) {
        const id = String(match[1] || '').trim();
        if (id) idCounts[id] = (idCounts[id] || 0) + 1;
      }
      const duplicateIds = Object.entries(idCounts).filter(([, n]) => n > 1).map(([id]) => id);
      if (duplicateIds.length) return `has duplicate HTML ids (${duplicateIds.slice(0, 5).map((id) => `#${id}`).join(', ')}) — the same section exists more than once`;
      return '';
    }

    const packageJsonSafeVersions = {
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      '@typescript-eslint/eslint-plugin': '^7.18.0',
      '@typescript-eslint/parser': '^7.18.0',
      '@vitejs/plugin-react': '^4.3.1',
      autoprefixer: '^10.4.20',
      clsx: '^2.1.1',
      'class-variance-authority': '^0.7.0',
      'date-fns': '^3.6.0',
      eslint: '^9.9.0',
      'eslint-plugin-react-hooks': '^5.1.0',
      'eslint-plugin-react-refresh': '^0.4.9',
      'framer-motion': '^11.5.4',
      'lucide-react': '^0.468.0',
      postcss: '^8.4.45',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      'react-router-dom': '^6.26.2',
      tailwindcss: '^3.4.10',
      'tailwind-merge': '^2.5.2',
      typescript: '^5.5.4',
      vite: '^5.4.3',
      zustand: '^4.5.5',
    };

    function isMangledPackageVersion(value) {
      const v = String(value || '').trim();
      return /^\./.test(v)
        || /\d\^|\^\.|\^\^/.test(v)
        || (!/\d/.test(v) && !/^(\*|x|latest|next)$/i.test(v));
    }

    function collectMangledPackageVersions(parsed) {
      const bad = [];
      if (!parsed || typeof parsed !== 'object') return bad;
      ['dependencies', 'devDependencies', 'peerDependencies'].forEach((key) => {
        const section = parsed[key];
        if (!section || typeof section !== 'object') return;
        Object.keys(section).forEach((name) => {
          const v = String(section[name] || '').trim();
          if (isMangledPackageVersion(v)) bad.push(`${name}: "${v}"`);
        });
      });
      return bad;
    }

    function repairPackageJsonDependencyVersions(content) {
      let parsed = null;
      try {
        parsed = JSON.parse(String(content || ''));
      } catch (_) {
        return { content: String(content || ''), repaired: false, remainingBad: [] };
      }
      if (!parsed || typeof parsed !== 'object') {
        return { content: String(content || ''), repaired: false, remainingBad: [] };
      }
      let repaired = false;
      ['dependencies', 'devDependencies', 'peerDependencies'].forEach((key) => {
        const section = parsed[key];
        if (!section || typeof section !== 'object') return;
        Object.keys(section).forEach((name) => {
          if (!isMangledPackageVersion(section[name])) return;
          // Known dep → correct pin. Unknown dep → "latest" (valid + installable): the
          // corruption loses digits so the real version is unrecoverable, and a single
          // unlisted dep must NOT abort the whole repair and hard-reject into a retry loop.
          section[name] = packageJsonSafeVersions[name] || 'latest';
          repaired = true;
        });
      });
      const remainingBad = collectMangledPackageVersions(parsed);
      return {
        content: repaired ? `${JSON.stringify(parsed, null, 2)}\n` : String(content || ''),
        repaired,
        remainingBad,
      };
    }

    // tsconfig noUnusedLocals/noUnusedParameters:true fails the build on any unused
    // import/param. Flip to false (not delete — keeps JSON/JSONC structure intact).
    function scrubTsconfigBuildBreakers(content) {
      const text = String(content || '');
      let changed = false;
      const out = text.replace(/("(?:noUnusedLocals|noUnusedParameters)"\s*:\s*)true\b/g, (m, prefix) => {
        changed = true;
        return `${prefix}false`;
      });
      return { content: out, changed };
    }

    function buildDeterministicPackageJson(path, taskText, planSpec) {
      const normalized = deps.normalizeWorkspacePath(path || '');
      if (!/(?:^|\/)package\.json$/i.test(normalized)) return '';
      const expectedFiles = getAllPlannedFiles(planSpec);
      const hasVite = expectedFiles.some((p) => /(?:^|\/)vite\.config\.[cm]?[jt]s$/i.test(String(p || '')))
        || /(?:^|\s)(vite|react|tsx|typescript)\b/i.test(String(taskText || ''));
      const hasReact = expectedFiles.some((p) => /\.(jsx|tsx)$/i.test(String(p || '')))
        || /\breact\b/i.test(String(taskText || ''));
      if (!hasVite || !hasReact) return '';
      const rawName = String((planSpec && planSpec.projectName) || deps.deriveProjectNameFromTask(taskText) || 'app')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'app';
      return `${JSON.stringify({
        name: rawName,
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'tsc -b && vite build',
          preview: 'vite preview',
        },
        dependencies: {
          react: packageJsonSafeVersions.react,
          'react-dom': packageJsonSafeVersions['react-dom'],
        },
        devDependencies: {
          '@types/react': packageJsonSafeVersions['@types/react'],
          '@types/react-dom': packageJsonSafeVersions['@types/react-dom'],
          '@vitejs/plugin-react': packageJsonSafeVersions['@vitejs/plugin-react'],
          typescript: packageJsonSafeVersions.typescript,
          vite: packageJsonSafeVersions.vite,
        },
      }, null, 2)}\n`;
    }

    // A code file cut mid-statement: ends on an opener/separator, a dangling line
    // continuation, or an unterminated block comment. Catches saves truncated before
    // completion (e.g. vite.config.ts saved ending at "server: {") that .ts/.tsx would
    // otherwise pass silently. Complete files end on } ; ) etc. and don't trip this.
    function looksTruncatedCodeTail(text) {
      const tail = String(text || '').replace(/\s+$/, '');
      if (!tail) return false;
      if (/\\$/.test(tail)) return true;
      if (/[([{,:]$/.test(tail)) return true;
      if ((tail.match(/\/\*/g) || []).length > (tail.match(/\*\//g) || []).length) return true;
      return false;
    }

    // Structural diagnostic per language; empty string = sound.
    function getStructuralIssueForPath(path, content) {
      const normalized = deps.normalizeWorkspacePath(path || '');
      const text = String(content || '');
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized) && text.trim() && looksTruncatedCodeTail(text)) {
        return 'looks truncated — it ends mid-statement (on an opener/separator), so it was cut off before completion; append the remainder so the file is complete';
      }
      if (/\.html?$/i.test(normalized)) return getHtmlStructureIssue(text);
      if (/\.css$/i.test(normalized)) return getCssSyntaxIssue(text);
      if (/\.(js|mjs|cjs)$/i.test(normalized) && !/\b(import|export)\b/.test(text)) {
        try {
          // eslint-disable-next-line no-new, no-new-func
          new Function(text);
        } catch (err) {
          return getJsSyntaxIssue(text, err) || `has a JavaScript syntax error: ${String((err && err.message) || err || 'unknown')}`;
        }
        return '';
      }
      if (/\.json$/i.test(normalized)) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          return `is not valid JSON (${String((err && err.message) || '')})`;
        }
        // package.json: catch clearly-mangled dependency versions ("^1^.2.0" — a real
        // corrupted-generation case) that npm install hard-rejects. High-confidence
        // signals only (digit followed by caret, caret before a dot, or no digit at
        // all); legit ranges like ^18.2.0, ~1.2, >=16, 1.x, * all pass untouched.
        if (/(?:^|\/)package\.json$/i.test(normalized) && parsed && typeof parsed === 'object') {
          const bad = collectMangledPackageVersions(parsed);
          if (bad.length) {
            return `has mangled dependency versions that npm install will reject — ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? ` (+${bad.length - 4} more)` : ''}. Rewrite package.json with real semver versions.`;
          }
        }
      }
      return '';
    }

    // Latest known content of a path from this run's tool history (read/write/edit).
    function getLatestKnownContentForPath(toolEvents, path) {
      const normalized = deps.normalizeWorkspacePath(path || '');
      const events = Array.isArray(toolEvents) ? toolEvents : [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (!event || !event.ok) continue;
        const tool = String(event.tool || '').toLowerCase();
        if (!['read_file', 'write_file', 'edit_file'].includes(tool)) continue;
        if (deps.normalizeWorkspacePath(event.path || '') !== normalized) continue;
        if (typeof event.content === 'string' && event.content) return event.content;
      }
      return '';
    }

    async function readWorkspaceText(path) {
      if (typeof deps.invokeWorkspaceAction !== 'function') return '';
      try {
        const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path: deps.normalizeWorkspacePath(path || '') });
        return response && response.ok ? String(response.output || '') : '';
      } catch (_) {
        return '';
      }
    }

    async function isViteWorkspaceProject() {
      const packageText = await readWorkspaceText('/package.json');
      if (!packageText.trim()) return false;
      if (/"vite"\s*:/.test(packageText) || /"dev"\s*:\s*"[^"]*\bvite\b/i.test(packageText) || /"build"\s*:\s*"[^"]*\bvite\b/i.test(packageText) || /@vitejs\/plugin-/i.test(packageText)) {
        return true;
      }
      const viteTs = await readWorkspaceText('/vite.config.ts');
      const viteJs = viteTs ? '' : await readWorkspaceText('/vite.config.js');
      const viteMjs = (viteTs || viteJs) ? '' : await readWorkspaceText('/vite.config.mjs');
      return Boolean((viteTs || viteJs || viteMjs).trim());
    }

    function commandOutputTail(output, maxChars = 5000) {
      const raw = String(output || '').trim();
      if (!raw) return '';
      return raw.length > maxChars ? `...(truncated)\n${raw.slice(-maxChars)}` : raw;
    }

    function parseRunCommandExitStatus(message) {
      const status = String(message || '');
      if (status === 'timed_out' || /\btimed_out\b/i.test(status)) return { timedOut: true, exitCode: null };
      const exitMatch = status.match(/exit_code=(-?\d+)/);
      return { timedOut: false, exitCode: exitMatch ? Number(exitMatch[1]) : 0 };
    }

    function buildTerminalProof(command, res, status = null, maxPreviewChars = 1600) {
      const parsed = status || parseRunCommandExitStatus(res && res.message);
      const output = String((res && res.output) || '').trim();
      return {
        command: String(command || '').trim(),
        exitCode: parsed.exitCode == null ? null : Number(parsed.exitCode),
        timedOut: Boolean(parsed.timedOut),
        outputPreview: output.length > maxPreviewChars ? `...(truncated)\n${output.slice(-maxPreviewChars)}` : output,
      };
    }

    function splitAgentCommand(rawCommand) {
      return String(rawCommand || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    }

    // Long-running dev servers must not go through the blocking 60s runner —
    // they get started tracked (pid/logs/Stop) and left running. Explicit
    // unambiguous server invocations only; anything else keeps the normal path.
    function isDevServerCommand(program, args) {
      const a = (args || []).map((x) => String(x || '').toLowerCase());
      if (program === 'npm') {
        if (a[0] === 'start') return true;
        if (a[0] === 'run' && ['dev', 'start', 'serve', 'preview'].includes(a[1])) return true;
        return false;
      }
      if (program === 'python') {
        if (a[0] === '-m' && a[1] === 'http.server') return true;
        if (a[0] === '-m' && a[1] === 'flask' && a[2] === 'run') return true;
        if ((a[0] || '').endsWith('manage.py') && a[1] === 'runserver') return true;
        return false;
      }
      if (program === 'php') return a[0] === '-s';
      return false;
    }

    function hasBlockedShellSyntax(command) {
      const text = String(command || '');
      const blockedChars = new Set([';', '&', '|', '`', '<', '>']);
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (blockedChars.has(ch)) return true;
        if (ch === '$' && text[i + 1] === '(') return true;
      }
      return false;
    }

    function classifyAgentCommand(rawCommand) {
      const command = String(rawCommand || '').trim();
      if (!command) {
        return {
          policy: 'blocked',
          command,
          program: '',
          args: [],
          reason: 'run_command needs a command.',
        };
      }

      // This is a command safety boundary, not natural-language intent routing.
      // User intent should be decided semantically by the LLM. Command execution
      // must still be guarded deterministically because shell metacharacters can
      // change the meaning of a command after the model has chosen it.
      if (hasBlockedShellSyntax(command)) {
        return {
          policy: 'blocked',
          command,
          program: '',
          args: [],
          reason: 'shell operators, pipes, redirects, command substitution, and chained commands are blocked. Use one direct command with arguments instead.',
        };
      }

      const parts = splitAgentCommand(command);
      const head = String(parts[0] || '').toLowerCase();
      const ALLOWED = {
        python: 'python',
        python3: 'python',
        pip: 'pip',
        pip3: 'pip',
        node: 'node',
        npm: 'npm',
        php: 'php',
        java: 'java',
        javac: 'javac',
        gcc: 'gcc',
        'g++': 'g++',
        clang: 'clang',
        'clang++': 'clang++',
        go: 'go',
        rustc: 'rustc',
        cargo: 'cargo',
        dotnet: 'dotnet',
      };
      const program = ALLOWED[head];

      if (!program) {
        return {
          policy: 'blocked',
          command,
          program: '',
          args: [],
          reason: `run_command only allows policy-gated direct project commands: python, pip, node, npm, php, java/javac, gcc/g++, clang/clang++, go, rustc/cargo, and dotnet (got "${head}"). Use one direct command with arguments — no raw shell.`,
        };
      }

      const args = parts.slice(1);
      const lowerArgs = args.map((arg) => String(arg || '').toLowerCase());
      const first = lowerArgs[0] || '';
      const second = lowerArgs[1] || '';
      const third = lowerArgs[2] || '';

      const npmAskFirst = program === 'npm' && (
        // deps mutation + anything that fetches-and-RUNS remote code (exec/x/create/init)
        // or publishes outward — none of these may run without the user seeing them.
        ['install', 'i', 'add', 'ci', 'update', 'dedupe', 'uninstall', 'remove', 'rm', 'un', 'prune', 'link', 'exec', 'x', 'create', 'init', 'publish', 'unpublish'].includes(first)
        || (first === 'audit' && second === 'fix')
      );

      const pipAskFirst = program === 'pip' && ['install', 'uninstall', 'download'].includes(first);

      const pythonPipAskFirst = program === 'python'
        && first === '-m'
        && ['pip', 'pip3'].includes(second)
        && ['install', 'uninstall', 'download'].includes(third);

      const goAskFirst = program === 'go' && (
        ['get', 'install'].includes(first)
        || (first === 'mod' && ['tidy', 'download', 'vendor'].includes(second))
      );

      const cargoAskFirst = program === 'cargo' && ['add', 'install', 'update', 'fetch', 'generate-lockfile', 'publish', 'yank', 'login'].includes(first);

      const dotnetAskFirst = program === 'dotnet' && (
        ['restore', 'new'].includes(first)
        || first === 'add'
        || first === 'remove'
        || first === 'nuget'
        || first === 'tool'
      );

      if (npmAskFirst || pipAskFirst || pythonPipAskFirst || goAskFirst || cargoAskFirst || dotnetAskFirst) {
        // "Always allow" — the user promoted this exact command from ask-first.
        const alwaysAllowed = typeof deps.getAlwaysAllowedAgentCommands === 'function'
          ? deps.getAlwaysAllowedAgentCommands() : [];
        if (Array.isArray(alwaysAllowed) && alwaysAllowed.includes(command)) {
          return {
            policy: 'auto_safe',
            command,
            program,
            args,
            reason: 'user chose Always allow for this command.',
          };
        }
        return {
          policy: 'ask_first',
          command,
          program,
          args,
          reason: 'this command can install, remove, restore, or modify dependencies and may use the network or change many files.',
        };
      }

      return {
        policy: 'auto_safe',
        command,
        program,
        args,
        reason: 'safe direct interpreter/package command.',
      };
    }

    // PDF §5: when a runtime/compiler is missing, surface WHAT is missing, WHY it
    // was needed, and the official install source — never a bare "could not run".
    const RUNTIME_INSTALL_GUIDES = {
      python: { name: 'Python', url: 'https://www.python.org/downloads/' },
      pip: { name: 'Python (pip ships with it)', url: 'https://www.python.org/downloads/' },
      node: { name: 'Node.js', url: 'https://nodejs.org/en/download' },
      npm: { name: 'Node.js (npm ships with it)', url: 'https://nodejs.org/en/download' },
      php: { name: 'PHP', url: 'https://www.php.net/downloads' },
      java: { name: 'Java (Temurin JDK)', url: 'https://adoptium.net/temurin/releases/' },
      javac: { name: 'Java (Temurin JDK)', url: 'https://adoptium.net/temurin/releases/' },
      gcc: { name: 'GCC (macOS: run `xcode-select --install`; Windows: MSYS2/MinGW)', url: 'https://gcc.gnu.org/install/' },
      'g++': { name: 'GCC/G++ (macOS: run `xcode-select --install`; Windows: MSYS2/MinGW)', url: 'https://gcc.gnu.org/install/' },
      clang: { name: 'Clang (macOS: run `xcode-select --install`)', url: 'https://releases.llvm.org/' },
      'clang++': { name: 'Clang (macOS: run `xcode-select --install`)', url: 'https://releases.llvm.org/' },
      go: { name: 'Go', url: 'https://go.dev/dl/' },
      rustc: { name: 'Rust (rustup)', url: 'https://rustup.rs' },
      cargo: { name: 'Rust (rustup)', url: 'https://rustup.rs' },
      dotnet: { name: '.NET SDK', url: 'https://dotnet.microsoft.com/download' },
    };

    function isMissingRuntimeMessage(message) {
      return /is not installed( or not on PATH)?\.?/i.test(String(message || ''));
    }

    function buildMissingRuntimeResult(program, rawCommand, mutated, sourceTool = 'run_command') {
      const key = String(program || '').toLowerCase();
      const guide = RUNTIME_INSTALL_GUIDES[key] || { name: program, url: '' };
      const guidance = `\`${program}\` is not installed on this machine (needed to run \`${rawCommand}\`). Install ${guide.name}${guide.url ? ` from ${guide.url}` : ''}, then run this check again.`;
      return {
        ok: true,
        mutated,
        // Not a code error: editing files can't fix a missing runtime, so don't
        // trip the unresolved-run-error finalize blocker. Disclose instead.
        runErrorCount: 0,
        runtimeMissing: true,
        terminalCommand: String(rawCommand || '').trim(),
        terminalProof: {
          command: String(rawCommand || '').trim(),
          exitCode: null,
          timedOut: false,
          outputPreview: guidance,
        },
        observation: `${sourceTool} could not run \`${rawCommand}\`: ${guidance} Do NOT retry the same command. Either ask the user to install it, or finish and clearly state that runtime verification was SKIPPED because ${program} is missing (static validation still applies).`,
      };
    }

    function buildCommandPermissionRequiredResult(rawCommand, classification, mutated, sourceTool = 'run_command') {
      const command = String(rawCommand || '').trim();
      const reason = String((classification && classification.reason) || 'permission is required before running this command');
      return {
        ok: true,
        mutated,
        runErrorCount: 1,
        permissionRequired: true,
        commandPolicy: 'ask_first',
        terminalCommand: command,
        terminalProof: {
          command,
          exitCode: null,
          timedOut: false,
          outputPreview: '',
        },
        observation: `${sourceTool} needs permission before running \`${command}\`: ${reason} Ask the user to approve it, or choose a safe proof command that does not install/remove dependencies.`,
      };
    }

    function looksLikeMissingNodeDependencies(output) {
      const text = String(output || '');
      return /(?:vite|tsc|eslint):\s*(?:command not found|not recognized)|Cannot find module ['"][^'"]*(?:vite|typescript|@vitejs|eslint)|could not determine executable|missing script:\s*build|ENOENT/i.test(text);
    }

    function parseWorkspaceJsonObject(text) {
      try {
        const parsed = JSON.parse(String(text || ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    }

    function normalizeWorkspacePathList(list = []) {
      const out = [];
      const seen = new Set();
      Array.from(list || []).forEach((item) => {
        const normalized = deps.normalizeWorkspacePath(item || '');
        if (!normalized || normalized === '/' || seen.has(normalized)) return;
        seen.add(normalized);
        out.push(normalized);
      });
      return out;
    }

    function plannedFilesFromContract(contract = {}) {
      return normalizeWorkspacePathList([
        ...(Array.isArray(contract && contract.expectedFiles) ? contract.expectedFiles : []),
        ...(Array.isArray(contract && contract.affectedFiles) ? contract.affectedFiles : []),
      ]);
    }

    function toCommandPath(workspacePath) {
      return deps.normalizeWorkspacePath(workspacePath || '').replace(/^\//, '');
    }

    async function firstExistingWorkspaceText(paths = []) {
      for (const path of paths) {
        const text = await readWorkspaceText(path);
        if (String(text || '').trim()) return { path, text };
      }
      return { path: '', text: '' };
    }

    async function detectWorkspaceStack(contract = {}) {
      const plannedFiles = plannedFilesFromContract(contract);
      const packageText = await readWorkspaceText('/package.json');
      const packageJson = parseWorkspaceJsonObject(packageText);
      const packageScripts = packageJson && packageJson.scripts && typeof packageJson.scripts === 'object'
        ? packageJson.scripts
        : {};
      const packageBlob = packageText.toLowerCase();

      const viteConfig = await firstExistingWorkspaceText([
        '/vite.config.ts',
        '/vite.config.js',
        '/vite.config.mjs',
        '/vite.config.cjs',
      ]);

      const hasVite = Boolean(
        viteConfig.path
        || packageBlob.includes('"vite"')
        || packageBlob.includes('@vitejs/')
        || String(packageScripts.dev || '').toLowerCase().includes('vite')
        || String(packageScripts.build || '').toLowerCase().includes('vite')
      );

      if (packageText.trim() || packageJson) {
        if (hasVite) {
          return {
            stack: 'vite',
            label: 'Vite build',
            passLabel: 'Vite build passed',
            failLabel: 'Vite build failed',
            proof: { kind: 'command', command: 'npm run build', installCommand: 'npm install' },
          };
        }

        if (packageScripts.build) {
          return {
            stack: 'node',
            label: 'Node build',
            passLabel: 'Node build passed',
            failLabel: 'Node build failed',
            proof: { kind: 'command', command: 'npm run build', installCommand: 'npm install' },
          };
        }

        if (packageScripts.test) {
          return {
            stack: 'node',
            label: 'Node tests',
            passLabel: 'Node tests passed',
            failLabel: 'Node tests failed',
            proof: { kind: 'command', command: 'npm test', installCommand: 'npm install' },
          };
        }

        const jsEntry = plannedFiles.find((path) => /\.(?:js|mjs|cjs)$/i.test(path));
        if (jsEntry) {
          const rel = toCommandPath(jsEntry);
          return {
            stack: 'node',
            label: 'Node syntax proof',
            passLabel: 'Node syntax proof passed',
            failLabel: 'Node syntax proof failed',
            proof: { kind: 'command', command: `node --check ${rel}` },
          };
        }
      }

      const pythonCandidates = normalizeWorkspacePathList([
        ...plannedFiles.filter((path) => /\.py$/i.test(path)),
        '/main.py',
        '/app.py',
        '/src/main.py',
      ]);

      const pythonFiles = [];
      for (const path of pythonCandidates) {
        if (plannedFiles.includes(path)) {
          pythonFiles.push(path);
          continue;
        }
        const existing = await readWorkspaceText(path);
        if (String(existing || '').trim()) pythonFiles.push(path);
      }

      if (pythonFiles.length > 0) {
        const relFiles = normalizeWorkspacePathList(pythonFiles)
          .map(toCommandPath)
          .filter(Boolean);
        return {
          stack: 'python',
          label: 'Python syntax proof',
          passLabel: 'Python syntax proof passed',
          failLabel: 'Python syntax proof failed',
          proof: { kind: 'command', command: `python -m py_compile ${relFiles.join(' ')}` },
        };
      }

      const phpFiles = normalizeWorkspacePathList([
        ...plannedFiles.filter((path) => /\.php$/i.test(path)),
        '/index.php',
      ]);
      for (const path of phpFiles) {
        if (plannedFiles.includes(path) || String(await readWorkspaceText(path) || '').trim()) {
          return {
            stack: 'php',
            label: 'PHP syntax proof',
            passLabel: 'PHP syntax proof passed',
            failLabel: 'PHP syntax proof failed',
            proof: { kind: 'command', command: `php -l ${toCommandPath(path)}` },
          };
        }
      }

      const javaFiles = normalizeWorkspacePathList(plannedFiles.filter((path) => /\.java$/i.test(path)));
      if (javaFiles.length > 0) {
        return {
          stack: 'java',
          label: 'Java compile proof',
          passLabel: 'Java compile proof passed',
          failLabel: 'Java compile proof failed',
          proof: { kind: 'command', command: `javac ${javaFiles.map(toCommandPath).join(' ')}` },
        };
      }

      const cFiles = normalizeWorkspacePathList(plannedFiles.filter((path) => /\.(?:c|h)$/i.test(path)));
      if (cFiles.some((path) => /\.c$/i.test(path))) {
        return {
          stack: 'c',
          label: 'C syntax proof',
          passLabel: 'C syntax proof passed',
          failLabel: 'C syntax proof failed',
          proof: { kind: 'command', command: `gcc -fsyntax-only ${cFiles.map(toCommandPath).join(' ')}` },
        };
      }

      const cppFiles = normalizeWorkspacePathList(plannedFiles.filter((path) => /\.(?:cc|cpp|cxx|hpp|hh|hxx)$/i.test(path)));
      if (cppFiles.some((path) => /\.(?:cc|cpp|cxx)$/i.test(path))) {
        return {
          stack: 'cpp',
          label: 'C++ syntax proof',
          passLabel: 'C++ syntax proof passed',
          failLabel: 'C++ syntax proof failed',
          proof: { kind: 'command', command: `g++ -fsyntax-only ${cppFiles.map(toCommandPath).join(' ')}` },
        };
      }

      const goMod = await readWorkspaceText('/go.mod');
      const goFiles = normalizeWorkspacePathList(plannedFiles.filter((path) => /\.go$/i.test(path)));
      if (String(goMod || '').trim() || goFiles.length > 0) {
        return {
          stack: 'go',
          label: 'Go test proof',
          passLabel: 'Go test proof passed',
          failLabel: 'Go test proof failed',
          proof: { kind: 'command', command: 'go test -mod=readonly ./...' },
        };
      }

      const cargoToml = await readWorkspaceText('/Cargo.toml');
      const rustFiles = normalizeWorkspacePathList(plannedFiles.filter((path) => /\.rs$/i.test(path)));
      if (String(cargoToml || '').trim()) {
        return {
          stack: 'rust',
          label: 'Rust cargo proof',
          passLabel: 'Rust cargo proof passed',
          failLabel: 'Rust cargo proof failed',
          proof: { kind: 'command', command: 'cargo check --offline --locked' },
        };
      }
      if (rustFiles.length > 0) {
        return {
          stack: 'rust',
          label: 'Rust syntax proof',
          passLabel: 'Rust syntax proof passed',
          failLabel: 'Rust syntax proof failed',
          proof: { kind: 'command', command: `rustc --emit=metadata ${toCommandPath(rustFiles[0])}` },
        };
      }

      const dotnetFiles = normalizeWorkspacePathList(plannedFiles.filter((path) => /\.(?:csproj|sln)$/i.test(path)));
      const existingDotnet = await firstExistingWorkspaceText(['/app.csproj', '/App.csproj']);
      if (dotnetFiles.length > 0 || existingDotnet.path) {
        const target = dotnetFiles[0] || existingDotnet.path || '';
        return {
          stack: 'dotnet',
          label: '.NET build proof',
          passLabel: '.NET build proof passed',
          failLabel: '.NET build proof failed',
          proof: { kind: 'command', command: `dotnet build --no-restore${target ? ` ${toCommandPath(target)}` : ''}` },
        };
      }

      const htmlCandidates = normalizeWorkspacePathList([
        ...plannedFiles.filter((path) => /\.html?$/i.test(path)),
        '/index.html',
      ]);
      for (const path of htmlCandidates) {
        if (plannedFiles.includes(path)) {
          return {
            stack: 'html',
            label: 'HTML smoke run',
            passLabel: 'HTML smoke run passed',
            failLabel: 'HTML smoke run failed',
            proof: { kind: 'smoke', path },
          };
        }
        const existing = await readWorkspaceText(path);
        if (String(existing || '').trim()) {
          return {
            stack: 'html',
            label: 'HTML smoke run',
            passLabel: 'HTML smoke run passed',
            failLabel: 'HTML smoke run failed',
            proof: { kind: 'smoke', path },
          };
        }
      }

      return {
        stack: 'unknown',
        label: 'workspace',
        passLabel: 'Workspace check passed',
        failLabel: 'Workspace check failed',
        proof: null,
      };
    }

    function getCssSyntaxIssue(css) {
      const text = String(css || '');
      const trimmed = text.trim();
      if (!trimmed) return 'is empty';
      if (/^:\s*\/\*/.test(trimmed)) return 'starts with a stray colon before a CSS comment';
      let depth = 0;
      let quote = '';
      let inComment = false;
      let lastSig = ''; // last significant (non-ws) char outside strings/comments
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
        if (ch === '{') {
          // `*, {` / `a, {` — a trailing comma with no selector after it is invalid
          // and silently kills the whole rule (browsers drop it). Catch it.
          if (lastSig === ',') return "has an empty selector (a trailing comma right before '{')";
          depth += 1;
        }
        if (ch === '}') depth -= 1;
        if (depth < 0) return 'has an unmatched closing brace';
        if (!/\s/.test(ch)) lastSig = ch;
      }
      if (inComment) return 'has an unterminated CSS comment';
      if (quote) return 'has an unterminated CSS string';
      if (depth > 0) return 'has unclosed CSS blocks';
      if (/[{:;,]$/.test(text.trim().slice(-1))) return 'appears truncated at the end';
      return '';
    }

    function lineColAt(text, index) {
      const src = String(text || '');
      const pos = Math.max(0, Math.min(src.length, Number(index) || 0));
      let line = 1;
      let col = 1;
      for (let i = 0; i < pos; i += 1) {
        if (src[i] === '\n') {
          line += 1;
          col = 1;
        } else {
          col += 1;
        }
      }
      return { line, col };
    }

    function getJsSyntaxIssue(jsText, parseError = null) {
      const src = String(jsText || '');
      const parseMessage = String(parseError && parseError.message ? parseError.message : parseError || '').trim();
      const stack = [];
      let quote = '';
      let inLineComment = false;
      let inBlockComment = false;
      let inTemplate = false;
      let escaped = false;
      const pairs = { '(': ')', '[': ']', '{': '}' };
      const closers = { ')': '(', ']': '[', '}': '{' };

      for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        const next = src[i + 1] || '';

        if (inLineComment) {
          if (ch === '\n') inLineComment = false;
          continue;
        }
        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            i += 1;
          }
          continue;
        }
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === quote) {
            quote = '';
          }
          continue;
        }
        if (inTemplate) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '`') {
            inTemplate = false;
          }
          continue;
        }
        if (ch === '/' && next === '/') {
          inLineComment = true;
          i += 1;
          continue;
        }
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '`') {
          inTemplate = true;
          continue;
        }
        if (pairs[ch]) {
          stack.push({ ch, index: i });
          continue;
        }
        if (closers[ch]) {
          const expectedOpen = closers[ch];
          const top = stack[stack.length - 1];
          if (!top || top.ch !== expectedOpen) {
            const loc = lineColAt(src, i);
            const found = top ? `expected ${pairs[top.ch]} for ${top.ch} opened at line ${lineColAt(src, top.index).line}` : 'nothing is open here';
            return `${parseMessage || `unexpected ${ch}`} near line ${loc.line}, column ${loc.col} (${found})`;
          }
          stack.pop();
        }
      }

      if (quote) return `${parseMessage || 'unterminated string'} (unterminated ${quote} string)`;
      if (inTemplate) return `${parseMessage || 'unterminated template literal'} (unterminated template literal)`;
      if (inBlockComment) return `${parseMessage || 'unterminated block comment'} (unterminated block comment)`;
      if (stack.length) {
        const top = stack[stack.length - 1];
        const loc = lineColAt(src, top.index);
        return `${parseMessage || `missing ${pairs[top.ch]}`} near end of file (${top.ch} opened at line ${loc.line}, column ${loc.col})`;
      }
      return parseMessage;
    }

    // Scope-aware parser for definite JavaScript runtime errors.
    let agentEslintLinter = null;
    function getJsCorrectnessIssues(jsText) {
      const eslintGlobal = typeof window !== 'undefined' ? window.eslint : null;
      if (!eslintGlobal || typeof eslintGlobal.Linter !== 'function') return null;
      try {
        if (!agentEslintLinter) agentEslintLinter = new eslintGlobal.Linter();
        const rules = {
          'no-const-assign': 'error',
          'constructor-super': 'error',
          'no-this-before-super': 'error',
        };
        const text = String(jsText || '');
        const lint = (sourceType) => agentEslintLinter.verify(text, {
          languageOptions: {
            ecmaVersion: 'latest',
            sourceType,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          rules,
        });
        const sourceTypes = /\b(?:import|export)\b/.test(text) ? ['module', 'script'] : ['script', 'module'];
        let messages = null;
        for (const sourceType of sourceTypes) {
          const attempt = lint(sourceType);
          if (!attempt.some((m) => m && m.fatal)) {
            messages = attempt;
            break;
          }
          if (!messages) messages = attempt;
        }
        const fatal = messages.find((m) => m && m.fatal);
        if (fatal) {
          return {
            issues: [],
            syntaxIssue: `${String(fatal.message || 'invalid syntax').replace(/\.$/, '')} (line ${fatal.line || 1}${fatal.column ? `:${fatal.column}` : ''})`,
          };
        }
        return {
          issues: messages
          .filter((m) => m && !m.fatal)
          .slice(0, 6)
          .map((m) => `${String(m.message || '').replace(/\.$/, '')} (line ${m.line}${m.column ? `:${m.column}` : ''}) — definite runtime error`),
          syntaxIssue: '',
        };
      } catch (_) {
        return null;
      }
    }

    // Regex fallback used only if the bundled parser is unavailable.
    function getJsReassignedConstIssue(jsText) {
      const src = String(jsText || '');
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
      const declCount = {};
      const firstDeclIndex = {};
      const declRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
      let m;
      while ((m = declRe.exec(stripped))) {
        const name = m[1];
        declCount[name] = (declCount[name] || 0) + 1;
        if (firstDeclIndex[name] == null) firstDeclIndex[name] = m.index;
      }
      // Collect EVERY offending variable in one pass: reporting only the first made
      // each repair reveal the next const, burning a full read+edit+validate cycle
      // per variable (row -> castling -> nc treadmill).
      const offenders = [];
      for (const name of Object.keys(firstDeclIndex)) {
        if (declCount[name] > 1) continue;
        // This check is scope-blind: if the same name is ALSO declared with
        // let/var anywhere (shadowing, e.g. `const nc` in one function and
        // `let nr = ..., nc = ...` in another), it cannot tell which binding a
        // later assignment touches — skip rather than flag legal code.
        const letShadowRe = new RegExp(`\\b(?:let|var)\\b[^;\\n]{0,160}?\\b${name}\\b\\s*=`);
        if (letShadowRe.test(stripped)) continue;
        // A bare assignment `name =` (not ==, ===, =>, JSX `prop={...}`, or a
        // property/.name), after the declaration, and not itself a const/let/var
        // declaration.
        const assignRe = new RegExp(`(^|[^.\\w$=!<>])(${name})\\s*=(?![=>])`, 'g');
        let a;
        while ((a = assignRe.exec(stripped))) {
          const nameAt = a.index + a[1].length;
          if (nameAt <= firstDeclIndex[name]) continue;
          const before = stripped.slice(Math.max(0, nameAt - 7), nameAt);
          if (/\b(?:const|let|var)\s*$/.test(before)) continue;
          // Declarator continuation (`const a = 1, name = 2`): if the enclosing
          // statement opens with a declaration keyword, this is a declaration.
          const stmtStart = Math.max(
            stripped.lastIndexOf(';', nameAt),
            stripped.lastIndexOf('{', nameAt),
            stripped.lastIndexOf('}', nameAt),
            stripped.lastIndexOf(')', nameAt),
          );
          if (stmtStart >= 0 && /\b(?:const|let|var)\b/.test(stripped.slice(stmtStart + 1, nameAt))) continue;
          const jsxContext = stripped.slice(Math.max(0, nameAt - 160), nameAt);
          const lastLt = jsxContext.lastIndexOf('<');
          const lastGt = jsxContext.lastIndexOf('>');
          if (lastLt > lastGt && /<[A-Za-z][\w:.-]*(?:\s+[A-Za-z_$][\w$:.:-]*(?:\s*=\s*(?:""|''|\{\}|[^\s>]+))?)*\s*$/s.test(jsxContext.slice(lastLt))) {
            continue;
          }
          offenders.push(name);
          break;
        }
      }
      if (offenders.length === 1) {
        return `reassigns the const variable \`${offenders[0]}\` (declared with const but later assigned — this throws "Assignment to constant variable" at runtime)`;
      }
      if (offenders.length > 1) {
        return `reassigns ${offenders.length} const variables that are later assigned: ${offenders.map((n) => `\`${n}\``).join(', ')} — declare EACH of them with \`let\` instead (const reassignment throws "Assignment to constant variable" at runtime). Fix ALL of them in one edit.`;
      }
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
      // Match EVERY class token, including chained/compound selectors like
      // `.toast.toast-visible` and `.a.b.c`. The previous leading-delimiter form
      // captured only the FIRST class in a chain, so every subsequent class
      // (.toast-visible, .dialog-open, .toast-hiding, …) was falsely reported as
      // "undefined", triggering a phantom repair loop. A class must start with a
      // letter/underscore, so CSS decimals in values (`0.5`, `.25s`) stay excluded.
      return Array.from(cleaned.matchAll(/\.([a-z_][a-z0-9_-]*)/gi))
        .map((match) => String(match[1] || '').trim())
        .filter((name) => name && !junkTokens.has(name.toLowerCase()));
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

    // import name -> pip package (well-known externals only, no stdlib false-positives).
    const PY_THIRD_PARTY = {
      // pygame-ce (community edition) is a drop-in for `import pygame` that keeps
      // up with current Python; the original pygame breaks on 3.13+/3.14.
      pygame: 'pygame-ce', numpy: 'numpy', pandas: 'pandas', requests: 'requests',
      flask: 'flask', django: 'django', fastapi: 'fastapi', uvicorn: 'uvicorn',
      PIL: 'Pillow', cv2: 'opencv-python', matplotlib: 'matplotlib', scipy: 'scipy',
      sklearn: 'scikit-learn', torch: 'torch', tensorflow: 'tensorflow',
      bs4: 'beautifulsoup4', yaml: 'pyyaml', pydantic: 'pydantic',
      sqlalchemy: 'SQLAlchemy', aiohttp: 'aiohttp', rich: 'rich', click: 'click',
      tqdm: 'tqdm', dotenv: 'python-dotenv', openai: 'openai', anthropic: 'anthropic',
      selenium: 'selenium', plotly: 'plotly', seaborn: 'seaborn', kivy: 'kivy',
      pyglet: 'pyglet', arcade: 'arcade', pytest: 'pytest', websockets: 'websockets',
    };

    // Third-party imports not in requirements.txt (the venv won't have them).
    function getPythonMissingDependencies(fileContents, requirementsText) {
      const reqLower = String(requirementsText || '').toLowerCase();
      const missing = new Set();
      Object.keys(fileContents || {}).forEach((path) => {
        if (!/\.py$/i.test(String(path || ''))) return;
        const src = String(fileContents[path] || '');
        for (const m of src.matchAll(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/gm)) {
          const mod = m[1];
          const pkg = PY_THIRD_PARTY[mod];
          if (pkg && !reqLower.includes(pkg.toLowerCase())) missing.add(pkg);
        }
      });
      return Array.from(missing);
    }

    function extractRelativeCodeImports(source) {
      const imports = [];
      const text = String(source || '');
      const patterns = [
        /\bimport\s+(?:[^'"]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
        /\bexport\s+[^'"]+\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
        /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
      ];
      patterns.forEach((pattern) => {
        for (const match of text.matchAll(pattern)) {
          const spec = String(match[1] || '').trim();
          if (spec && !imports.includes(spec)) imports.push(spec);
        }
      });
      return imports;
    }

    function resolveRelativeImportCandidates(fromPath, specifier) {
      const from = deps.normalizeWorkspacePath(fromPath || '');
      let spec = String(specifier || '').split('?')[0].split('#')[0];
      if (!from || !/^\.\.?\//.test(spec)) return [];
      const parts = from.split('/').filter(Boolean);
      parts.pop();
      spec.split('/').forEach((part) => {
        if (!part || part === '.') return;
        if (part === '..') parts.pop();
        else parts.push(part);
      });
      const base = deps.normalizeWorkspacePath(`/${parts.join('/')}`);
      if (/\.[a-z0-9]+$/i.test(base)) return [base];
      return [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.json`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
        `${base}/index.js`,
        `${base}/index.jsx`,
      ];
    }

    function validateWebProjectConsistency(fileContents, planSpec, advisoryOut = null) {
      const issues = [];
      const addAdvisory = (issue) => {
        const text = String(issue || '').trim();
        if (text && Array.isArray(advisoryOut) && !advisoryOut.includes(text)) advisoryOut.push(text);
      };
      const activeExpectedFiles = getActivePlannedFiles(planSpec);
      const allExpectedFiles = getAllPlannedFiles(planSpec);
      const plannedHtmlFiles = allExpectedFiles.filter((path) => /\.html?$/i.test(String(path || '')));
      const activeHtmlFiles = (activeExpectedFiles.some((path) => /\.html?$/i.test(path)) ? activeExpectedFiles : plannedHtmlFiles)
        .filter((path) => /\.html?$/i.test(path) && String(fileContents[path] || '').trim());
      const cssFiles = allExpectedFiles.filter((path) => /\.(css|scss|sass|less)$/i.test(String(path || '')));
      const scriptFiles = allExpectedFiles.filter((path) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(String(path || '')));
      const frameworkWebProject = allExpectedFiles.some((path) => /(?:^|\/)package\.json$/i.test(String(path || '')))
        && (allExpectedFiles.some((path) => /(?:^|\/)vite\.config\.[cm]?[jt]s$/i.test(String(path || '')))
          || scriptFiles.some((path) => /\.(jsx|tsx)$/i.test(String(path || ''))));
      const browserScriptFiles = scriptFiles.filter((path) => {
        const p = String(path || '');
        if (/(?:^|\/)(?:vite|webpack|rollup|postcss|tailwind|eslint)\.config\.[cm]?[jt]s$/i.test(p)) return false;
        if (/(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/i.test(p)) return false;
        if (/\.d\.ts$/i.test(p)) return false;
        return true;
      });
      const cssFile = cssFiles[0] || '';
      const scriptFile = browserScriptFiles.find((path) => /(?:^|\/)src\/main\.(?:jsx|tsx|js|ts)$/i.test(path))
        || browserScriptFiles.find((path) => /(?:^|\/)(?:main|index|app)\.(?:jsx|tsx|js|ts|mjs)$/i.test(path))
        || browserScriptFiles[0]
        || '';
      const sharedComponentScripts = browserScriptFiles.filter((path) => /(?:^|\/)(?:components?|layout|shared|shell)\.[cm]?js$/i.test(path));
      const requiredPageScripts = sharedComponentScripts.length ? sharedComponentScripts : (scriptFile ? [scriptFile] : []);
      if (!activeHtmlFiles.length || (!cssFiles.length && !scriptFiles.length)) return issues;
      const htmlFile = activeHtmlFiles[0] || '';
      const html = String(fileContents[htmlFile] || '');
      const css = cssFile ? String(fileContents[cssFile] || '') : '';
      const js = scriptFile ? String(fileContents[scriptFile] || '') : '';

      activeHtmlFiles.forEach((pagePath) => {
        const pageHtml = String(fileContents[pagePath] || '');
        if (!pageHtml) return;
        if (!frameworkWebProject) {
          cssFiles.forEach((plannedCssFile) => {
            const cssHref = plannedCssFile.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!new RegExp(`href=["'][^"']*${cssHref}["']`, 'i').test(pageHtml)) {
              addAdvisory(`${pagePath}: does not link shared stylesheet ${plannedCssFile}; verify the page has an intentional styling path`);
            }
          });
        }
        if (cssFiles.length && /<style[\s>]/i.test(pageHtml)) {
          addAdvisory(`${pagePath}: has a page-local <style> block while shared CSS exists (${cssFiles.join(', ')}); keep it only if intentional`);
        }
        // Framework SPA (Vite/React): index.html loads ONE bundler entry (/src/main.tsx);
        // pages/components are reached via the JS import graph, not <script src> tags.
        // Requiring each planned script in the HTML is wrong here (caused a validate→edit
        // loop). If it loads any /src module entry, the bundler resolves the rest.
        const loadsSrcModuleEntry = /\bsrc=["'][^"']*\/src\/[A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js|mjs)["']/i.test(pageHtml);
        if (!(frameworkWebProject && loadsSrcModuleEntry)) {
          requiredPageScripts.forEach((plannedScriptFile) => {
            const scriptSrc = plannedScriptFile.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!new RegExp(`src=["'][^"']*${scriptSrc}["']`, 'i').test(pageHtml)) {
              const sharedLabel = sharedComponentScripts.includes(plannedScriptFile)
                ? '; repeated header/nav/footer should come from the shared component source of truth'
                : '';
              addAdvisory(`${pagePath}: does not load ${plannedScriptFile}${sharedLabel}`);
            }
          });
        }
      });

      // Multi-page: check JS refs against the union of all pages' ids/classes.
      const htmlIds = new Set();
      const htmlDataActions = new Set();
      const htmlClasses = new Set();
      for (const page of plannedHtmlFiles) {
        const pageHtml = String(fileContents[page] || '');
        if (!pageHtml) continue;
        extractHtmlIds(pageHtml).forEach((id) => htmlIds.add(id));
        extractHtmlDataActions(pageHtml).forEach((action) => htmlDataActions.add(action));
        extractHtmlClasses(pageHtml).forEach((className) => htmlClasses.add(className));
      }
      const htmlLabel = plannedHtmlFiles.length > 1 ? plannedHtmlFiles.join(', ') : htmlFile;
      const cssClasses = new Set(extractCssClassSelectors(css));
      const jsExpectations = extractJsHtmlExpectations(js);
      jsExpectations.ids.forEach((id) => {
        if (!htmlIds.has(id) && !jsExpectations.createdIds.includes(id)) {
          addAdvisory(`${scriptFile || 'script file'}: references #${id}, but ${htmlLabel} does not define it statically`);
        }
      });
      jsExpectations.dataActions.forEach((action) => {
        if (!htmlDataActions.has(action)) {
          addAdvisory(`${scriptFile || 'script file'}: expects data-action="${action}", but ${htmlLabel} does not provide it statically`);
        }
      });
      jsExpectations.queriedClasses.forEach((className) => {
        if (!htmlClasses.has(className) && !cssClasses.has(className) && !jsExpectations.createdClasses.includes(className)) {
          addAdvisory(`${scriptFile || 'script file'}: queries .${className}, but ${htmlLabel} does not define it statically`);
        }
      });
      // Advisory: root-relative links break when pages are opened from disk
      // (file:// resolves "/x" to the filesystem root) — the offline target.
      if (Array.isArray(advisoryOut)) {
        const rootRelative = Array.from(html.matchAll(/\b(?:href|src)=["'](\/[^"'/][^"']*)["']/gi))
          .map((match) => String(match[1] || ''))
          .filter((url) => !/^\/\//.test(url));
        if (rootRelative.length) {
          addAdvisory(`${htmlFile}: uses root-relative links (${Array.from(new Set(rootRelative)).slice(0, 4).join(', ')}) which break when opened from disk via file:// — use relative paths (e.g. menu.html, ./style.css) instead`);
        }
      }
      // Advisory only (cosmetic, not crash-class): unstyled classes degrade looks
      // but blocking on them trapped runs in repair loops.
      const importantHtmlClasses = Array.from(htmlClasses).filter((className) => (
        /hero|panel|button|btn|card|section|content|title|subtitle|footer|nav|header|quote|badge|logo|overlay/i.test(className)
      ));
      const unstyledImportantClasses = importantHtmlClasses.filter((className) => !cssClasses.has(className));
      if (css && unstyledImportantClasses.length > 3 && Array.isArray(advisoryOut)) {
        addAdvisory(`${htmlFile}: classes used in the markup have no styles in ${cssFile || 'the stylesheet'} (${unstyledImportantClasses.slice(0, 6).map((name) => `.${name}`).join(', ')}) — style them if those sections look unfinished`);
      }
      return issues;
    }

    // Safety net: some models (qwen Hermes/double-escaped output) hand back file
    // content still JSON-escaped — literal \n and \" with no real newlines — which
    // writes the whole file onto one line. Decode it when clearly escaped.
    const decodeEscapedFileContent = (s) => {
      const text = String(s || '');
      const literalEscapes = (text.match(/\\[nt"]/g) || []).length;
      const realNewlines = (text.match(/\n/g) || []).length;
      if (literalEscapes < 3 || realNewlines > 1) return text;
      try {
        const decoded = JSON.parse(`"${text.replace(/\r?\n/g, '\\n')}"`);
        if (decoded && /\n/.test(decoded)) return decoded;
      } catch (_) { /* fall through */ }
      return text
        .replace(/\\\\/g, '\u0000')
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\'/g, "'")
        .replace(/\u0000/g, '\\');
    };
    async function executeDeveloperToolCall(chatId, decision, taskText, toolEvents = [], planSpec = null, runOptions = {}) {
      const tool = String(decision && decision.tool ? decision.tool : '').toLowerCase();
      const taskLower = String(taskText || '').toLowerCase();
      const mustExplicitlyDelete = /\b(delete|remove|trash)\b/.test(taskLower);
      const planExpectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
      const projectTask = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'project';
      const phasedProject = Array.isArray(planSpec && planSpec.phases)
        && planSpec.phases.filter((p) => p && p.title).length >= 2;
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
        if (phasedProject) return true; // model drives file creation per phase
        if (!planExpectedFiles.length) return true;
        if (normalized === '/README.md') return Boolean(planSpec && planSpec.needsReadme);
        // requirements.txt is a standard Python deliverable — the Run button
        // installs it into a venv — so never block it as "outside the plan".
        if (/(^|\/)requirements\.txt$/i.test(normalized)) return true;
        return planExpectedFiles.includes(normalized);
      };
      const listedExistingFiles = new Set();
      if (Array.isArray(toolEvents)) {
        toolEvents.forEach((event) => {
          if (!event || !event.ok) return;
          const eventTool = String(event.tool || '').toLowerCase();
          if (eventTool === 'list_dir') {
            for (const match of String(event.observation || '').matchAll(/-\s+\[file\]\s+([^\s(]+)/g)) {
              const listedPath = deps.normalizeWorkspacePath(`/${String(match[1] || '').trim()}`);
              if (listedPath && listedPath !== '/') listedExistingFiles.add(listedPath);
            }
            return;
          }
          // search hits ("- /path:123:") prove the file exists too
          if (eventTool === 'search_files') {
            for (const match of String(event.observation || '').matchAll(/-\s+([^\s:]+):\d+:/g)) {
              const hitPath = deps.normalizeWorkspacePath(String(match[1] || '').trim());
              if (hitPath && hitPath !== '/') listedExistingFiles.add(hitPath);
            }
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
        // If this chat already did agent workspace work, it owns the open
        // project, so a "new or current?" prompt makes no sense for a follow-up.
        // Silently continue in the current workspace instead of asking.
        const chatOwnsOpenWorkspace = typeof deps.chatHasPriorAgentWorkspaceWork === 'function'
          && deps.chatHasPriorAgentWorkspaceWork(chatId);
        const approvedNewProjectRun = Boolean(runOptions.approvedNewProject || runOptions.skipNewProjectConfirmation);
        if (hasOpenWorkspace && canonicalWorkspaceRootName && openWorkspaceEntryCount > 0 && !explicitSeparateWorkspaceIntent && (chatOwnsOpenWorkspace || runOptions.forceCurrentWorkspace) && !approvedNewProjectRun) {
          return {
            ok: false,
            mutated,
            observation: `new_project blocked: this chat is already working in "${canonicalWorkspaceRootName}". Continue by creating or editing files inside the current workspace instead of starting a new project.`,
          };
        }
        if (hasOpenWorkspace && canonicalWorkspaceRootName && openWorkspaceEntryCount > 0 && !explicitSeparateWorkspaceIntent) {
          if (runOptions.approvedNewProject || runOptions.skipNewProjectConfirmation) {
            if (typeof deps.recordDebugTrace === 'function') {
              deps.recordDebugTrace('agent_new_project_approved', {
                chatId: String(chatId || ''),
                previousWorkspace: canonicalWorkspaceRootName,
              }, { chatId: String(chatId || ''), taskText: String(taskText || '') });
            }
          } else {
            const confirmationMessage = `A project is already open in the workspace explorer (${canonicalWorkspaceRootName}). I can keep working in that project, or create a separate new project if you want.`;
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
        }
        const projectName = String(planSpec && planSpec.projectName ? planSpec.projectName : deps.deriveProjectNameFromTask(taskText)).trim();
        if (hasOpenWorkspace) {
          if (typeof deps.recordDebugTrace === 'function') {
            deps.recordDebugTrace('agent_new_project_closing_workspace', {
              chatId: String(chatId || ''),
              previousWorkspace: canonicalWorkspaceRootName,
              projectName,
            }, { chatId: String(chatId || ''), projectName, taskText: String(taskText || '') });
          }
          const closeRes = await deps.invokeWorkspaceAction('workspaceCloseRoot', {});
          if (typeof deps.recordDebugTrace === 'function') {
            deps.recordDebugTrace('agent_new_project_close_result', {
              chatId: String(chatId || ''),
              ok: String(Boolean(closeRes && closeRes.ok)),
              message: String(closeRes && closeRes.message ? closeRes.message : ''),
            }, { chatId: String(chatId || ''), closeRes });
          }
          if (closeRes && !closeRes.ok) {
            return { ok: false, mutated, observation: `new_project failed: could not close current workspace — ${closeRes.message || 'unknown error'}` };
          }
        }
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_new_project_creating', {
            chatId: String(chatId || ''),
            projectName,
          }, { chatId: String(chatId || ''), projectName, taskText: String(taskText || '') });
        }
        const response = await deps.invokeWorkspaceAction('workspaceNewProject', projectName ? { name: projectName } : {});
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_new_project_create_result', {
            chatId: String(chatId || ''),
            ok: String(Boolean(response && response.ok)),
            projectName,
            message: String(response && response.message ? response.message : ''),
          }, { chatId: String(chatId || ''), response, projectName });
        }
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
        return { ok: true, mutated, observation, projectName: deps.getWorkspaceRootName() || projectName || 'new project' };
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
        let files = await collectSearchableWorkspaceFiles(path || '/', 80);
        if (files.length === 0) {
          const lastSeg = (path || '').split('/').pop();
          if (lastSeg && lastSeg.includes('.')) files = [path];
        }
        const scopeRaw = String(decision.scope || '').trim();
        if (scopeRaw) {
          const scopePath = deps.normalizeWorkspacePath(scopeRaw);
          if (files.includes(scopePath)) {
            files = [scopePath];
          } else {
            const prefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
            files = files.filter((f) => f === scopePath || String(f).startsWith(prefix));
            if (files.length === 0) files = [scopePath];
          }
        }
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
          `search_files ${path || '/'} for ${JSON.stringify(needles.slice(0, 8).map(describeSearchNeedle).join(' | '))}`,
          results.length ? results.join('\n') : `(no matches in ${files.length} text files)`,
        ].join('\n');
        return { ok: true, mutated, observation };
      }

      // Batch read: verify/inspect several known small files in ONE step instead of a
      // separate planner round-trip per file. Each path also registers as an individual
      // read_file event (loop side) so the read/write guards still see them.
      if (tool === 'read_files') {
        // Lenient arg shapes: models put the list in `paths` (array or string),
        // `path`, or `content` — a hard "needs paths" failure poisons the
        // duplicate guard for the whole run, so parse what we can.
        let paths = Array.isArray(decision.paths) ? decision.paths.slice() : [];
        if (!paths.length && typeof decision.paths === 'string' && decision.paths.trim()) {
          paths = decision.paths.split(/[|,\n]+/);
        }
        if (!paths.length && typeof decision.path === 'string' && decision.path.trim()) {
          paths = decision.path.split(/[|,\n]+/);
        }
        if (!paths.length && typeof decision.content === 'string' && decision.content.trim()) {
          const rawList = decision.content.trim();
          try {
            const parsed = JSON.parse(rawList);
            if (Array.isArray(parsed)) paths = parsed;
          } catch (_) { /* not JSON — try list split below */ }
          if (!paths.length && /[/.]/.test(rawList) && rawList.length < 2000) {
            paths = rawList.replace(/^\[|\]$/g, '').split(/[|,\n"']+/);
          }
        }
        paths = Array.from(new Set(paths
          .map((p) => deps.normalizeWorkspacePath(String(p || '').trim()))
          .filter((p) => p && p !== '/')));
        if (!paths.length) {
          return { ok: false, mutated, observation: 'read_files needs a "paths" array of file paths. To read one file use read_file.' };
        }
        const maxFiles = 10;
        const overflow = paths.slice(maxFiles);
        paths = paths.slice(0, maxFiles);
        const perFileCap = Math.max(1200, Math.floor(deps.agentMaxToolOutputChars / (paths.length + 1)));
        const sections = [];
        const readFilesResult = [];
        for (const p of paths) {
          const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path: p });
          if (!response || !response.ok) {
            sections.push(`### ${p}\nread failed: ${(response && response.message) || 'not found'}`);
            continue;
          }
          const body = String(response.output || '');
          deps.syncFileTabFromWorkspaceWrite(p, body, deps.workspaceBaseName(p));
          readFilesResult.push({ path: p, content: body });
          if (body.length > perFileCap) {
            sections.push(`### ${p} (${body.length} chars — showing first ${perFileCap}; call read_file "${p}" for the whole file)\n${body.slice(0, perFileCap)}\n...[truncated preview]`);
          } else {
            sections.push(`### ${p}\n${body || '(empty file)'}`);
          }
        }
        const overflowNote = overflow.length
          ? `\n\n[${overflow.length} more path(s) not read — read_files caps at ${maxFiles} per call: ${overflow.join(', ')}]`
          : '';
        observation = `read_files (${paths.length} file${paths.length === 1 ? '' : 's'}):\n\n${sections.join('\n\n')}${overflowNote}`;
        return { ok: true, mutated, observation, readFilesResult };
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
        const requestedLimit = Number(decision.limit || 0);
        const cap = requestedLimit > 0 ? Math.min(requestedLimit, deps.agentMaxToolOutputChars) : deps.agentMaxToolOutputChars;
        const rawOffset = Number(decision.offset || 0);
        const charOffset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
        const startLine = Number(decision.start_line || 0);
        const endLine = Number(decision.end_line || 0);
        let slice = body;
        let rangeNote = '';
        let lineMode = false;
        let fromLine = 0;
        let totalLines = 0;
        let continuationHint = '';
        if (startLine > 0) {
          const lines = body.split(/\r?\n/);
          totalLines = lines.length;
          fromLine = Math.max(0, startLine - 1);
          const maxLinesPerRead = Math.max(1, Math.min(Number(decision.limit_lines || 200), 400));
          const requestedTo = endLine > 0 ? Math.min(totalLines, endLine) : totalLines;
          const cappedTo = Math.min(requestedTo, fromLine + maxLinesPerRead);
          slice = lines.slice(fromLine, cappedTo).join('\n');
          rangeNote = ` (lines ${fromLine + 1}–${cappedTo} of ${totalLines})`;
          lineMode = true;
          if (cappedTo < totalLines) {
            const nextStart = cappedTo + 1;
            const nextEnd = Math.min(totalLines, nextStart + maxLinesPerRead - 1);
            continuationHint = `\n...[file continues — call read_file with start_line:${nextStart} end_line:${nextEnd} (total ${totalLines} lines)]`;
          }
        } else if (charOffset > 0) {
          slice = body.slice(charOffset);
          rangeNote = ` (chars ${charOffset}–${Math.min(charOffset + cap, body.length)} of ${body.length})`;
        }
        const searchHitLines = !lineMode && charOffset === 0 ? getRecentSearchHitLines(toolEvents, path) : [];
        const focusedRead = !lineMode && slice.length > cap && searchHitLines.length > 0
          ? buildFocusedReadFromLineHits(path, slice, searchHitLines, cap)
          : '';
        const isTruncated = !lineMode && !focusedRead && slice.length > cap;
        const chunk = isTruncated ? slice.slice(0, cap) : slice;
        if (isTruncated) {
          const nextOffset = charOffset + chunk.length;
          continuationHint = `\n\n[PARTIAL PREVIEW ONLY: ${path} continues after this point. This is NOT end-of-file and does NOT mean the file is truncated. The full file has ${body.length} chars. If you need more, call read_file with offset:${nextOffset}.]`;
        }
        const clipped = focusedRead
          ? `${focusedRead}\n\n[FOCUSED EXCERPT ONLY: this is not the whole file. Do not infer truncation from this excerpt.]`
          : (chunk + continuationHint);
        deps.syncFileTabFromWorkspaceWrite(path, body, deps.workspaceBaseName(path));
        observation = `read_file ${path}${rangeNote}\n${clipped || '(empty file)'}`;
        return { ok: true, mutated, observation, readPath: path, readContent: body };
      }

      // Single-pass project generation: one model call emits all files (like chat),
      // then we write them. Avoids the slow, stall-prone per-file pipeline.
      if (tool === 'generate_project') {
        if (typeof deps.generateAgentProjectFiles !== 'function') {
          return { ok: false, mutated, observation: 'generate_project is not available in this build.' };
        }
        deps.setActiveAgentStreamStatus(chatId, 'Generating all project files in one pass...');
        const files = await deps.generateAgentProjectFiles(taskText, planSpec);
        const written = [];
        const skipped = [];
        for (const f of (Array.isArray(files) ? files : [])) {
          const fpath = deps.normalizeWorkspacePath(f && f.path || '');
          const fcontent = decodeEscapedFileContent(String(f && f.content || ''));
          if (!fpath || fpath === '/' || !fcontent.trim()) continue;
          if (!planAllowsPath(fpath)) { skipped.push(`${fpath} (outside plan)`); continue; }
          const parent = deps.parentWorkspacePath(fpath);
          if (parent && parent !== '/' && parent !== '.') {
            await deps.invokeWorkspaceAction('workspaceMkdir', { path: parent });
          }
          const resp = await deps.invokeWorkspaceAction('workspaceWriteFile', { path: fpath, content: fcontent });
          if (resp && resp.ok) {
            mutated = true;
            const issue = getStructuralIssueForPath(fpath, fcontent);
            written.push(`${fpath} (${fcontent.length} chars${issue ? `, WARNING: ${issue}` : ''})`);
            deps.upsertWorkspaceTreeEntry({
              kind: 'file', path: fpath, name: deps.workspaceBaseName(fpath),
              sizeBytes: deps.estimateTextBytes(fcontent), updatedAt: deps.nowTs(), optimisticUntil: deps.nowTs() + 5000,
            });
            deps.syncFileTabFromWorkspaceWrite(fpath, fcontent, deps.workspaceBaseName(fpath));
          } else {
            skipped.push(`${fpath} (write failed)`);
          }
        }
        if (!written.length) {
          return { ok: false, mutated, observation: 'generate_project produced no usable files — fall back to creating each file with write_file.' };
        }
        deps.setWorkspaceSelection(written.length ? deps.normalizeWorkspacePath((files[0] || {}).path || '/') : '/', 'file');
        return {
          ok: true,
          mutated,
          observation: `generate_project wrote ${written.length} file(s):\n- ${written.join('\n- ')}${skipped.length ? `\nSkipped: ${skipped.join(', ')}` : ''}\nNow run validate_files; create any remaining planned file with write_file.`,
        };
      }

      if (tool === 'write_file') {
        let path = deps.normalizeWorkspacePath(decision.path || '');
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
        // PDF/Office docs are binary formats the text writer can't author. Save a
        // print-ready HTML instead (the user gets a real PDF via the browser's
        // Save-as-PDF). The generation prompt produces HTML for these requests.
        let docRedirectNote = '';
        const sheetBin = path.match(/\.(?:xlsx?|ods)$/i);
        const docBin = path.match(/\.(?:pdf|docx?|rtf|odt|pptx?)$/i);
        if (sheetBin) {
          const ext = sheetBin[0].slice(1).toUpperCase();
          path = `${path.slice(0, -sheetBin[0].length)}.csv`;
          docRedirectNote = `\nNote: ${ext} is a binary spreadsheet format that can't be authored as text, so it was saved as ${path} — a CSV that opens directly in Excel/Google Sheets. Write comma-separated rows with a header row.`;
        } else if (docBin) {
          const ext = docBin[0].slice(1).toUpperCase();
          path = `${path.slice(0, -docBin[0].length)}.html`;
          docRedirectNote = `\nNote: ${ext} is a binary format that can't be authored as text, so it was saved as ${path} — a print-ready HTML document. The user opens it and uses the "Save as PDF" button (or Ctrl+P → Save as PDF) to get a ${ext}.`;
        }
        const creatingNewFile = deps.isLikelyNewAgentFileTarget(toolEvents, path) && !listedExistingFiles.has(path);
        let originalContent = '';
        if (!creatingNewFile) {
          // Replacing a tiny stub this run wrote with substantially more content is
          // legitimate expansion (e.g. a 1-line README that final_check flagged
          // incomplete), not a blind rewrite — blocking it deadlocked stub recovery.
          const lastOwnWrite = Array.isArray(toolEvents)
            ? [...toolEvents].reverse().find((e) => (
              e && e.ok && String(e.tool || '').toLowerCase() === 'write_file'
              && deps.normalizeWorkspacePath(e.path || '') === path
            ))
            : null;
          const stubLen = lastOwnWrite && typeof lastOwnWrite.writtenContent === 'string'
            ? lastOwnWrite.writtenContent.length
            : Number((String((lastOwnWrite && lastOwnWrite.observation) || '').match(/\((\d+)\s*chars\)/) || [])[1] ?? -1);
          const newLen = String(decision.content || '').length;
          const expandingOwnStub = stubLen >= 0 && stubLen < 200 && (newLen === 0 || newLen > Math.max(200, stubLen * 2));
          const alreadyReadThisFile = Array.isArray(toolEvents) && toolEvents.some((event) => (
            event
            && event.ok
            && String(event.tool || '').toLowerCase() === 'read_file'
            && deps.normalizeWorkspacePath(event.path || '') === path
          ));
          if (!alreadyReadThisFile && !expandingOwnStub) {
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: this file already exists in the current run. Read it first, then use edit_file to change it instead of blindly rewriting it.`,
            };
          }
          const editFailCount = Array.isArray(toolEvents) ? toolEvents.filter((e) => (
            e && !e.ok
            && String(e.tool || '').toLowerCase() === 'edit_file'
            && deps.normalizeWorkspacePath(e.path || '') === path
          )).length : 0;
          // A full rewrite is legitimate recovery once an edit attempt on this file
          // failed, or when the file's current content is structurally broken.
          const knownContent = getLatestKnownContentForPath(toolEvents, path);
          const currentlyBroken = Boolean(knownContent && getStructuralIssueForPath(path, knownContent));
          if (editFailCount < 1 && !currentlyBroken && !expandingOwnStub) {
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: this file already exists in the current run. Use edit_file for repairs or follow-up changes after reading it.`,
            };
          }
        }
        if (!creatingNewFile) {
          // Capture the pre-overwrite content: it grounds the revert snapshot,
          // the per-response diff stats, and the completion CHANGES diffs.
          const currentRead = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
          if (currentRead && currentRead.ok) originalContent = String(currentRead.output || '');
        }
        deps.setActiveAgentStreamStatus(chatId, `${creatingNewFile ? 'Writing' : 'Editing'} ${path}...`);
        let content = decodeEscapedFileContent(String(decision.content || ''));
        const shouldAutoGenerate = deps.isAgentGeneratedContentTarget(path, taskText);
        const initialInlineContent = content;
        const packageJsonTarget = /(?:^|\/)package\.json$/i.test(path);
        let primaryQualityNote = '';
        if (packageJsonTarget && !String(content || '').trim()) {
          const deterministicPackage = buildDeterministicPackageJson(path, taskText, planSpec);
          if (deterministicPackage) {
            content = deterministicPackage;
            primaryQualityNote = ' Note: generated deterministic Vite React package.json.';
          }
        }
        const inlineStructureIssue = String(content).trim() ? getStructuralIssueForPath(path, content) : '';
        // Trust non-trivial, structurally-valid content the model already supplied.
        // A retry decision may include a complete corrected file; discarding it and
        // auto-generating again is what caused the visible write/rewrite loop.
        const modelSuppliedComplete = shouldAutoGenerate
          && content.trim().length >= (packageJsonTarget ? 20 : 80)
          && !inlineStructureIssue;
        let structuralRepairAttempted = false;
        const repairStructuralIssueOnce = async (stageLabel) => {
          const issue = getStructuralIssueForPath(path, content);
          if (!issue || !shouldAutoGenerate) return '';
          structuralRepairAttempted = true;
          const prior = [
            `Previous ${stageLabel || 'generation'} for ${path} failed structural validation: ${issue}.`,
            'Return the COMPLETE corrected file content only. Fix the exact syntax/structure problem; do not restart with a reduced stub.',
            '',
            'BROKEN_CONTENT:',
            String(content || '').slice(0, 18000),
          ].join('\n');
          if (typeof deps.recordDebugTrace === 'function') {
            deps.recordDebugTrace('agent_write_structural_repair_attempt', {
              path, issue: String(issue).slice(0, 200), stage: String(stageLabel || ''),
              len: String(String(content || '').length),
            }, { path, issue, stage: stageLabel, len: String(content || '').length });
          }
          const generated = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, prior, planSpec);
          if (generated) content = generated;
          return getStructuralIssueForPath(path, content);
        };
        if (shouldAutoGenerate && !modelSuppliedComplete && !(packageJsonTarget && String(content).trim())) {
          const generated = await deps.generateAgentWriteFileContent(taskText, toolEvents, path, content, planSpec);
          if (generated) content = generated;
          await repairStructuralIssueOnce('initial generated content');
        } else if (!shouldAutoGenerate && !String(content).trim()) {
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
        if (readmeTarget) {
          // Trust the model's README the way chat mode does. The only safe,
          // non-destructive cleanup is stripping invented placeholder repo URLs.
          // Never block, regenerate, or halt the run over a keyword "completeness"
          // heuristic — that discards good content the model wrote correctly.
          const sanitized = sanitizeReadmeContent(content);
          if (sanitized) content = sanitized;
        }
        if (projectStyleTask && cssTarget && !modelSuppliedComplete && !structuralRepairAttempted && !getStructuralIssueForPath(path, content)) {
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
            await repairStructuralIssueOnce('CSS validation repair');
            cssIssues = validateGeneratedFile(path, content, taskText, planSpec);
          }
          // Advisory, not a veto: write the stylesheet and flag any remaining
          // concern instead of discarding the model's work or halting the run.
          if (cssIssues.length) {
            primaryQualityNote = ` Note: the generated CSS may still have issues (${cssIssues.join('; ')}); refine it with an edit pass if the page looks off.`;
          }
        }
        if (projectStyleTask && primaryTarget && !modelSuppliedComplete && !structuralRepairAttempted && !getStructuralIssueForPath(path, content)) {
          const shouldUsePythonGameGate = gameLikeTask && pythonTarget;
          const isValidPrimaryContent = shouldUsePythonGameGate
            ? deps.isLikelyCompletePythonGameSource(content)
            : deps.isLikelyCompletePrimarySource(path, content, taskText);
          if (!isValidPrimaryContent) {
            // Advisory only: do not launch another full-file generation here.
            // Large JS files were being generated, judged "thin", regenerated from
            // scratch, judged again, then regenerated a third time inside one
            // write_file call. That made the visible stream look like it kept
            // restarting and could burn the whole tool timeout before saving.
            if (typeof deps.recordDebugTrace === 'function') {
              deps.recordDebugTrace('agent_primary_completeness_advisory', {
                path,
                chars: String(String(content || '').length),
              }, { path, taskText, contentPreview: String(content || '').slice(0, 1200) });
            }
            primaryQualityNote = shouldUsePythonGameGate
              ? ' Note: this still looks small for a runnable game; expand it (loop, controls, rendering, state) if the request needs more.'
              : ' Note: this looks thin for a usable project file; expand it into a real MVP if the request needs more than a stub.';
          }
        }
        // Save a fresh file even if it's incomplete — never discard generated work;
        // the WARNING below + a continuation pass finish it from the saved state.
        // Only block a structure-breaking EDIT that would corrupt an existing good file.
        if (/(?:^|\/)package\.json$/i.test(path)) {
          const repairedPackage = repairPackageJsonDependencyVersions(content);
          if (repairedPackage.repaired && !repairedPackage.remainingBad.length) {
            content = repairedPackage.content;
            primaryQualityNote = `${primaryQualityNote} Note: repaired mangled package.json dependency versions before saving.`;
            if (typeof deps.recordDebugTrace === 'function') {
              deps.recordDebugTrace('agent_package_json_versions_repaired', {
                path,
                chars: String(content.length),
              }, { path, contentPreview: content.slice(0, 1400) });
            }
          }
        }
        if (/(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/i.test(path)) {
          const scrubbed = scrubTsconfigBuildBreakers(content);
          if (scrubbed.changed) {
            content = scrubbed.content;
            primaryQualityNote = `${primaryQualityNote} Note: disabled noUnusedLocals/noUnusedParameters in ${path} so an unused import can't fail the build.`;
            if (typeof deps.recordDebugTrace === 'function') {
              deps.recordDebugTrace('agent_tsconfig_build_breakers_scrubbed', {
                path,
              }, { path, contentPreview: content.slice(0, 800) });
            }
          }
        }
        const newContentStructureIssue = getStructuralIssueForPath(path, content);
        if (newContentStructureIssue) {
          const priorKnownContent = creatingNewFile ? '' : getLatestKnownContentForPath(toolEvents, path);
          const priorBroken = Boolean(priorKnownContent && getStructuralIssueForPath(path, priorKnownContent));
          if (typeof deps.recordDebugTrace === 'function') {
            const c = String(content || '');
            deps.recordDebugTrace('agent_write_structural_issue', {
              path, issue: String(newContentStructureIssue).slice(0, 200),
              len: String(c.length), creatingNewFile: String(creatingNewFile),
              action: creatingNewFile ? 'saved_incomplete' : (priorBroken ? 'saved_repair' : 'blocked_edit'),
              tail: deps.debugPreview(c.slice(-160), 160),
            }, { path, issue: newContentStructureIssue, len: c.length, tail: c.slice(-300) });
          }
          if (!creatingNewFile && !priorBroken) {
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: the new content ${newContentStructureIssue}. The existing file was kept. Use edit_file for a targeted change instead of rewriting the whole file.`,
            };
          }
          // Mangled semver is mid-file corruption, NOT truncation — the save-and-append
          // flow below can't fix it (the corrupted prefix stays). Reject so the next step
          // is a FRESH write_file generation instead of a doomed continuation.
          if (creatingNewFile && /mangled dependency versions/.test(newContentStructureIssue)) {
            return {
              ok: false,
              mutated,
              observation: `write_file rejected for ${path}: the generated content ${newContentStructureIssue} Nothing was saved. Call write_file for ${path} again with freshly generated content — every dependency version must be plain semver such as "^18.3.1".`,
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
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_write_apply', {
            path,
            createdNew: String(creatingNewFile),
            contentSource: shouldAutoGenerate || !String(decision.content || '').trim() ? 'generated' : 'inline-decision',
            chars: String(content.length),
            originalLen: String(originalContent.length),
            structuralIssue: String(newContentStructureIssue || 'none'),
          }, { path });
        }
        observation = `write_file ok: ${path} (${content.length} chars)${primaryQualityNote}${docRedirectNote}\nThe saved file matches the generated content exactly — do not re-read ${path} to verify.${newContentStructureIssue ? `\nWARNING: the saved file looks incomplete — it ${newContentStructureIssue}. Continue it from where it ends by APPENDING the rest with edit_file — do NOT rewrite the whole file.` : ''}`;
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
        // search hits on this file give real anchors — accept them as grounding
        const locatedViaSearchHits = Array.isArray(toolEvents) && toolEvents.some((event) => (
          event
          && event.ok
          && String(event.tool || '').toLowerCase() === 'search_files'
          && new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:`).test(String(event.observation || ''))
        ));
        if (!alreadyReadOrWrittenThisFile && !locatedViaSearchHits) {
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
        let editProgramSource = program ? 'inline-decision' : '';
        if (!program) {
          const generated = await deps.generateAgentEditFileProgram(taskText, toolEvents, path, originalContent, decision.content || '', planSpec);
          program = deps.parseAgentEditProgram(generated);
          if (program) editProgramSource = 'generated';
        }
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_edit_mode', {
            path,
            originalLen: String(originalContent.length),
            mode: program ? `edit-program (${editProgramSource})` : 'rewrite-fallback',
            editCount: String(program && Array.isArray(program.edits) ? program.edits.length : 0),
          }, { path, program });
        }
        if (!program) {
          const syntaxRepair = (toolEvents || []).slice(-8).some((event) => {
            const detail = `${String(event && event.observation || '')}\n${Array.isArray(event && event.validationIssues) ? event.validationIssues.join('\n') : ''}`;
            return detail.includes(path) && /(?:syntax error|parsing error|unexpected token|outside of function)/i.test(detail);
          });
          if (syntaxRepair) {
            return {
              ok: false,
              mutated,
              observation: `edit_file blocked for ${path}: the parser reported a localized syntax error, but no concrete find/replace edit was produced. The file was kept intact; retry with an exact edit program instead of rewriting the whole file.`,
            };
          }
          const rewritten = await deps.generateAgentRewriteExistingFileContent(taskText, toolEvents, path, originalContent, decision.content || '', planSpec);
          const rewrittenTrim = String(rewritten || '').trim();
          const origLen = originalContent.trim().length;
          // Guard against a DESTRUCTIVE rewrite. When the model emits an instruction
          // instead of a valid edit program, the whole-file rewrite fallback can
          // collapse a substantial file back to a stub (this is exactly how a 140-line
          // README reverted to its 5-line file tree). If the rewrite drops most of a
          // non-trivial file, treat it as a revert, keep the current content, and ask
          // for a precise edit instead of silently destroying work.
          const wouldShrinkDrastically = origLen > 400 && rewrittenTrim.length < origLen * 0.6;
          const rewriteBreaksStructure = !getStructuralIssueForPath(path, originalContent)
            && Boolean(getStructuralIssueForPath(path, rewritten));
          if (rewrittenTrim && rewritten !== originalContent && !wouldShrinkDrastically && !rewriteBreaksStructure) {
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
              observation = `edit_file ok: ${path} (full-file rewrite fallback, ${rewritten.length} chars)\nThe saved file is exactly the rewrite you just produced — do not re-read ${path} to verify.`;
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
          if (wouldShrinkDrastically) {
            if (typeof deps.recordDebugTrace === 'function') {
              deps.recordDebugTrace('agent_rewrite_revert_blocked', {
                path,
                origLen: String(origLen),
                newLen: String(rewrittenTrim.length),
              }, { path, origLen, newLen: rewrittenTrim.length });
            }
            return {
              ok: false,
              mutated,
              observation: `edit_file blocked for ${path}: the rewrite fallback returned far less content (${rewrittenTrim.length} vs ${origLen} chars) and would have reverted your changes, so I kept the current file. Provide a precise find/replace edit (anchor text + replacement) instead of an instruction.`,
            };
          }
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: the instructions could not be parsed into concrete find/replace edits and the rewrite fallback did not produce a safe replacement. Provide a precise JSON edit program (exact anchor text from the file + replacement). If ${path} does not actually need changes for this task, do NOT edit it — take the next planned step or finalize instead.`,
          };
        }
        const applied = deps.applyAgentEditProgram(originalContent, program);
        if (typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_edit_apply', {
            path,
            editCount: String(Array.isArray(program.edits) ? program.edits.length : 0),
            appliedCount: String(applied ? applied.appliedCount : 0),
            fuzzyCount: String(applied ? applied.fuzzyCount : 0),
            anchorModes: (applied && Array.isArray(applied.anchors) ? applied.anchors.map((a) => `${a.op}:${a.mode}${a.score != null ? `(${a.score})` : ''}`).join(', ') : ''),
            changed: String(Boolean(applied && String(applied.output || '') !== originalContent)),
            beforeLen: String(originalContent.length),
            afterLen: String(applied ? String(applied.output || '').length : 0),
          }, { path, anchors: applied && applied.anchors });
        }
        if (!applied || applied.appliedCount <= 0 || String(applied.output || '') === originalContent) {
          // Split the two failure shapes: an anchor that didn't match (fix the find
          // text) vs an edit that matched but changed nothing (the file already
          // contains the replacement — stop re-editing the same block and move on).
          const matchedButNoChange = applied && applied.appliedCount > 0
            && String(applied.output || '') === originalContent;
          // "Already satisfies the request" is a LIE while a build/check error for
          // this file is still live — it sent a model chasing phantom stale caches.
          const errorStillLiveForPath = (toolEvents || []).slice(-8).some((e) => e
            && ['run_app', 'run_command', 'check_code', 'validate_files'].includes(String(e.tool || '').toLowerCase())
            && (e.ok === false || Number(e.runErrorCount) > 0 || Number(e.checkErrorCount) > 0 || e.validationPassed === false)
            && String(e.observation || '').includes(path));
          return {
            ok: false,
            mutated,
            observation: matchedButNoChange
              ? (errorStillLiveForPath
                ? `edit_file made no change to ${path}: your replacement text is IDENTICAL to what the file already contains — you re-sent the existing line instead of a fixed one. The reported error is still unfixed. Re-edit with a replacement that actually DIFFERS (remove or rewrite the offending part).`
                : `edit_file made no change to ${path}: the file already contains that exact text, so it likely already satisfies the request. Do NOT re-submit the same edit — take the next planned step or finalize instead.`)
              : `edit_file blocked for ${path}: no edits were applied — the find/anchor text was not found. Use exact existing text from the current file in the find/anchor field.`,
          };
        }
        // Never save an edit that breaks a previously-sound file.
        const editBeforeIssue = getStructuralIssueForPath(path, originalContent);
        const editAfterIssue = getStructuralIssueForPath(path, applied.output);
        if (!editBeforeIssue && editAfterIssue) {
          if (typeof deps.recordDebugTrace === 'function') {
            deps.recordDebugTrace('agent_edit_structural_reject', {
              path, issue: String(editAfterIssue).slice(0, 200),
            }, { path, issue: editAfterIssue, program });
          }
          return {
            ok: false,
            mutated,
            observation: `edit_file rejected for ${path}: applying it would have broken the file — it ${editAfterIssue}. The file was left unchanged. Re-issue a corrected edit that keeps opening and closing tags/braces paired, or use write_file with the complete corrected file if a larger restructure is needed.`,
          };
        }
        if (applied.fuzzyCount > 0 && typeof deps.recordDebugTrace === 'function') {
          deps.recordDebugTrace('agent_edit_fuzzy_applied', {
            path, fuzzyCount: String(applied.fuzzyCount), appliedCount: String(applied.appliedCount),
          }, { path, fuzzyCount: applied.fuzzyCount, appliedCount: applied.appliedCount });
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
        const appliedSummary = summarizeAppliedEditsForObservation(program);
        observation = [
          `edit_file ok: ${path} (${applied.appliedCount} edits)`,
          appliedSummary ? `Applied changes:\n${appliedSummary}` : '',
          `The saved file reflects exactly these changes — do not re-read ${path} to verify.`,
          editBeforeIssue && editAfterIssue
            ? `WARNING: ${path} STILL fails to parse — it ${editAfterIssue}. It was broken before this edit and remains broken; fix the remaining error or regenerate the COMPLETE file with write_file.`
            : '',
        ].filter(Boolean).join('\n');
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

      // Detect the workspace stack and choose the strongest safe proof available.
      // Natural-language routing stays semantic; this detector only reads project
      // files/configs and maps them to deterministic proof commands.
      if (tool === 'run_app') {
        const stackInfo = await detectWorkspaceStack(planSpec || {});
        const proof = stackInfo && stackInfo.proof ? stackInfo.proof : null;

        if (proof && proof.kind === 'command') {
          if (typeof deps.invokeWorkspaceAction !== 'function') {
            return { ok: false, mutated, observation: `run_app cannot run ${stackInfo.label || 'the proof command'} because the native command runner is not available in this build.` };
          }

          const proofCommand = String(proof.command || '').trim();
          const classification = classifyAgentCommand(proofCommand);
          if (classification.policy === 'blocked') {
            return {
              ok: false,
              mutated,
              commandPolicy: 'blocked',
              terminalCommand: proofCommand,
              observation: `run_app proof command blocked: ${classification.reason}`,
            };
          }
          if (classification.policy === 'ask_first') {
            const approvedProofCommand = String((runOptions && runOptions.approvedCommand) || '').trim();
            if (approvedProofCommand && approvedProofCommand === proofCommand) {
              classification.policy = 'auto_safe';
              classification.reason = 'approved ask-first command';
            } else {
              return buildCommandPermissionRequiredResult(proofCommand, classification, mutated, 'run_app');
            }
          }

          deps.setActiveAgentStreamStatus(chatId, `Running terminal proof: ${proofCommand}`);
          const res = await deps.invokeWorkspaceAction('runCommand', {
            program: classification.program,
            argsLine: classification.args.join('\n'),
          });
          if (!res || !res.ok) {
            if (isMissingRuntimeMessage(res && res.message)) {
              return buildMissingRuntimeResult(classification.program, proofCommand, mutated, 'run_app');
            }
            return { ok: false, mutated, observation: `run_app could not start ${stackInfo.label || 'the proof command'}: ${(res && res.message) || 'unknown error'}.` };
          }

          const status = parseRunCommandExitStatus(res.message);
          const tail = commandOutputTail(res.output);
          const terminalProof = buildTerminalProof(proofCommand, res, status);

          if (status.timedOut) {
            return {
              ok: true,
              mutated,
              runErrorCount: 1,
              terminalCommand: proofCommand,
              terminalProof,
              observation: `run_app ${stackInfo.failLabel || 'proof'} timed out before completion. This usually means the command hung or dependency setup is incomplete.${tail ? `\nOutput:\n${tail}` : ''}`,
            };
          }

          if (status.exitCode === 0) {
            return {
              ok: true,
              mutated,
              runErrorCount: 0,
              terminalCommand: proofCommand,
              terminalProof,
              observation: `run_app ${stackInfo.passLabel || 'proof passed'} (${proofCommand} exited 0).${tail ? `\nOutput:\n${tail}` : ''}`,
            };
          }

          const missingDeps = proof.installCommand && looksLikeMissingNodeDependencies(`${res.message || ''}\n${res.output || ''}`);
          if (missingDeps) {
            const installCommand = String(proof.installCommand || '').trim();
            // The user's single approval covers the install: run it here and
            // retry the proof, instead of surfacing a second permission ask.
            const approvedInstall = String((runOptions && runOptions.approvedCommand) || '').trim() === installCommand;
            if (approvedInstall) {
              const installClass = classifyAgentCommand(installCommand);
              deps.setActiveAgentStreamStatus(chatId, `Installing dependencies: ${installCommand}`);
              const installRes = await deps.invokeWorkspaceAction('runCommand', {
                program: installClass.program,
                argsLine: installClass.args.join('\n'),
              });
              const installStatus = installRes && installRes.ok ? parseRunCommandExitStatus(installRes.message) : null;
              const installTail = commandOutputTail(installRes && installRes.output);
              if (!installRes || !installRes.ok || !installStatus || installStatus.timedOut || installStatus.exitCode !== 0) {
                return {
                  ok: true,
                  mutated,
                  runErrorCount: 1,
                  terminalCommand: installCommand,
                  terminalProof: buildTerminalProof(installCommand, installRes || {}, installStatus || { exitCode: null, timedOut: false }),
                  observation: `run_app ran the approved \`${installCommand}\` but it did not finish cleanly. Read the install errors, fix the cause (often package.json), then run_app again.${installTail ? `\nOutput:\n${installTail}` : ''}`,
                };
              }
              deps.setActiveAgentStreamStatus(chatId, `Running terminal proof: ${proofCommand}`);
              const retryRes = await deps.invokeWorkspaceAction('runCommand', {
                program: classification.program,
                argsLine: classification.args.join('\n'),
              });
              if (retryRes && retryRes.ok) {
                const retryStatus = parseRunCommandExitStatus(retryRes.message);
                const retryTail = commandOutputTail(retryRes.output);
                const retryProof = buildTerminalProof(proofCommand, retryRes, retryStatus);
                if (!retryStatus.timedOut && retryStatus.exitCode === 0) {
                  return {
                    ok: true,
                    mutated,
                    runErrorCount: 0,
                    terminalCommand: proofCommand,
                    terminalProof: retryProof,
                    observation: `run_app installed dependencies (\`${installCommand}\`) and ${stackInfo.passLabel || 'the proof passed'} (${proofCommand} exited 0).${retryTail ? `\nOutput:\n${retryTail}` : ''}`,
                  };
                }
                return {
                  ok: true,
                  mutated,
                  runErrorCount: 1,
                  terminalCommand: proofCommand,
                  terminalProof: retryProof,
                  observation: `run_app installed dependencies, but ${stackInfo.failLabel || 'the proof failed'} (${proofCommand} ${retryStatus.timedOut ? 'timed out' : `exited ${retryStatus.exitCode}`}). Read these real errors, fix the root cause in the referenced files, then run_app again.\nOutput:\n${retryTail || '(no output)'}`,
                };
              }
              return { ok: false, mutated, observation: `run_app installed dependencies but could not re-run ${proofCommand}: ${(retryRes && retryRes.message) || 'unknown error'}.` };
            }
            const installProofPreview = tail
              ? `Required because \`${proofCommand}\` reported:\n${tail}`
              : `Required because ${proofCommand} reported missing local dependencies.`;
            return {
              ok: true,
              mutated,
              runErrorCount: 1,
              permissionRequired: true,
              commandPolicy: 'ask_first',
              terminalCommand: installCommand,
              terminalProof: {
                command: installCommand,
                exitCode: null,
                timedOut: false,
                outputPreview: installProofPreview.length > 1600 ? `...(truncated)\n${installProofPreview.slice(-1600)}` : installProofPreview,
              },
              observation: `run_app detected missing dependencies while running \`${proofCommand}\`. Permission is required before AI.EXE can run \`${installCommand}\` because it can use the network and modify dependency files. Approve \`${installCommand}\`, or install dependencies outside AI.EXE, then run_app again.${tail ? `\nBuild output:\n${tail}` : ''}`,
            };
          }

          return {
            ok: true,
            mutated,
            runErrorCount: 1,
            terminalCommand: proofCommand,
            terminalProof,
            observation: `run_app ${stackInfo.failLabel || 'proof failed'} (${proofCommand} exited ${status.exitCode}). Read these real errors, fix the root cause in the referenced files, then run_app again.\nOutput:\n${tail || '(no output)'}`,
          };
        }

        if (typeof deps.runWorkspaceAppSmokeTest !== 'function') {
          return { ok: false, mutated, observation: 'run_app is not available in this build.' };
        }
        const requestedHtml = deps.normalizeWorkspacePath(decision.path || '');
        const htmlTarget = proof && proof.kind === 'smoke'
          ? deps.normalizeWorkspacePath(proof.path || '/index.html')
          : (/\.html?$/i.test(requestedHtml) ? requestedHtml : '/index.html');
        deps.setActiveAgentStreamStatus(chatId, `Running ${htmlTarget} in the offline preview...`);
        const result = await deps.runWorkspaceAppSmokeTest(htmlTarget);
        if (!result || !result.ok) {
          return { ok: false, mutated, observation: `run_app failed: ${(result && result.message) || 'could not load the page'}.` };
        }
        const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
        // Render snapshot: what the page ACTUALLY shows after load (DOM-measured,
        // not phrase-based) — lets the agent verify visual claims itself.
        const snap = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null;
        const snapshotText = snap ? (snap.error
          ? `\nRender snapshot unavailable (${snap.error}).`
          : [
            '\nRender snapshot (measured from the live DOM after load — this is what the user sees):',
            snap.title ? `- page title: ${snap.title}` : '',
            `- visible text: "${String(snap.text || '(none)')}"`,
            Array.isArray(snap.hiddenButRendered) && snap.hiddenButRendered.length
              ? `- PROBLEM: marked hidden (hidden/aria-hidden attribute) but still visibly rendered — CSS display rules are overriding the attribute: ${snap.hiddenButRendered.join(', ')}`
              : '',
            Array.isArray(snap.bigOverlays) && snap.bigOverlays.length
              ? `- large overlays covering most of the viewport (may block interaction): ${snap.bigOverlays.join(', ')}`
              : '',
            snap.centerTop ? `- topmost element at viewport center (what a click there hits): ${snap.centerTop}` : '',
            Array.isArray(snap.ids) && snap.ids.length ? `- element visibility: ${snap.ids.join(', ')}` : '',
          ].filter(Boolean).join('\n')) : '';
        // Interaction probe report: which elements were synthetically clicked and
        // what the UI showed afterwards (only when it actually changed).
        const after = result.snapshotAfter && typeof result.snapshotAfter === 'object' && !result.snapshotAfter.error
          ? result.snapshotAfter
          : null;
        const clickedList = Array.isArray(result.clicked) && result.clicked.length
          ? `\nInteraction probe (synthetic clicks on visible native controls + tap points): ${result.clicked.join(', ')}`
          : '';
        const afterChanged = after && snap && JSON.stringify(after) !== JSON.stringify(snap);
        const afterText = afterChanged ? [
          '\nAfter interaction:',
          `- visible text: "${String(after.text || '(none)')}"`,
          Array.isArray(after.hiddenButRendered) && after.hiddenButRendered.length
            ? `- still marked hidden but visibly rendered: ${after.hiddenButRendered.join(', ')}`
            : '',
          Array.isArray(after.bigOverlays) && after.bigOverlays.length
            ? `- large overlays now covering the viewport: ${after.bigOverlays.join(', ')}`
            : '',
        ].filter(Boolean).join('\n') : '';
        return {
          ok: true,
          mutated,
          runErrorCount: errors.length,
          renderSnapshot: snap,
          observation: (errors.length
            ? `run_app ${htmlTarget}: ${errors.length} runtime error${errors.length === 1 ? '' : 's'} during the smoke run:\n- ${errors.join('\n- ')}\nFix these (the file:line references point into the inlined sources; "[during interaction probe]" errors fired when a visible control/point was clicked), then run_app again to verify.`
            : `run_app ${htmlTarget}: started cleanly — no runtime errors, unhandled rejections, or console.error during startup or the interaction probe.`) + snapshotText + clickedList + afterText,
        };
      }

      // Allowlisted run (python/pip/node/npm) → real output+exit for run→fix.
      if (tool === 'run_command') {
        const rawCommand = String(decision.command || decision.content || '').trim();
        if (!rawCommand) {
          return { ok: false, mutated, observation: 'run_command needs a command, e.g. {"action":"tool","tool":"run_command","command":"python main.py"}.' };
        }
        const classification = classifyAgentCommand(rawCommand);
        if (classification.policy === 'blocked') {
          return {
            ok: false,
            mutated,
            commandPolicy: 'blocked',
            observation: `run_command blocked: ${classification.reason}`,
          };
        }
        const approvedCommand = String((runOptions && runOptions.approvedCommand) || '').trim();
        const hasExactApproval = Boolean(approvedCommand && approvedCommand === rawCommand);
        if (classification.policy === 'ask_first' && !hasExactApproval) {
          return buildCommandPermissionRequiredResult(rawCommand, classification, mutated, 'run_command');
        }
        if (classification.policy === 'ask_first' && hasExactApproval) {
          classification.policy = 'auto_safe';
          classification.reason = 'approved ask-first command';
        }
        if (typeof deps.invokeWorkspaceAction !== 'function') {
          return { ok: false, mutated, observation: 'run_command is not available in this build.' };
        }
        const program = classification.program;
        const args = classification.args;
        if (isDevServerCommand(program, args)) {
          deps.setActiveAgentStreamStatus(chatId, `Starting dev server: ${rawCommand}`);
          // Piped python buffers its startup banner — force unbuffered so the
          // URL/port shows up in the captured log.
          const serverArgs = program === 'python' && args[0] !== '-u' ? ['-u', ...args] : args;
          const startRes = await deps.invokeWorkspaceAction('devServerStart', {
            program,
            argsLine: serverArgs.join('\n'),
            display: rawCommand,
          });
          if (!startRes || !startRes.ok) {
            if (isMissingRuntimeMessage(startRes && startRes.message)) {
              return buildMissingRuntimeResult(program, rawCommand, mutated, 'run_command');
            }
            return { ok: false, mutated, observation: `run_command \`${rawCommand}\` could not start: ${(startRes && startRes.message) || 'unknown error'}.` };
          }
          const serverId = Number(String(startRes.output || '').trim()) || 0;
          let lastStatus = null;
          let url = '';
          for (let i = 0; i < 12; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const st = await deps.invokeWorkspaceAction('devServerStatus', { serverId });
            if (!st || !st.ok) break;
            lastStatus = st;
            const log = String(st.output || '');
            const urlMatch = log.match(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)[^\s"']*/i);
            if (urlMatch) { url = urlMatch[0].replace(/[),.;]+$/, ''); break; }
            if (/^exited/.test(String(st.message || ''))) break;
          }
          const statusMsg = String((lastStatus && lastStatus.message) || 'running');
          const running = /^running/.test(statusMsg);
          const exitMatch = statusMsg.match(/exit_code=(-?\d+)/);
          const exitCode = exitMatch ? Number(exitMatch[1]) : -1;
          const rawLog = String((lastStatus && lastStatus.output) || '').trim();
          const logTail = rawLog.length > 2500 ? `…(truncated)\n${rawLog.slice(-2500)}` : rawLog;
          const terminalProof = {
            command: rawCommand,
            exitCode: running ? null : exitCode,
            timedOut: false,
            outputPreview: logTail,
          };
          if (!running) {
            return {
              ok: true,
              mutated,
              runErrorCount: exitCode === 0 ? 0 : 1,
              terminalCommand: rawCommand,
              terminalProof,
              observation: `run_command \`${rawCommand}\`: the dev server exited during startup${exitCode === 0 ? ' (exit 0)' : ` with code ${exitCode}`}. Read the error below, fix its ROOT cause, then run_command again.\nOutput:\n${logTail || '(no output)'}`,
            };
          }
          return {
            ok: true,
            mutated,
            runErrorCount: 0,
            terminalCommand: rawCommand,
            terminalProof,
            devServer: { id: serverId, url, running: true, command: rawCommand },
            observation: `run_command \`${rawCommand}\`: dev server is RUNNING${url ? ` at ${url}` : ''} — tracked as server #${serverId}, left running in the background with a Stop button in the chat. Do NOT run this command again; continue with the next step or finalize.${logTail ? `\nStartup output:\n${logTail}` : ''}`,
          };
        }
        deps.setActiveAgentStreamStatus(chatId, `Running terminal command: ${rawCommand}`);
        const res = await deps.invokeWorkspaceAction('runCommand', { program, argsLine: args.join('\n') });
        if (!res || !res.ok) {
          if (isMissingRuntimeMessage(res && res.message)) {
            return buildMissingRuntimeResult(program, rawCommand, mutated, 'run_command');
          }
          return { ok: false, mutated, observation: `run_command \`${rawCommand}\` could not run: ${(res && res.message) || 'unknown error'}.` };
        }
        const status = String(res.message || '');
        const rawOut = String(res.output || '').trim();
        const tail = rawOut.length > 4000 ? `…(truncated)\n${rawOut.slice(-4000)}` : rawOut;
        const timedOut = status === 'timed_out';
        const exitMatch = status.match(/exit_code=(-?\d+)/);
        const exitCode = exitMatch ? Number(exitMatch[1]) : (timedOut ? null : 0);
        const terminalProof = buildTerminalProof(rawCommand, res, { timedOut, exitCode });
        if (timedOut) {
          return { ok: true, mutated, runErrorCount: 0, terminalCommand: rawCommand, terminalProof, observation: `run_command \`${rawCommand}\`: still running at the timeout with no crash — the program started cleanly (a GUI/game loop or server keeps running, which is expected).${tail ? `\nOutput:\n${tail}` : ''}` };
        }
        if (exitCode === 0) {
          return { ok: true, mutated, runErrorCount: 0, terminalCommand: rawCommand, terminalProof, observation: `run_command \`${rawCommand}\`: finished cleanly (exit 0).${tail ? `\nOutput:\n${tail}` : ''}` };
        }
        return { ok: true, mutated, runErrorCount: 1, terminalCommand: rawCommand, terminalProof, observation: `run_command \`${rawCommand}\`: exited with code ${exitCode}. Read the error below, fix its ROOT cause in the code, then run_command again to verify.\nOutput:\n${tail || '(no output)'}` };
      }

      // Parse code files and report exact syntax errors with line/column — the
      // agent's "console". Non-mutating; doesn't count as inspection budget.
      if (tool === 'check_code') {
        const codeFileRe = /\.(?:js|mjs|cjs|html?|css|json)$/i;
        const requested = deps.normalizeWorkspacePath(decision.path || '');
        let targets = [];
        if (requested && requested !== '/' && codeFileRe.test(requested)) {
          targets = [requested];
        } else {
          const seen = new Set();
          planExpectedFiles.forEach((p) => {
            const normalized = deps.normalizeWorkspacePath(p || '');
            if (normalized && codeFileRe.test(normalized)) seen.add(normalized);
          });
          (Array.isArray(toolEvents) ? toolEvents : []).forEach((event) => {
            const normalized = deps.normalizeWorkspacePath((event && event.path) || '');
            if (normalized && codeFileRe.test(normalized)) seen.add(normalized);
          });
          listedExistingFiles.forEach((p) => {
            const normalized = deps.normalizeWorkspacePath(p || '');
            if (normalized && codeFileRe.test(normalized)) seen.add(normalized);
          });
          targets = Array.from(seen);
        }
        if (!targets.length) {
          return { ok: false, mutated, observation: 'check_code found no known code files yet — run list_dir first or pass a specific file path.' };
        }
        const lines = [];
        let errorCount = 0;
        for (const targetPath of targets.slice(0, 12)) {
          const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path: targetPath });
          if (!response || !response.ok) {
            lines.push(`- ${targetPath}: could not be read`);
            errorCount += 1;
            continue;
          }
          const issue = getStructuralIssueForPath(targetPath, String(response.output || ''));
          if (issue) {
            lines.push(`- ${targetPath}: ${issue}`);
            errorCount += 1;
          } else {
            lines.push(`- ${targetPath}: OK (parses cleanly)`);
          }
        }
        return {
          ok: true,
          mutated,
          checkErrorCount: errorCount,
          observation: `check_code results (${errorCount ? `${errorCount} file${errorCount === 1 ? '' : 's'} with errors` : 'all clean'}):\n${lines.join('\n')}`,
        };
      }

      if (tool === 'validate_files') {
        const expectedFiles = getActivePlannedFiles(planSpec);
        const allExpectedFiles = getAllPlannedFiles(planSpec);
        let targets = expectedFiles.filter((path) => path && path !== '/README.md' && path !== '/src');
        if (!targets.length) {
          const mutatedPaths = Array.isArray(toolEvents) ? toolEvents
            .filter((e) => e && e.ok && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase()) && e.path)
            .map((e) => String(e.path))
            .filter((p, i, arr) => arr.indexOf(p) === i) : [];
          if (!mutatedPaths.length) {
            return { ok: false, mutated, observation: 'validate_files blocked: there are no planned project files to validate yet.' };
          }
          targets = mutatedPaths;
        }
        const issues = [];
        const fileContents = {};
        const completenessAdvisory = [];
        let readableCount = 0;
        for (const path of targets) {
          const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
          if (!response || !response.ok) {
            continue; // missing planned file (e.g. a later phase) — skip, not a failure
          }
          readableCount += 1;
          const content = String(response.output || '');
          fileContents[path] = content;
          const fileIssues = validateGeneratedFile(path, content, taskText, planSpec);
          fileIssues.forEach((issue) => issues.push(`${path}: ${issue}`));
          if (/\.(html|js|ts|jsx|tsx|py)$/i.test(deps.normalizeWorkspacePath(path))
            && !deps.isLikelyCompletePrimarySource(path, content, taskText)) {
            completenessAdvisory.push(`${path}: may be thinner than the requested feature set — expand it only if something is actually missing`);
          }
        }
        const contextTargets = allExpectedFiles
          .filter((path) => path && !fileContents[path] && /\.(html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx)$/i.test(path))
          .slice(0, 24);
        for (const path of contextTargets) {
          const response = await deps.invokeWorkspaceAction('workspaceReadFile', { path });
          if (response && response.ok) fileContents[path] = String(response.output || '');
        }
        if (readableCount === 0) {
          // Nothing exists yet — non-passing but no validationIssues (so no repair).
          return { ok: false, mutated, observation: 'validate_files: none of the planned files exist yet — write the files first, then validate.' };
        }
        const mechanicalAdvisory = completenessAdvisory;
        const webConsistencyIssues = validateWebProjectConsistency(fileContents, planSpec, mechanicalAdvisory);
        webConsistencyIssues.forEach((issue) => issues.push(issue));
        // Best-effort package declaration hint.
        if (Object.keys(fileContents).some((p) => /\.py$/i.test(p))) {
          let reqText = fileContents['/requirements.txt'] || '';
          if (!reqText) {
            const reqRes = await deps.invokeWorkspaceAction('workspaceReadFile', { path: '/requirements.txt' });
            if (reqRes && reqRes.ok) reqText = String(reqRes.output || '');
          }
          const missingDeps = getPythonMissingDependencies(fileContents, reqText);
          if (missingDeps.length) {
            mechanicalAdvisory.push(`Python project imports package(s) not found in requirements.txt: ${missingDeps.join(', ')}. Confirm they are declared in requirements.txt, pyproject.toml, or another intentional install path.`);
          }
        }
        const codePaths = Object.keys(fileContents).filter((path) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(path));
        for (const path of codePaths) {
          const source = String(fileContents[path] || '');
          const specs = extractRelativeCodeImports(source);
          for (const spec of specs) {
            const candidates = resolveRelativeImportCandidates(path, spec);
            if (!candidates.length) continue;
            let found = candidates.some((candidate) => Object.prototype.hasOwnProperty.call(fileContents, candidate));
            if (!found) {
              for (const candidate of candidates) {
                const res = await deps.invokeWorkspaceAction('workspaceReadFile', { path: candidate });
                if (res && res.ok) {
                  fileContents[candidate] = String(res.output || '');
                  found = true;
                  break;
                }
              }
            }
            if (!found) {
              mechanicalAdvisory.push(`${path}: static scan could not resolve ${spec} to ${candidates.slice(0, 5).join(', ')}${candidates.length > 5 ? ', ...' : ''}. Confirm it is not generated, aliased, or a commented example.`);
            }
          }
        }
        if (!issues.length) {
          // Advisory model-driven cross-file review; never blocks.
          let advisoryNotes = mechanicalAdvisory.slice();
          if (typeof deps.reviewAgentProjectCoherence === 'function') {
            try {
              advisoryNotes = advisoryNotes.concat(await deps.reviewAgentProjectCoherence(fileContents, taskText) || []);
            } catch (_) { }
          }
          const advisoryBlock = advisoryNotes.length
            ? `\nAdvisory cross-file review (non-blocking — fix only what is real and quick):\n- ${advisoryNotes.slice(0, 5).join('\n- ')}`
            : '';
          return {
            ok: true,
            mutated,
            observation: `validate_files ok: no obvious file-role, syntax, or MVP completeness issues found in ${targets.join(', ')}${advisoryBlock}`,
            validationPassed: true,
            validationAdvisory: advisoryNotes.slice(0, 5),
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
        const rawPath = String(decision.path || '').trim();
        const path = deps.normalizeWorkspacePath(rawPath);
        if (!path || path === '/') {
          return {
            ok: true,
            mutated,
            observation: 'mkdir skipped: no valid folder path was provided. This is harmless because write_file creates parent folders automatically.',
          };
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
          return {
            ok: true,
            mutated,
            observation: `mkdir skipped: ${path} could not be created (${(response && response.message) || 'unknown error'}). This is harmless if the next write_file targets a file inside it, because write_file creates parent folders automatically.`,
          };
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
        const path = deps.normalizeWorkspacePath(decision.path || '');
        // Regenerable build-cache dirs may be deleted without the user having said
        // "delete" — a stale cache is a legitimate repair step. Still ask-first:
        // the confirmation card below runs regardless. Conservative list only
        // (no dist/build — those can be a user's only artifacts).
        const isRegenerableBuildCache = (() => {
          const norm = String(path || '').toLowerCase().replace(/\/+$/, '');
          if (/\/__pycache__$/.test(norm)) return true;
          return [
            '/node_modules/.vite',
            '/node_modules/.cache',
            '/.next',
            '/.nuxt',
            '/.parcel-cache',
            '/.turbo',
            '/.pytest_cache',
          ].includes(norm);
        })();
        if (!mustExplicitlyDelete && !isRegenerableBuildCache) {
          return {
            ok: false,
            mutated,
            observation: 'delete blocked: user did not explicitly request delete/remove/trash. (Exception: regenerable build caches like /node_modules/.vite may be deleted with user approval.)',
          };
        }
        if (!path || path === '/') {
          return { ok: false, mutated, observation: 'delete requires a valid file/folder path.' };
        }
        // Human-in-the-loop guard for an irreversible op (OWASP "Excessive Agency"):
        // never delete without explicit per-action user approval. Pause and surface
        // exactly what will be removed; the loop performs the trash only if approved.
        return {
          ok: false,
          mutated,
          requiresDeleteConfirmation: true,
          deletePath: path,
          userFacingMessage: `Delete \`${path}\`? It will be moved to your system Trash (recoverable). Confirm to proceed.`,
          observation: `delete of ${path} is paused for user confirmation.`,
        };
      }

      return { ok: false, mutated, observation: `Unknown tool "${tool}".` };
    }

    function describeAgentToolPhase(tool, targetInfo, phase = 'start') {
      const name = String(tool || '').toLowerCase();
      const target = String(targetInfo || '').trim();
      const withTarget = (base) => (target ? `${base} ${target}` : base);
      if (phase === 'start') {
        if (name === 'new_project') return 'Creating project workspace';
        if (name === 'generate_project') return 'Generating all project files';
        if (name === 'list_dir') return withTarget('Scanning folder');
        if (name === 'search_files') return withTarget('Searching files');
        if (name === 'read_file') return withTarget('Reading file');
        if (name === 'read_files') return withTarget('Reading files');
        if (name === 'write_file') return withTarget('Writing file');
        if (name === 'edit_file') return withTarget('Editing file');
        if (name === 'validate_files') return 'Checking written files';
        if (name === 'check_code') return 'Checking syntax';
        if (name === 'run_app') return 'Running the app';
        if (name === 'run_command') return withTarget('Running command');
        if (name === 'mkdir') return withTarget('Creating folder');
        if (name === 'move') return withTarget('Moving');
        if (name === 'delete') return withTarget('Deleting');
        return withTarget(`Running ${name || 'tool'}`);
      }
      if (phase === 'done') {
        if (name === 'new_project') return 'Created project workspace';
        if (name === 'generate_project') return 'Generated project files';
        if (name === 'list_dir') return withTarget('Scanned');
        if (name === 'search_files') return withTarget('Searched');
        if (name === 'read_file') return withTarget('Read');
        if (name === 'read_files') return withTarget('Read');
        if (name === 'write_file') return withTarget('Wrote');
        if (name === 'edit_file') return withTarget('Edited');
        if (name === 'validate_files') return 'Checked files';
        if (name === 'check_code') return 'Checked syntax';
        if (name === 'run_app') return 'Ran the app';
        if (name === 'mkdir') return withTarget('Created folder');
        if (name === 'move') return withTarget('Moved');
        if (name === 'delete') return withTarget('Deleted');
        return withTarget('Done');
      }
      return withTarget('Failed');
    }

    return {
      summarizeWorkspaceListForAgent,
      executeDeveloperToolCall,
      describeAgentToolPhase,
      getJsSyntaxIssue,
      getJsReassignedConstIssue,
      getJsCorrectnessIssues,
      validateGeneratedFile,
      getHtmlStructureIssue,
      getStructuralIssueForPath,
      validateWebProjectConsistency,
      buildSearchNeedles,
      lineMatchesNeedle,
    };
  }

  global.AIExeAgentExecutor = {
    createAgentExecutor,
  };
})(window);
