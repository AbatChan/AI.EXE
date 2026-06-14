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
        const htmlStructureIssue = getHtmlStructureIssue(text);
        if (htmlStructureIssue) issues.push(htmlStructureIssue);
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
        let jsSyntaxFailed = false;
        if (!/\b(import|export)\b/.test(text)) {
          try {
            // Syntax-only check for normal script files.
            // eslint-disable-next-line no-new, no-new-func
            new Function(text);
          } catch (err) {
            jsSyntaxFailed = true;
            const syntaxIssue = getJsSyntaxIssue(text, err);
            issues.push(`has a JavaScript syntax error: ${syntaxIssue || String(err && err.message ? err.message : err || 'unknown error')}`);
          }
        }
        if (!jsSyntaxFailed) {
          // new Function() only catches parse errors; catch const-reassignment (a runtime error) statically.
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

    // Structural diagnostic per language; empty string = sound.
    function getStructuralIssueForPath(path, content) {
      const normalized = deps.normalizeWorkspacePath(path || '');
      const text = String(content || '');
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
        try {
          JSON.parse(text);
        } catch (err) {
          return `is not valid JSON (${String((err && err.message) || '')})`;
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

    // Static detection of the "Assignment to constant variable" regression:
    // a simple `const NAME = …` that is later reassigned with a bare `NAME = …`.
    // Strings/comments are stripped first so matches inside them don't false-flag,
    // and a NAME declared more than once is skipped (likely block-scoped shadowing,
    // which we can't resolve cheaply and don't want to over-report).
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
      for (const name of Object.keys(firstDeclIndex)) {
        if (declCount[name] > 1) continue;
        // A bare assignment `name =` (not ==, ===, =>, or a property/.name), after
        // the declaration, and not itself a const/let/var declaration.
        const assignRe = new RegExp(`(^|[^.\\w$=!<>])(${name})\\s*=(?![=>])`, 'g');
        let a;
        while ((a = assignRe.exec(stripped))) {
          const nameAt = a.index + a[1].length;
          if (nameAt <= firstDeclIndex[name]) continue;
          const before = stripped.slice(Math.max(0, nameAt - 7), nameAt);
          if (/\b(?:const|let|var)\s*$/.test(before)) continue;
          return `reassigns the const variable \`${name}\` (declared with const but later assigned — this throws "Assignment to constant variable" at runtime)`;
        }
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

    function validateWebProjectConsistency(fileContents, planSpec, advisoryOut = null) {
      const issues = [];
      const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
      const htmlFiles = expectedFiles.filter((path) => /\.html?$/i.test(String(path || '')));
      const htmlFile = htmlFiles[0] || '';
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

      // Multi-page: check JS refs against the union of all pages' ids/classes.
      const htmlIds = new Set();
      const htmlDataActions = new Set();
      const htmlClasses = new Set();
      for (const page of htmlFiles) {
        const pageHtml = String(fileContents[page] || '');
        if (!pageHtml) continue;
        extractHtmlIds(pageHtml).forEach((id) => htmlIds.add(id));
        extractHtmlDataActions(pageHtml).forEach((action) => htmlDataActions.add(action));
        extractHtmlClasses(pageHtml).forEach((className) => htmlClasses.add(className));
      }
      const htmlLabel = htmlFiles.length > 1 ? htmlFiles.join(', ') : htmlFile;
      const cssClasses = new Set(extractCssClassSelectors(css));
      const cssIds = new Set(extractCssIdSelectors(css));
      const jsExpectations = extractJsHtmlExpectations(js);
      const pushIssue = (issue) => {
        const text = String(issue || '').trim();
        if (text && !issues.includes(text)) issues.push(text);
      };

      jsExpectations.ids.forEach((id) => {
        if (!htmlIds.has(id) && !jsExpectations.createdIds.includes(id)) {
          pushIssue(`${scriptFile || 'script file'}: references #${id}, but ${htmlLabel} does not define that id`);
        }
      });
      jsExpectations.dataActions.forEach((action) => {
        if (!htmlDataActions.has(action)) {
          pushIssue(`${scriptFile || 'script file'}: expects data-action="${action}", but ${htmlLabel} does not provide it`);
        }
      });
      jsExpectations.queriedClasses.forEach((className) => {
        if (!htmlClasses.has(className) && !cssClasses.has(className) && !jsExpectations.createdClasses.includes(className)) {
          pushIssue(`${scriptFile || 'script file'}: queries .${className}, but ${htmlLabel} does not define that class`);
        }
      });
      // Removed (advisory, not crash-class — drove repair loops): "JS toggles .X" and
      // "CSS styles #id" with no matching element are dead/no-op, not bugs. The
      // crash-class `queries .X` / `references #id` checks (querySelector -> null) stay.
      // NOTE: a "many CSS class selectors don't appear in HTML/JS" heuristic used to
      // live here. It was net-negative: a rich, correct stylesheet legitimately has
      // far more classes than the static markup mentions (state/hover/:not variants,
      // descendant selectors, classes rendered via interpolated JS template strings
      // like `class="movie-card ${watched}"`). It false-flagged good CSS, the model
      // "repaired" correct code into worse code, re-failed, and timed out. Removed —
      // the targeted checks below (JS toggles an undefined class; important HTML
      // classes left unstyled) catch the cases that actually matter.
      // Advisory: root-relative links break when pages are opened from disk
      // (file:// resolves "/x" to the filesystem root) — the offline target.
      if (Array.isArray(advisoryOut)) {
        const rootRelative = Array.from(html.matchAll(/\b(?:href|src)=["'](\/[^"'/][^"']*)["']/gi))
          .map((match) => String(match[1] || ''))
          .filter((url) => !/^\/\//.test(url));
        if (rootRelative.length) {
          advisoryOut.push(`${htmlFile}: uses root-relative links (${Array.from(new Set(rootRelative)).slice(0, 4).join(', ')}) which break when opened from disk via file:// — use relative paths (e.g. menu.html, ./style.css) instead`);
        }
      }
      // Advisory only (cosmetic, not crash-class): unstyled classes degrade looks
      // but blocking on them trapped runs in repair loops.
      const importantHtmlClasses = Array.from(htmlClasses).filter((className) => (
        /hero|panel|button|btn|card|section|content|title|subtitle|footer|nav|header|quote|badge|logo|overlay/i.test(className)
      ));
      const unstyledImportantClasses = importantHtmlClasses.filter((className) => !cssClasses.has(className));
      if (css && unstyledImportantClasses.length > 3 && Array.isArray(advisoryOut)) {
        advisoryOut.push(`${htmlFile}: classes used in the markup have no styles in ${cssFile || 'the stylesheet'} (${unstyledImportantClasses.slice(0, 6).map((name) => `.${name}`).join(', ')}) — style them if those sections look unfinished`);
      }

      if (cssClasses.has('buttons-grid') && !htmlClasses.has('buttons-grid') && htmlClasses.has('buttons')) {
        pushIssue(`${cssFile || 'stylesheet'}: styles .buttons-grid, but ${htmlFile} uses .buttons for the calculator grid`);
      }
      if (htmlClasses.has('buttons') && !cssClasses.has('buttons') && cssClasses.has('buttons-grid')) {
        pushIssue(`${htmlFile}: uses .buttons, but ${cssFile || 'stylesheet'} only defines .buttons-grid for the button layout`);
      }
      return issues;
    }

    async function executeDeveloperToolCall(chatId, decision, taskText, toolEvents = [], planSpec = null, runOptions = {}) {
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
        // If this chat already did agent workspace work, it owns the open
        // project, so a "new or current?" prompt makes no sense for a follow-up.
        // Silently continue in the current workspace instead of asking.
        const chatOwnsOpenWorkspace = typeof deps.chatHasPriorAgentWorkspaceWork === 'function'
          && deps.chatHasPriorAgentWorkspaceWork(chatId);
        if (hasOpenWorkspace && canonicalWorkspaceRootName && openWorkspaceEntryCount > 0 && !explicitSeparateWorkspaceIntent && chatOwnsOpenWorkspace) {
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
          continuationHint = `\n...[file continues — call read_file with offset:${nextOffset} (total ${body.length} chars)]`;
        }
        const clipped = focusedRead || (chunk + continuationHint);
        deps.syncFileTabFromWorkspaceWrite(path, body, deps.workspaceBaseName(path));
        observation = `read_file ${path}${rangeNote}\n${clipped || '(empty file)'}`;
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
          const editFailCount = Array.isArray(toolEvents) ? toolEvents.filter((e) => (
            e && !e.ok
            && String(e.tool || '').toLowerCase() === 'edit_file'
            && deps.normalizeWorkspacePath(e.path || '') === path
          )).length : 0;
          // A full rewrite is legitimate recovery once an edit attempt on this file
          // failed, or when the file's current content is structurally broken.
          const knownContent = getLatestKnownContentForPath(toolEvents, path);
          const currentlyBroken = Boolean(knownContent && getStructuralIssueForPath(path, knownContent));
          if (editFailCount < 1 && !currentlyBroken) {
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
        let primaryQualityNote = '';
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
          // Advisory, not a veto: write the stylesheet and flag any remaining
          // concern instead of discarding the model's work or halting the run.
          if (cssIssues.length) {
            primaryQualityNote = ` Note: the generated CSS may still have issues (${cssIssues.join('; ')}); refine it with an edit pass if the page looks off.`;
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
          // Advisory, not a veto: heuristics misjudge valid minimal files, so we
          // write the content and flag it instead of blocking. The model can
          // choose to expand it based on this note or its own judgment.
          if (!validAfterExpansion) {
            primaryQualityNote = shouldUsePythonGameGate
              ? ' Note: this still looks small for a runnable game; expand it (loop, controls, rendering, state) if the request needs more.'
              : ' Note: this looks thin for a usable project file; expand it into a real MVP if the request needs more than a stub.';
          }
        }
        // Never save content that is structurally broken unless it replaces a file
        // that is already broken (a repair attempt is always allowed through).
        const newContentStructureIssue = getStructuralIssueForPath(path, content);
        if (newContentStructureIssue) {
          const priorKnownContent = creatingNewFile ? '' : getLatestKnownContentForPath(toolEvents, path);
          const priorBroken = Boolean(priorKnownContent && getStructuralIssueForPath(path, priorKnownContent));
          if (!priorBroken) {
            if (typeof deps.recordDebugTrace === 'function') {
              deps.recordDebugTrace('agent_write_structural_reject', {
                path, issue: String(newContentStructureIssue).slice(0, 200),
              }, { path, issue: newContentStructureIssue });
            }
            return {
              ok: false,
              mutated,
              observation: `write_file blocked for ${path}: the new content ${newContentStructureIssue}. Nothing was saved. Provide the complete corrected file with all tags/braces paired.`,
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
        observation = `write_file ok: ${path} (${content.length} chars)${primaryQualityNote}\nThe saved file matches the generated content exactly — do not re-read ${path} to verify.${newContentStructureIssue ? `\nWARNING: the saved content still fails to parse — it ${newContentStructureIssue}. Fix this before finishing.` : ''}`;
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
          return {
            ok: false,
            mutated,
            observation: `edit_file blocked for ${path}: no edits were applied. Use exact existing text in find/anchor fields.`,
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

      // Smoke-run the app in a hidden sandboxed preview and return real runtime
      // console errors from startup.
      if (tool === 'run_app') {
        if (typeof deps.runWorkspaceAppSmokeTest !== 'function') {
          return { ok: false, mutated, observation: 'run_app is not available in this build.' };
        }
        const requestedHtml = deps.normalizeWorkspacePath(decision.path || '');
        const htmlTarget = /\.html?$/i.test(requestedHtml) ? requestedHtml : '/index.html';
        deps.setActiveAgentStreamStatus(chatId, `Running ${htmlTarget} in the offline preview...`);
        const result = await deps.runWorkspaceAppSmokeTest(htmlTarget);
        if (!result || !result.ok) {
          return { ok: false, mutated, observation: `run_app failed: ${(result && result.message) || 'could not load the page'}.` };
        }
        const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
        return {
          ok: true,
          mutated,
          runErrorCount: errors.length,
          observation: errors.length
            ? `run_app ${htmlTarget}: ${errors.length} runtime error${errors.length === 1 ? '' : 's'} during startup:\n- ${errors.join('\n- ')}\nFix these (the file:line references point into the inlined sources), then run_app again to verify.`
            : `run_app ${htmlTarget}: started cleanly — no runtime errors, unhandled rejections, or console.error during the startup smoke run.`,
        };
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
        const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
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
          if (/\.(html|js|ts|jsx|tsx|py)$/i.test(deps.normalizeWorkspacePath(path))
            && !deps.isLikelyCompletePrimarySource(path, content, taskText)) {
            completenessAdvisory.push(`${path}: may be thinner than the requested feature set — expand it only if something is actually missing`);
          }
        }
        const mechanicalAdvisory = completenessAdvisory;
        const webConsistencyIssues = validateWebProjectConsistency(fileContents, planSpec, mechanicalAdvisory);
        webConsistencyIssues.forEach((issue) => issues.push(issue));
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
        if (name === 'list_dir') return withTarget('Scanning folder');
        if (name === 'search_files') return withTarget('Searching files');
        if (name === 'read_file') return withTarget('Reading file');
        if (name === 'write_file') return withTarget('Writing file');
        if (name === 'edit_file') return withTarget('Editing file');
        if (name === 'validate_files') return 'Checking written files';
        if (name === 'check_code') return 'Checking syntax';
        if (name === 'run_app') return 'Running the app';
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
      getJsSyntaxIssue,
      getJsReassignedConstIssue,
      getHtmlStructureIssue,
      getStructuralIssueForPath,
      validateWebProjectConsistency,
    };
  }

  global.AIExeAgentExecutor = {
    createAgentExecutor,
  };
})(window);
