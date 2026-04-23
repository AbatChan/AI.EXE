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
      : ((content) => /placeholder|todo:|coming soon|implement this/i.test(String(content || '')));
    const WEB_TASK_HINT_REGEX = /\b(html|css|javascript|website|web|site|landing page|page|frontend|browser|ui)\b/i;

    function sanitizeProjectSlug(candidate, projectKind = '') {
      let slug = String(candidate || '')
        .toLowerCase()
        .replace(/^(can-you|could-you|would-you|please|help-me|i-need|i-want|make-me|build-me|design-me)-?/i, '')
        .replace(/[^a-z0-9\s_-]+/gi, ' ')
        .replace(/\b(simple|nice|modern|clean|beautiful|responsive|basic|small|cool)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(a|an|the)\s+/i, '')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      if (!slug) return '';
      if (projectKind === 'game' && !slug.endsWith('-game')) slug = `${slug}-game`;
      if (projectKind === 'site' && !slug.endsWith('-site')) slug = `${slug}-site`;
      if (projectKind === 'dashboard' && !slug.endsWith('-dashboard')) slug = `${slug}-dashboard`;
      if (projectKind === 'website' && !slug.endsWith('-website')) slug = `${slug}-website`;
      if (projectKind === 'api' && !slug.endsWith('-api')) slug = `${slug}-api`;
      if (projectKind === 'cli' && !slug.endsWith('-cli')) slug = `${slug}-cli`;
      return slug;
    }

    function parsedProjectNameLooksUsable(value, taskText = '') {
      const raw = String(value || '').trim();
      if (!raw) return false;
      if (raw.length > 48) return false;
      if (/[/.\\]/.test(raw)) return false;
      if (/\b(return exactly|json object|write_file|read_file|tool|step|rules:|keys:|action:|message:)\b/i.test(raw)) return false;
      const lower = raw.toLowerCase();
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
      const clean = candidate
        .replace(/^(create|build|make|start|set up|setup|generate|draft)\s+/gi, ' ')
        .replace(/\b(that|which|with|for|using|in|on|to|from|runs|run|running)\b[\s\S]*$/gi, ' ')
        .replace(/\b(python|javascript|typescript|react|vue|node|offline|local|simple|desktop|browser|web|small|business|businesses|for)\b/gi, ' ')
        .replace(/[^a-z0-9\s_-]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return '';
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

    function buildAgentFileGenerationHints(taskText, path) {
      const normalized = normalizeWorkspacePath(path || '');
      const hints = [];
      const lower = String(taskText || '').toLowerCase();
      if (normalized === '/README.md') {
        hints.push('Describe what the project does.');
        hints.push('Include setup and run instructions.');
        hints.push('Mention the main file and any dependencies.');
        hints.push('Do not invent repository URLs, git clone commands, or placeholder usernames if the project is local-only.');
        hints.push('Reference the actual source file names and commands from RECENT_TOOL_RESULTS. Do not invent a different main file name.');
      }
      if (isAgentTaskSoftwareProject(lower)) {
        hints.push('Prefer a self-contained offline MVP with as few external runtime requirements as possible unless the user explicitly requested a stack.');
      }
      if (isAgentBudgetTrackerTask(lower)) {
        hints.push('Include real budget tracking features such as add expense or income, listing entries, totals, and category or date fields.');
        hints.push('Persist data locally if the task says offline.');
      }
      if (/offline/.test(lower)) {
        hints.push('Use local storage or local files for persistence instead of any network service.');
      }
      if (/\bsmall business|businesses\b/.test(lower)) {
        hints.push('Make the MVP practical for a small business workflow, with categories and summary totals.');
      }
      if (/\.html?$/i.test(normalized)) {
        hints.push('Return only HTML markup for this file.');
        hints.push('Do not output CSS rules as the main body of this file.');
        hints.push('Do not output JavaScript as the main body of this file.');
        hints.push('If the project has separate styles.css or script.js files, prefer linking them instead of embedding large inline <style> or <script> blocks.');
      }
      if (/\.css$/i.test(normalized)) {
        hints.push('Return only CSS for this file.');
        hints.push('Do not output HTML, <html>, <head>, <body>, <script>, or full document markup.');
      }
      if (/\.(js|ts|jsx|tsx)$/i.test(normalized)) {
        hints.push('Return only JavaScript or TypeScript source for this file.');
        hints.push('Do not output HTML, <script> tags, or CSS rules.');
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
      let thought = '';
      const firstCurly = raw.indexOf('{');
      const firstDecision = raw.indexOf('<decision>');
      const firstMarker = firstCurly >= 0 && firstDecision >= 0 ? Math.min(firstCurly, firstDecision) : Math.max(firstCurly, firstDecision);
      if (firstMarker > 0) {
        let t = raw.slice(0, firstMarker).replace(/```[a-z]*\s*$/i, '').trim();
        t = t.replace(/^```[a-z]*\s*/i, '').trim();
        t = t.replace(/^<\/?thought>\s*/gi, '').replace(/<\/?thought>$/gi, '').trim();
        if (t.length > 5) thought = t;
        if (/Keys:\s+action,\s+message,\s+tool/i.test(thought) || /Rules:\s*-\s*One step only/i.test(thought) || /Return EXACTLY ONE JSON object/i.test(thought)) {
          thought = '';
        }
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

      if (!action && /"action"\s*:\s*"[^"]+"/i.test(candidate)) {
        let parsed = null;
        try {
          parsed = JSON.parse(candidate);
        } catch (_) {
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
        }
      }

      if (!action && !tool && !path && !message && !srcPath && !dstPath && !content) {
        return null;
      }
      const normalizedAction = String(action || '').trim().toLowerCase();
      const validTools = ['none', 'new_project', 'list_dir', 'read_file', 'write_file', 'edit_file', 'validate_files', 'mkdir', 'move', 'delete'];
      let resolvedAction = normalizedAction;
      let resolvedTool = String(tool || '').toLowerCase();
      // Auto-repair: model put tool name in action field (e.g. "action": "read_file")
      if (!['tool', 'final'].includes(resolvedAction) && validTools.includes(resolvedAction)) {
        resolvedTool = resolvedAction;
        resolvedAction = 'tool';
      }
      if (!['tool', 'final'].includes(resolvedAction)) {
        return null;
      }
      if (resolvedAction === 'tool' && !validTools.includes(resolvedTool)) {
        return null;
      }
      return {
        action: resolvedAction,
        message: String(message || '').trim(),
        tool: validTools.includes(resolvedTool) ? resolvedTool : 'none',
        path: String(path || '').trim(),
        content: String(content || ''),
        srcPath: String(srcPath || '').trim(),
        dstPath: String(dstPath || '').trim(),
        thought: String(thought || '').trim(),
        raw,
      };
    }

    function deriveFallbackAgentDecision(taskText, toolEvents, planSpec = null) {
      const taskKind = String(planSpec && planSpec.taskKind ? planSpec.taskKind : '').toLowerCase();
      if (taskKind === 'project') {
        const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
        const explicitSeparateWorkspaceIntent = /\b(new project|new workspace|another project|separate project|different project|start from scratch|from scratch)\b/i.test(String(taskText || ''));
        const hasWorkspace = typeof deps.getWorkspaceContext === 'function'
          ? Boolean(String((deps.getWorkspaceContext() || {}).workspaceRootName || '').trim())
          : false;
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
        const writtenPaths = Array.isArray(toolEvents)
          ? toolEvents
            .filter((event) => event && event.ok && ['write_file', 'edit_file', 'mkdir'].includes(String(event.tool || '').toLowerCase()))
            .map((event) => normalizeWorkspacePath(event.path || ''))
            .filter(Boolean)
          : [];
        const nextPath = expectedFiles.find((path) => {
          const normalized = normalizeWorkspacePath(path || '');
          return normalized && normalized !== '/README.md' && !writtenPaths.includes(normalized);
        }) || expectedFiles.find((path) => normalizeWorkspacePath(path || '') === '/README.md' && !writtenPaths.includes('/README.md'))
          || '';
        if (nextPath) {
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
      }
      if (taskKind === 'analysis') return null;
      const inferredEditTask = taskKind === 'edit' || !/\b(create|build|make|start|setup|set up)\b/i.test(String(taskText || ''));
      if (!inferredEditTask || !Array.isArray(toolEvents) || !toolEvents.length) return null;

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

      const alreadyUpdated = toolEvents.slice(latestReadIndex + 1).some((event) => (
        event
        && event.ok
        && String(event.tool || '').toLowerCase() === 'write_file'
        && normalizeWorkspacePath(event.path || '') === latestRead.path
      ));
      if (alreadyUpdated) return null;

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
        tool: 'write_file',
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
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        cleaned = cleaned.slice(start, end + 1).trim();
      }
      let parsed = null;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        return null;
      }
      const edits = Array.isArray(parsed && parsed.edits) ? parsed.edits : [];
      const normalizedEdits = edits.map((edit) => ({
        op: String(edit && edit.op ? edit.op : '').toLowerCase(),
        find: String(edit && edit.find ? edit.find : ''),
        replace: String(edit && edit.replace ? edit.replace : ''),
        text: String(edit && edit.text ? edit.text : ''),
      })).filter((edit) => ['replace', 'replace_all', 'insert_before', 'insert_after', 'prepend', 'append'].includes(edit.op));
      if (!normalizedEdits.length) return null;
      return { edits: normalizedEdits };
    }

    function applyAgentEditProgram(sourceText, program) {
      let output = String(sourceText || '');
      const edits = Array.isArray(program && program.edits) ? program.edits : [];
      let appliedCount = 0;
      for (const edit of edits) {
        if (!edit || !edit.op) continue;
        if (edit.op === 'prepend') {
          output = String(edit.text || '') + output;
          appliedCount += 1;
          continue;
        }
        if (edit.op === 'append') {
          output += String(edit.text || '');
          appliedCount += 1;
          continue;
        }
        const find = String(edit.find || '');
        if (!find) continue;
        if (edit.op === 'replace') {
          if (!output.includes(find)) continue;
          output = output.replace(find, String(edit.replace || ''));
          appliedCount += 1;
          continue;
        }
        if (edit.op === 'replace_all') {
          if (!output.includes(find)) continue;
          output = output.split(find).join(String(edit.replace || ''));
          appliedCount += 1;
          continue;
        }
        if (edit.op === 'insert_before') {
          const index = output.indexOf(find);
          if (index < 0) continue;
          output = `${output.slice(0, index)}${String(edit.text || '')}${output.slice(index)}`;
          appliedCount += 1;
          continue;
        }
        if (edit.op === 'insert_after') {
          const index = output.indexOf(find);
          if (index < 0) continue;
          const insertAt = index + find.length;
          output = `${output.slice(0, insertAt)}${String(edit.text || '')}${output.slice(insertAt)}`;
          appliedCount += 1;
        }
      }
      return { output, appliedCount };
    }

    function parseAgentExpectedFiles(raw) {
      return String(raw || '')
        .split('|')
        .map((item) => normalizeWorkspacePath(item))
        .filter((item) => item && item !== '/')
        .slice(0, 8);
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
        return ['/index.html', '/styles.css', '/script.js'];
      }
      return base ? [`/${base}.txt`] : ['/main.txt'];
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

    function isExistingProjectMutationRequest(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      if (!lower) return false;
      const mutationIntent = /\b(add|update|edit|modify|change|fix|delete|remove|rename|refactor|improve|create)\b/.test(lower);
      const existingProjectTarget = /\b(project|workspace|code|file|files|readme|docs?|current|existing|this)\b/.test(lower);
      const explicitNewProject = /\b(new project|new workspace|from scratch|separate project|brand new)\b/.test(lower);
      return mutationIntent && existingProjectTarget && !explicitNewProject;
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

    function normalizeAgentPlanSpec(parsed, taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      const projectLikeFallback = (
        /\b(create|build|make|start|setup|set up|design|develop|generate|craft)\b/.test(lower)
        && /\b(project|app|site|website|page|tool|game|dashboard|calculator|frontend|ui)\b/.test(lower)
      );
      const explicitDocsTask = isExplicitReadmeOrDocsTask(taskText);
      const workspaceScopedMutation = hasOpenWorkspaceContext() && isExistingProjectMutationRequest(taskText);
      let taskKind = ['project', 'edit', 'analysis'].includes(String(parsed && parsed.task_kind || '').toLowerCase())
        ? String(parsed.task_kind).toLowerCase()
        : (projectLikeFallback ? 'project' : 'edit');
      if (!workspaceScopedMutation && projectLikeFallback && taskKind !== 'analysis') {
        taskKind = 'project';
      }
      if ((explicitDocsTask || workspaceScopedMutation) && taskKind === 'project' && !/\b(new project|new workspace|from scratch|separate project|brand new)\b/.test(lower)) {
        taskKind = 'edit';
      }
      let primaryStack = ['python', 'web', 'generic'].includes(String(parsed && parsed.primary_stack || '').toLowerCase())
        ? String(parsed.primary_stack).toLowerCase()
        : (/python|pygame|\.py\b/.test(lower) ? 'python' : ((WEB_TASK_HINT_REGEX.test(lower) || /\bcalculator\b/.test(lower)) ? 'web' : 'generic'));
      const parsedProjectName = normalizeWorkspaceName(parsed && parsed.project_name ? parsed.project_name : '');
      const fallbackProjectName = deriveProjectNameFromTask(taskText);
      const projectName = parsedProjectNameLooksUsable(parsedProjectName, taskText)
        ? sanitizeProjectSlug(parsedProjectName)
        : fallbackProjectName;
      let expectedFiles = parseAgentExpectedFiles(parsed && parsed.expected_files ? parsed.expected_files : '');
      expectedFiles = expectedFiles.filter((path) => !/\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?)$/i.test(String(path || '')));
      const looksLikeWebProjectTask = taskKind === 'project' && (WEB_TASK_HINT_REGEX.test(lower) || /\bcalculator\b/.test(lower));
      const expectedFilesLookLikeGenericText = expectedFiles.length > 0 && expectedFiles.every((path) => /\.(txt|md)$/i.test(String(path || '')));
      if (looksLikeWebProjectTask && (primaryStack === 'generic' || expectedFilesLookLikeGenericText)) {
        primaryStack = 'web';
        expectedFiles = [];
      }
      if (explicitDocsTask && expectedFiles.length === 0) {
        expectedFiles = ['/README.md'];
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
      const needsReadme = requestedReadme || requestedRunInstructions;
      const needsRunInstructions = requestedRunInstructions;
      const finalRequiresRealFiles = !explicitDocsTask && taskKind === 'project' && (
        String(parsed && parsed.final_requires_real_files || '').toLowerCase() === 'yes'
        || taskKind === 'project'
      );
      if (taskKind === 'project' && expectedFiles.length === 0) {
        expectedFiles = buildFallbackExpectedFiles(taskKind, primaryStack, projectName || deriveProjectNameFromTask(taskText));
      }
      return {
        taskKind,
        projectName: projectName || deriveProjectNameFromTask(taskText),
        primaryStack,
        needsReadme,
        needsRunInstructions,
        finalRequiresRealFiles,
        expectedFiles,
        summary: String(parsed && parsed.summary ? parsed.summary : '').trim().slice(0, 220),
      };
    }

    function buildFallbackAgentPlanSpec(taskText = '') {
      const lower = String(taskText || '').toLowerCase();
      const explicitDocsTask = isExplicitReadmeOrDocsTask(taskText);
      const workspaceScopedMutation = hasOpenWorkspaceContext() && isExistingProjectMutationRequest(taskText);
      const projectLikeFallback = (
        /\b(create|build|make|start|setup|set up|design|develop|generate|craft)\b/.test(lower)
        && /\b(project|app|site|website|page|tool|game|dashboard|calculator|frontend|ui)\b/.test(lower)
      );
      const taskKind = explicitDocsTask
        ? 'edit'
        : workspaceScopedMutation
        ? 'edit'
        : projectLikeFallback
        ? 'project'
        : (/\b(check|verify|review|inspect|analy[sz]e|compare|correlate|audit|look at)\b/.test(lower) ? 'analysis' : 'edit');
      const primaryStack = /python|pygame|\.py\b/.test(lower)
        ? 'python'
        : (((WEB_TASK_HINT_REGEX.test(lower) || /\bcalculator\b/.test(lower))) ? 'web' : 'generic');
      const needsReadme = shouldFallbackPlanNeedReadme(taskText);
      const projectName = deriveProjectNameFromTask(taskText);
      return {
        taskKind,
        projectName,
        primaryStack,
        needsReadme,
        needsRunInstructions: needsReadme,
        finalRequiresRealFiles: explicitDocsTask ? false : taskKind === 'project',
        expectedFiles: explicitDocsTask ? ['/README.md'] : buildFallbackExpectedFiles(taskKind, primaryStack, projectName),
        summary: '',
      };
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
      buildFallbackExpectedFiles,
      shouldFallbackPlanNeedReadme,
      isExplicitReadmeOrDocsTask,
      isExistingProjectMutationRequest,
      normalizeAgentPlanSpec,
      buildFallbackAgentPlanSpec,
    };
  }

  global.AIExeAgentCore = {
    createAgentCore,
  };
})(window);
