(function initAIExeAgentPlanner(global) {
  function createAgentPlanner(deps) {
    const normalizeWorkspacePath = deps.normalizeWorkspacePath;
    const isAgentTaskGameLike = deps.isAgentTaskGameLike;
    const hasReadmeRunInstructions = deps.hasReadmeRunInstructions;
    const isLikelyCompleteReadme = deps.isLikelyCompleteReadme;
    const isExplicitReadmeOrDocsTask = deps.isExplicitReadmeOrDocsTask;
    const isDocsOnlyTask = typeof deps.isDocsOnlyTask === 'function'
      ? deps.isDocsOnlyTask
      : (taskText = '') => {
        const lower = String(taskText || '').toLowerCase();
        const createsSoftware = /\b(create|build|make|start|setup|set up|design|develop|generate|craft)\b/.test(lower)
          && /\b(project|app|site|website|page|tool|game|dashboard|calculator|frontend|ui)\b/.test(lower);
        return !createsSoftware && typeof isExplicitReadmeOrDocsTask === 'function' && isExplicitReadmeOrDocsTask(taskText);
      };
    const buildFallbackAgentPlanSpec = deps.buildFallbackAgentPlanSpec;
    const buildAgentFileGenerationHints = deps.buildAgentFileGenerationHints;
    const loadPromptTemplate = deps.loadPromptTemplate;
    const renderPromptTemplate = deps.renderPromptTemplate;
    const buildAgentHistoryTranscript = deps.buildAgentHistoryTranscript;
    const requestAgentPlannerInference = deps.requestAgentPlannerInference;
    const getWorkspaceContext = deps.getWorkspaceContext;
    const deriveProjectNameFromTask = deps.deriveProjectNameFromTask;
    const agentMaxSteps = Number(deps.agentMaxSteps) || 16;
    const agentMaxToolOutputChars = Number(deps.agentMaxToolOutputChars) || 8000;
    const getAgentExpandedReadChars = typeof deps.getAgentExpandedReadChars === 'function'
      ? deps.getAgentExpandedReadChars
      : () => 0;
    const agentDecisionMaxTokens = Number(deps.agentDecisionMaxTokens) || 120;
    const agentPlanGrammar = String(deps.agentPlanGrammar || '');
    const agentStepTimeoutMs = Number(deps.agentStepTimeoutMs) || 20000;

    function looksLikePlaceholderImplementation(content) {
      const text = String(content || '').toLowerCase();
      // 'todo:' removed — it collides with real domain code (kanban `todo:` keys).
      return [
        'functionality here',
        'placeholder code',
        'placeholder for',
        'placeholder content',
        'coming soon',
        'start developing',
        'implement this',
      ].some((snippet) => text.includes(snippet));
    }

    function isLikelyCompletePythonProjectSource(content) {
      const text = String(content || '');
      const lower = text.toLowerCase();
      let score = 0;
      if (/def\s+\w+/i.test(text) || /class\s+\w+/i.test(text)) score += 1;
      if (/if __name__ == ['"]__main__['"]:/i.test(text)) score += 1;
      if (/input\s*\(|print\s*\(|tkinter|mainloop\s*\(/i.test(text) || /argparse|click\./i.test(text)) score += 1;
      if (/\b(save|load|read|write|open\s*\(|json|sqlite|csv)\b/i.test(lower)) score += 1;
      if (looksLikePlaceholderImplementation(text)) return false;
      return text.trim().length >= 800 && score >= 3;
    }

    function isLikelyCompleteJavaScriptProjectSource(content, taskText = '') {
      const text = String(content || '');
      const lower = text.toLowerCase();
      const lowerTask = String(taskText || '').toLowerCase();
      let score = 0;
      if (/function\s+\w+|const\s+\w+\s*=|class\s+\w+/i.test(text)) score += 1;
      if (/addEventListener|onclick|document\.querySelector|getElementById|localStorage|module\.exports|export\s+/i.test(text)) score += 1;
      if (/\b(save|load|render|update|delete|remove|list|total|summary)\b/i.test(lower)) score += 1;
      if (looksLikePlaceholderImplementation(text)) return false;
      const isDomScript = /addEventListener|onclick|document\.querySelector|getElementById|classList|textContent|innerHTML/i.test(text);
      const hasInteraction = /click|submit|input|change|keydown|toggle|show|hide|reveal|surprise/i.test(lower);
      const taskWantsReveal = /\b(surprise|reveal|secret|easter egg|modal|landing|website|site|page)\b/i.test(lowerTask);
      if (text.trim().length >= 320 && isDomScript && hasInteraction && (taskWantsReveal || score >= 2)) return true;
      return text.trim().length >= 700 && score >= 3;
    }

    // Robust "is this a real, finished program" check. Avoids domain-keyword
    // scoring (pygame-only, CRUD-only) that false-flagged complete programs such as
    // a curses Snake game. A substantial, structured, non-placeholder file with an
    // entry point or loop is considered complete; stubs/truncation still fail.
    function isLikelyCompletePythonSource(content) {
      const text = String(content || '');
      if (looksLikePlaceholderImplementation(text)) return false;
      if (text.trim().length < 600) return false;
      const hasStructure = /\bdef\s+\w+|\bclass\s+\w+/.test(text);
      const hasEntryOrLoop = /if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(text)
        || /\bwhile\s+[^\n:]+:/.test(text)
        || /\bfor\s+\w+\s+in\b/.test(text)
        || /\.mainloop\s*\(|curses\.wrapper\s*\(|\bpygame\b|\binput\s*\(|\bprint\s*\(/.test(text);
      return hasStructure && hasEntryOrLoop;
    }

    function isLikelyCompletePrimarySource(path, content, taskText) {
      const normalized = normalizeWorkspacePath(path || '');
      if (/\.py$/i.test(normalized)) {
        return isLikelyCompletePythonSource(content);
      }
      if (/\.(js|ts|jsx|tsx)$/i.test(normalized)) {
        return isLikelyCompleteJavaScriptProjectSource(content, taskText);
      }
      if (/\.html$/i.test(normalized)) {
        const text = String(content || '');
        const lower = text.toLowerCase();
        return text.trim().length >= 400 && /<html|<body|<script|<main|<section/i.test(lower) && !looksLikePlaceholderImplementation(text);
      }
      return String(content || '').trim().length >= 500 && !looksLikePlaceholderImplementation(content);
    }

    function getLatestSuccessfulAgentSourceWrite(toolEvents, predicate = null) {
      const events = Array.isArray(toolEvents) ? toolEvents : [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || !['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) || !event.ok) continue;
        const normalized = normalizeWorkspacePath(event.path || '');
        if (!normalized || normalized === '/README.md') continue;
        if (!/\.(py|js|ts|tsx|jsx|html|css|json|md)$/i.test(normalized) && !normalized.startsWith('/src/')) continue;
        if (predicate && !predicate(event, normalized)) continue;
        return event;
      }
      return null;
    }

    function getLatestSuccessfulAgentWrite(toolEvents, predicate) {
      const events = Array.isArray(toolEvents) ? toolEvents : [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || !['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) || !event.ok) continue;
        if (!predicate || predicate(event)) return event;
      }
      return null;
    }

    function hasSuccessfulAgentTool(toolEvents, predicate) {
      return Array.isArray(toolEvents) && toolEvents.some((event) => {
        if (!event || !event.ok) return false;
        if (predicate) return Boolean(predicate(event));
        return true;
      });
    }

    function buildAgentTaskRequirements(taskText, toolEvents = [], planSpec = null) {
      const text = String(taskText || '').trim();
      const lower = text.toLowerCase();
      const requirements = [];
      const plan = planSpec && typeof planSpec === 'object'
        ? planSpec
        : buildFallbackAgentPlanSpec(taskText);
      const isSoftwareProject = plan.taskKind === 'project';
      const isAnalysisTask = plan.taskKind === 'analysis';
      const isPythonTask = plan.primaryStack === 'python';
      const isGameTask = isAgentTaskGameLike(lower);
      const isDocsTask = isDocsOnlyTask(text);
      const isRenameTask = /\brename\b/.test(lower);
      const workspace = typeof getWorkspaceContext === 'function' ? getWorkspaceContext() || {} : {};
      const workspaceAlreadyOpen = Boolean(
        String(workspace.workspaceRootName || '').trim()
        || Number(workspace.rootEntryCount) > 0
        || Boolean(workspace.rootLoaded)
        || normalizeWorkspacePath(workspace.currentPath || '/') !== '/'
      );
      const explicitSeparateWorkspaceIntent = /\b(new project|new workspace|fresh workspace|another project|separate project|different project|start from scratch|from scratch)\b/i.test(text);
      const plannedAffectedFiles = Array.isArray(plan.affectedFiles)
        ? plan.affectedFiles.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean)
        : [];
      const plannedInspectFiles = Array.isArray(plan.filesToInspect)
        ? plan.filesToInspect.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean)
        : [];
      const validationSteps = Array.isArray(plan.validationSteps)
        ? plan.validationSteps.map((step) => String(step || '').toLowerCase()).filter(Boolean)
        : [];

      const readmeWrite = getLatestSuccessfulAgentWrite(toolEvents, (event) => normalizeWorkspacePath(event.path || '') === '/README.md');
      const primarySourceWrite = getLatestSuccessfulAgentSourceWrite(toolEvents, (event, normalized) => {
        if (isPythonTask) return /\.py$/i.test(normalized);
        return true;
      });

      if (isSoftwareProject) {
        requirements.push({
          id: 'project_root',
          label: 'create the project workspace',
          met: (workspaceAlreadyOpen && !explicitSeparateWorkspaceIntent)
            || hasSuccessfulAgentTool(toolEvents, (event) => event.tool === 'new_project'),
        });
      }

      if (isSoftwareProject && (plan.expectedFiles.includes('/src') || /\bsrc\b/.test(lower))) {
        requirements.push({
          id: 'src_folder',
          label: 'create the /src folder',
          met: hasSuccessfulAgentTool(toolEvents, (event) => event.tool === 'mkdir' && normalizeWorkspacePath(event.path || '') === '/src'),
        });
      }

      if (isSoftwareProject && plan.needsReadme) {
        requirements.push({
          id: 'readme_file',
          label: 'write /README.md',
          met: Boolean(readmeWrite && String(readmeWrite.content || '').trim().length >= 80),
        });
      }

      if (isSoftwareProject && plan.needsRunInstructions) {
        requirements.push({
          id: 'readme_run_instructions',
          label: 'add run instructions to /README.md',
          met: Boolean(readmeWrite && String(readmeWrite.content || '').trim().length >= 80),
        });
      }

      if (isDocsTask) {
        requirements.push({
          id: 'readme_file',
          label: readmeWrite ? 'update /README.md' : 'write /README.md',
          met: Boolean(readmeWrite && String(readmeWrite.content || '').trim().length >= 80),
        });
        requirements.push({
          id: 'readme_grounded',
          label: 'inspect the real implementation before finalizing the README',
          met: hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'read_file'
            && normalizeWorkspacePath(event.path || '') !== '/README.md'),
        });
      }

      if (plan.finalRequiresRealFiles) {
        requirements.push({
          id: 'main_source_file',
          label: 'create the main implementation file',
          met: Boolean(primarySourceWrite && String(primarySourceWrite.content || '').trim()),
        });
      }

      if (plan.finalRequiresRealFiles && primarySourceWrite) {
        const primaryPath = normalizeWorkspacePath(primarySourceWrite.path || '');
        requirements.push({
          id: 'main_source_complete',
          label: isGameTask
            ? `make ${primaryPath || 'the main implementation file'} complete and runnable`
            : `make ${primaryPath || 'the main implementation file'} non-placeholder and usable`,
          met: isLikelyCompletePrimarySource(primarySourceWrite.path || '', primarySourceWrite.content || '', lower),
        });
      }

      plan.expectedFiles
        .filter((path) => isSoftwareProject && !isDocsTask && path && path !== '/README.md' && path !== '/src')
        .slice(0, 6)
        .forEach((path) => {
          requirements.push({
            id: `expected_${path}`,
            label: `${plan.taskKind === 'edit' ? 'update' : 'write'} ${path}`,
            met: hasSuccessfulAgentTool(toolEvents, (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) && normalizeWorkspacePath(event.path || '') === path),
          });
        });

      if (!isSoftwareProject) {
        plannedInspectFiles.slice(0, 8).forEach((path) => {
          requirements.push({
            id: `inspect_${path}`,
            label: `inspect ${path}`,
            met: hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'read_file' && normalizeWorkspacePath(event.path || '') === path),
          });
        });

        plannedAffectedFiles.slice(0, 8).forEach((path) => {
          requirements.push({
            id: `affected_${path}`,
            label: `update ${path}`,
            met: hasSuccessfulAgentTool(toolEvents, (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) && normalizeWorkspacePath(event.path || '') === path),
          });
        });
      }

      const expectedNonReadmeFiles = plan.expectedFiles
        .filter((path) => !isDocsTask && path && path !== '/README.md' && path !== '/src');
      const allExpectedFilesWritten = expectedNonReadmeFiles.length > 0
        && expectedNonReadmeFiles.every((path) => hasSuccessfulAgentTool(
          toolEvents,
          (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) && normalizeWorkspacePath(event.path || '') === path,
        ));
      const validateRequested = validationSteps.some((step) => /validate_files|static|syntax|check|test|verify/.test(step));
      const plannedAffectedFilesUpdated = plannedAffectedFiles.length > 0
        && plannedAffectedFiles.every((path) => hasSuccessfulAgentTool(
          toolEvents,
          (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) && normalizeWorkspacePath(event.path || '') === path,
        ));
      if ((isSoftwareProject && allExpectedFilesWritten) || (!isSoftwareProject && validateRequested && plannedAffectedFilesUpdated)) {
        requirements.push({
          id: 'validate_written_files',
          label: isSoftwareProject ? 'validate the written project files' : 'validate the updated files',
          met: hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true),
        });
      }

      if (!requirements.length) {
        const hasMutation = hasSuccessfulAgentTool(toolEvents, (event) => {
          const tool = String(event.tool || '').toLowerCase();
          return ['write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(tool);
        });
        requirements.push({
          id: 'deliverable',
          label: isAnalysisTask ? 'inspect the relevant workspace files and answer the request' : 'finish the planned work',
          met: hasSuccessfulAgentTool(toolEvents, (event) => {
            const tool = String(event.tool || '').toLowerCase();
            if (isAnalysisTask) {
              return ['read_file', 'list_dir', 'validate_files'].includes(tool);
            }
            if (isRenameTask) {
              return tool === 'move';
            }
            return ['write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(tool);
          }),
        });
        if (!isAnalysisTask && hasMutation) {
          requirements.push({
            id: 'validate_after_unscoped_edit',
            label: 'validate the updated files',
            met: hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true),
          });
        }
      }

      return requirements;
    }

    function summarizeAgentPendingRequirements(taskText, toolEvents = [], planSpec = null) {
      const missing = buildAgentTaskRequirements(taskText, toolEvents, planSpec)
        .filter((item) => !item.met)
        .map((item) => `- ${item.label}`);
      return missing.length ? missing.join('\n') : '- none';
    }

    function validateAgentFinalDecision(taskText, toolEvents = [], planSpec = null) {
      const requirements = buildAgentTaskRequirements(taskText, toolEvents, planSpec);
      const missing = requirements.filter((item) => !item.met).map((item) => item.label);
      return {
        ok: missing.length === 0,
        missing,
      };
    }

    async function buildAgentDecisionRepairPrompt(taskText, toolEvents, stepIndex, badOutput, planSpec = null) {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const template = await loadPromptTemplate('developer_agent_decision_repair');
      if (template) {
        return renderPromptTemplate(template, {
          AGENT_STEP: Number(stepIndex),
          AGENT_MAX_STEPS: agentMaxSteps,
          TASK: String(taskText || '').trim(),
          PENDING_REQUIREMENTS: summarizeAgentPendingRequirements(taskText, toolEvents, planSpec),
          TOOL_RESULTS: toolLog || '(none yet)',
          INVALID_OUTPUT_TO_AVOID: String(badOutput || '').slice(0, 1200),
        });
      }
      return [
        'You previously returned invalid output.',
        'Return EXACTLY ONE JSON object block wrapped in ```json.',
        'Before the JSON block, you MAY output a short paragraph of text explaining what you are exploring or why it was invalid.',
        'If you are confident, DO NOT write prose. Omit the thought paragraph immediately to save time.',
        'Keys: action, message, tool, path, content, src_path, dst_path',
        'Valid action values: tool or final.',
        'Valid tool values: none, new_project, list_dir, read_file, write_file, edit_file, validate_files, mkdir, move, delete.',
        'For write_file, keep content empty unless a short literal payload is necessary.',
        'For edit_file, put the JSON edit program inside content.',
        'If the task is not done yet, return {"action":"tool",...}.',
        'If the task is complete, return {"action":"final","tool":"none",...}.',
        'If validate_files finds issues, DO NOT call validate_files again. Read and fix the specific files.',
        `Agent step: ${Number(stepIndex)}/${agentMaxSteps}`,
        'TASK:',
        String(taskText || '').trim(),
        'PENDING_REQUIREMENTS:',
        summarizeAgentPendingRequirements(taskText, toolEvents, planSpec),
        'TOOL_RESULTS:',
        toolLog || '(none yet)',
        'INVALID_OUTPUT_TO_AVOID:',
        String(badOutput || '').slice(0, 1200),
        'JSON:',
      ].join('\n');
    }

    function sanitizeAgentGeneratedFileContent(outputText, path = '') {
      let text = String(outputText || '').replace(/\r/g, '').trim();
      if (!text) return '';
      const normalizedPath = normalizeWorkspacePath(path || '');
      const extension = (normalizedPath.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
      const languageAliases = {
        html: ['html', 'htm'],
        htm: ['html', 'htm'],
        css: ['css', 'scss', 'sass', 'less'],
        js: ['javascript', 'js', 'node'],
        mjs: ['javascript', 'js', 'mjs', 'node'],
        cjs: ['javascript', 'js', 'cjs', 'node'],
        ts: ['typescript', 'ts', 'javascript', 'js'],
        jsx: ['jsx', 'javascript', 'js'],
        tsx: ['tsx', 'typescript', 'ts', 'jsx'],
        py: ['python', 'py'],
        md: ['markdown', 'md'],
        json: ['json'],
      };
      const wantedLanguages = languageAliases[String(extension || '').toLowerCase()] || [String(extension || '').toLowerCase()];
      const fencedBlocks = [];
      for (const match of text.matchAll(/```([a-z0-9_+\-]*)\s*([\s\S]*?)```/gi)) {
        const language = String(match[1] || '').trim().toLowerCase();
        const body = String(match[2] || '').trim();
        if (!body) continue;
        fencedBlocks.push({ language, body });
      }
      if (fencedBlocks.length) {
        const matched = fencedBlocks.find((block) => wantedLanguages.includes(block.language))
          || fencedBlocks.find((block) => !block.language)
          || fencedBlocks[0];
        if (matched && matched.body) {
          text = matched.body;
        }
      }
      const leakedPrompt = /return only the file contents\.|file path:\s*\/|mvp_requirements:|recent_tool_results:|file_content:/i.test(text);
      const fencedBlock = text.match(/```[a-z0-9_-]*\s*([\s\S]*?)```/i);
      if (leakedPrompt && fencedBlock && fencedBlock[1]) {
        text = String(fencedBlock[1] || '').trim();
      }
      text = text
        .replace(/^.*?\bFILE_CONTENT:\s*/is, '')
        .replace(/^(?:Return only the file contents\..*|File path:\s*.*|Rules:\s*|MVP_REQUIREMENTS:\s*|TASK:\s*|RECENT_TOOL_RESULTS:\s*|PREVIOUS_ATTEMPT_TO_IMPROVE:\s*)$/gim, '')
        .trim();
      // Drop leaked prompt-scaffolding lines wherever they appear. A weak local model
      // can echo the contract / requirements / date into the file body, interleaved
      // with the real code — the fence extraction above misses it when the code is
      // split across multiple mislabeled fences.
      text = text.split('\n').filter((line) => {
        const t = line.trim();
        if (/^(?:PROJECT_CONTRACT|Planned files|Quality contract|MVP_REQUIREMENTS|RECENT_TOOL_RESULTS|PREVIOUS_ATTEMPT_TO_IMPROVE|FILE_CONTENT|Generation budget contract|Web project contract|Python project contract)\s*:/i.test(t)) return false;
        if (/^(?:Today's date is|Current date)\b/i.test(t)) return false;
        if (/^-\s+(?:Build the complete|Reuse shared|Write a usable MVP|Keep the file internally|If this is(?: a)?\b|Prefer (?:a |self-contained)|Respect |Use the current year|Do not (?:ship|invent|output)|Return only |Treat this as)/i.test(t)) return false;
        return true;
      }).join('\n').trim();
      if (/^```/i.test(text)) {
        text = text.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      text = text
        .replace(/^Here(?:'|’)s the file(?: content)?[:\s-]*/i, '')
        .replace(/^Below is the file(?: content)?[:\s-]*/i, '')
        .trim();
      if (/^(?:-\s+(?:Write|Keep|If this|Prefer|Respect|Use|Follow|Never|Do not)\b[\s\S]*?\n)+(?:```)?/i.test(text)) {
        const firstLikelyCode = (() => {
          if (/\.(html?)$/i.test(normalizedPath)) return text.search(/<!doctype html\b|<html\b|<head\b|<body\b|<section\b|<main\b|<div\b/i);
          if (/\.css$/i.test(normalizedPath)) return text.search(/(?:^|\n)\s*(?:\/\*|:root\b|@media\b|@import\b|[.#a-z][^{;\n]*\{)/i);
          if (/\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(normalizedPath)) return text.search(/(?:^|\n)\s*(?:["']use strict["'];?|import\b|const\b|let\b|var\b|function\b|class\b|document\.|window\.)/i);
          if (/\.md$/i.test(normalizedPath)) return text.search(/(?:^|\n)\s*#/);
          return -1;
        })();
        if (firstLikelyCode > 0) {
          text = text.slice(firstLikelyCode).trim();
        }
      }
      if (/\.(html?)$/i.test(normalizedPath)) {
        const htmlStart = text.search(/<!doctype html\b|<html\b/i);
        if (htmlStart > 0) {
          text = text.slice(htmlStart).trim();
        }
      } else if (/\.css$/i.test(normalizedPath)) {
        const styleBlockMatch = text.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
        if (styleBlockMatch && styleBlockMatch[1]) {
          text = String(styleBlockMatch[1] || '').trim();
        }
        text = text
          .replace(/<!doctype html[\s\S]*$/i, '')
          .replace(/<html[\s\S]*$/i, '')
          .replace(/<head[\s\S]*$/i, '')
          .replace(/<body[\s\S]*$/i, '')
          .trim();
      } else if (/\.(js|ts|jsx|tsx)$/i.test(normalizedPath)) {
        const scriptBlockMatch = text.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
        if (scriptBlockMatch && scriptBlockMatch[1]) {
          text = String(scriptBlockMatch[1] || '').trim();
        }
        text = text
          .replace(/<!doctype html[\s\S]*$/i, '')
          .replace(/<html[\s\S]*$/i, '')
          .replace(/<head[\s\S]*$/i, '')
          .replace(/<body[\s\S]*$/i, '')
          .trim();
      }
      return text;
    }

    function sanitizeAgentGeneratedEditProgram(outputText) {
      let text = String(outputText || '').replace(/\r/g, '').trim();
      if (!text) return '';
      if (/^```/i.test(text)) {
        text = text.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        text = text.slice(start, end + 1).trim();
      }
      return text;
    }

    function summarizeFileSignals(path, content) {
      const normalized = normalizeWorkspacePath(path || '');
      const text = String(content || '');
      const pick = (items, limit = 80) => Array.from(new Set(items.filter(Boolean))).slice(0, limit);
      if (/\.html?$/i.test(normalized)) {
        const ids = pick(Array.from(text.matchAll(/\bid=["']([^"']+)["']/gi)).map((match) => String(match[1] || '').trim()));
        const classes = [];
        for (const match of text.matchAll(/\bclass=["']([^"']+)["']/gi)) {
          String(match[1] || '').split(/\s+/).forEach((name) => classes.push(String(name || '').trim()));
        }
        return [
          ids.length ? `HTML ids: ${ids.join(', ')}` : '',
          classes.length ? `HTML classes: ${pick(classes, 120).join(', ')}` : '',
        ].filter(Boolean).join('\n');
      }
      if (/\.(css|scss|sass|less)$/i.test(normalized)) {
        const classSelectors = pick(Array.from(text.matchAll(/\.([a-z_][a-z0-9_-]*)/gi)).map((match) => String(match[1] || '').trim()), 140);
        const idSelectors = pick(Array.from(text.matchAll(/#([a-z_][a-z0-9_-]*)/gi)).map((match) => String(match[1] || '').trim()).filter((id) => !/^[0-9a-f]{3,8}$/i.test(id)));
        return [
          classSelectors.length ? `CSS class selectors: ${classSelectors.join(', ')}` : '',
          idSelectors.length ? `CSS id selectors: ${idSelectors.join(', ')}` : '',
        ].filter(Boolean).join('\n');
      }
      if (/\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(normalized)) {
        const ids = pick(Array.from(text.matchAll(/getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/g)).map((match) => String(match[1] || '').trim()));
        const queriedClasses = pick(Array.from(text.matchAll(/querySelector(?:All)?\s*\(\s*['"]\.([a-z_][a-z0-9_-]*)['"]\s*\)/gi)).map((match) => String(match[1] || '').trim()));
        const mutatedClasses = pick(Array.from(text.matchAll(/classList\.(?:add|remove|toggle|contains)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)).map((match) => String(match[1] || '').trim()));
        return [
          ids.length ? `JS referenced ids: ${ids.join(', ')}` : '',
          queriedClasses.length ? `JS queried classes: ${queriedClasses.join(', ')}` : '',
          mutatedClasses.length ? `JS class mutations: ${mutatedClasses.join(', ')}` : '',
        ].filter(Boolean).join('\n');
      }
      return '';
    }

    function buildAgentProjectStateContext(toolEvents = [], planSpec = null, excludePath = '') {
      const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles)
        ? planSpec.expectedFiles.map((path) => normalizeWorkspacePath(path || '')).filter(Boolean)
        : [];
      const normalizedExclude = normalizeWorkspacePath(excludePath || '');
      const latestByPath = new Map();
      const validationIssues = [];
      (Array.isArray(toolEvents) ? toolEvents : []).forEach((event) => {
        if (!event) return;
        const tool = String(event.tool || '').toLowerCase();
        const path = normalizeWorkspacePath(event.path || event.writtenPath || event.readPath || '');
        if (event.validationPassed === false && Array.isArray(event.validationIssues)) {
          event.validationIssues.forEach((issue) => validationIssues.push(String(issue || '').trim()));
        }
        if (!path || !expectedFiles.includes(path)) return;
        if (['write_file', 'edit_file'].includes(tool) && typeof event.content === 'string') {
          latestByPath.set(path, String(event.content || ''));
        } else if (tool === 'read_file' && typeof event.content === 'string') {
          latestByPath.set(path, String(event.content || ''));
        }
      });
      const sections = [];
      // Ambient context (not a content rule): give the model the real current date so
      // generated dates / copyright years use the present, not a training-era default.
      // Framed as environment here (like the file signals) to minimize echo-into-file
      // risk; the sanitizer also strips it if a weak model leaks it.
      const today = new Date();
      sections.push(`Current date: ${today.toISOString().slice(0, 10)} (year ${today.getFullYear()}). Use ${today.getFullYear()} for any generated dates, sample data, or copyright years.`);
      if (expectedFiles.length) sections.push(`Expected files: ${expectedFiles.join(', ')}`);
      // Sibling context, window-driven: full content when it fits (chat-grade
      // coherence), the file's head + signals when it doesn't, signals only as
      // the last resort on tiny budgets.
      const expandedCap = Math.max(0, Number(getAgentExpandedReadChars()) || 0);
      let fullContentBudget = expandedCap > 20000 ? Math.min(expandedCap, 60000) : 0;
      expectedFiles.forEach((path) => {
        if (path === normalizedExclude) return;
        const content = latestByPath.has(path) ? String(latestByPath.get(path) || '') : '';
        if (!content.trim()) return;
        if (fullContentBudget > 0 && content.length <= fullContentBudget) {
          fullContentBudget -= content.length;
          sections.push(`CURRENT ${path} (full current content — make your file agree with it exactly: same ids, classes, defaults, units):\n${content}`);
          return;
        }
        const signals = summarizeFileSignals(path, content);
        if (fullContentBudget > 2400) {
          const headChars = Math.min(fullContentBudget - 400, 12000);
          fullContentBudget -= headChars;
          sections.push(`CURRENT ${path} (first ${headChars} chars — defaults/vars/refs live here; the rest is summarized below):\n${content.slice(0, headChars)}${signals ? `\nSIGNALS ${path} (rest of file):\n${signals}` : ''}`);
          return;
        }
        if (signals) sections.push(`SIGNALS ${path}:\n${signals}`);
      });
      if (validationIssues.length) {
        sections.push(`LATEST VALIDATION ISSUES:\n- ${validationIssues.slice(-12).join('\n- ')}`);
      }
      return sections.join('\n\n').trim();
    }

    async function buildAgentWriteFileContentPrompt(taskText, toolEvents, path, priorAttempt = '', planSpec = null) {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const generationHints = buildAgentFileGenerationHints(taskText, normalizedPath);
      const projectState = buildAgentProjectStateContext(toolEvents, planSpec, normalizedPath);
      const template = await loadPromptTemplate('developer_agent_write_file');
      if (template) {
        return renderPromptTemplate(template, {
          FILE_PATH: normalizedPath,
          MVP_REQUIREMENTS: generationHints.length ? `- ${generationHints.join('\n- ')}` : '',
          PROJECT_CONTRACT: String(planSpec && planSpec.projectContract ? planSpec.projectContract : ''),
          PROJECT_STATE: projectState,
          TASK: String(taskText || '').trim(),
          RECENT_TOOL_RESULTS: toolLog || '(none yet)',
          PREVIOUS_ATTEMPT_TO_IMPROVE: priorAttempt ? String(priorAttempt).slice(0, 1800) : '',
        });
      }
      return [
        'Write the complete final contents for one project file.',
        'Return only the file contents. No markdown fences. No explanation.',
        `File path: ${normalizedPath}`,
        'Rules:',
        '- Write a usable MVP, not a placeholder.',
        '- Keep the file internally consistent and runnable for its role.',
        '- If this is README.md, include setup or run instructions.',
        '- If this is a main source file, include the core functionality requested by the task.',
        generationHints.length ? `MVP_REQUIREMENTS:\n- ${generationHints.join('\n- ')}` : '',
        planSpec && planSpec.projectContract ? `PROJECT_CONTRACT:\n${String(planSpec.projectContract)}` : '',
        projectState ? `PROJECT_STATE:\n${projectState}` : '',
        'TASK:',
        String(taskText || '').trim(),
        'RECENT_TOOL_RESULTS:',
        toolLog || '(none yet)',
        priorAttempt
          ? `PREVIOUS_ATTEMPT_TO_IMPROVE:\nThe previous generation was rejected because it was either too short or contained placeholders (e.g. "todo", "coming soon"). Expand this code into a fully working implementation:\n${String(priorAttempt).slice(0, 1800)}`
          : '',
        'FILE_CONTENT:',
      ].filter(Boolean).join('\n');
    }

    async function buildAgentEditFileContentPrompt(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const projectState = buildAgentProjectStateContext(toolEvents, planSpec, normalizedPath);
      const editHints = buildAgentFileGenerationHints(taskText, normalizedPath);
      const template = await loadPromptTemplate('developer_agent_edit_file');
      if (template) {
        return renderPromptTemplate(template, {
          FILE_PATH: normalizedPath,
          MVP_REQUIREMENTS: editHints.length ? `- ${editHints.join('\n- ')}` : '',
          PROJECT_CONTRACT: String(planSpec && planSpec.projectContract ? planSpec.projectContract : ''),
          PROJECT_STATE: projectState,
          TASK: String(taskText || '').trim(),
          RECENT_TOOL_RESULTS: toolLog || '(none yet)',
          PREVIOUS_ATTEMPT_TO_IMPROVE: priorAttempt ? String(priorAttempt).slice(0, 1800) : '',
          CURRENT_FILE: String(currentContent || '').slice(0, 22000),
        });
      }
      return [
        'Return only a valid JSON object for editing one existing file. No markdown. No explanation.',
        'Format: {"edits":[...]}',
        'Each edit object must use one supported op:',
        '- {"op":"replace","find":"exact old text","replace":"new text"}',
        '- {"op":"replace_all","find":"exact old text","replace":"new text"}',
        '- {"op":"insert_before","find":"exact anchor text","text":"inserted text"}',
        '- {"op":"insert_after","find":"exact anchor text","text":"inserted text"}',
        '- {"op":"prepend","text":"inserted text"}',
        '- {"op":"append","text":"inserted text"}',
        'Rules:',
        '- Prefer the smallest targeted edits that satisfy the request.',
        '- Reuse exact text from the file for find/anchor fields.',
        '- Do not rewrite the whole file unless the request truly requires it.',
        `File path: ${normalizedPath}`,
        planSpec && planSpec.projectContract ? `PROJECT_CONTRACT:\n${String(planSpec.projectContract)}` : '',
        projectState ? `PROJECT_STATE:\n${projectState}` : '',
        'TASK:',
        String(taskText || '').trim(),
        'RECENT_TOOL_RESULTS:',
        toolLog || '(none yet)',
        priorAttempt
          ? `PREVIOUS_ATTEMPT_TO_IMPROVE:\n${String(priorAttempt).slice(0, 1800)}`
          : '',
        'CURRENT_FILE:',
        String(currentContent || '').slice(0, 22000),
        'JSON:',
      ].filter(Boolean).join('\n');
    }

    async function buildAgentRewriteExistingFilePrompt(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const projectState = buildAgentProjectStateContext(toolEvents, planSpec, normalizedPath);
      const rewriteHints = buildAgentFileGenerationHints(taskText, normalizedPath);
      const template = await loadPromptTemplate('developer_agent_rewrite_file');
      if (template) {
        return renderPromptTemplate(template, {
          FILE_PATH: normalizedPath,
          MVP_REQUIREMENTS: rewriteHints.length ? `- ${rewriteHints.join('\n- ')}` : '',
          PROJECT_CONTRACT: String(planSpec && planSpec.projectContract ? planSpec.projectContract : ''),
          PROJECT_STATE: projectState,
          TASK: String(taskText || '').trim(),
          RECENT_TOOL_RESULTS: toolLog || '(none yet)',
          PREVIOUS_ATTEMPT_TO_IMPROVE: priorAttempt ? String(priorAttempt).slice(0, 1800) : '',
          CURRENT_FILE: String(currentContent || '').slice(0, 22000),
        });
      }
      return [
        'Rewrite the complete final contents for one existing file after applying the requested edits.',
        'Return only the file contents. No markdown fences. No explanation.',
        `File path: ${normalizedPath}`,
        planSpec && planSpec.projectContract ? `PROJECT_CONTRACT:\n${String(planSpec.projectContract)}` : '',
        projectState ? `PROJECT_STATE:\n${projectState}` : '',
        'Rules:',
        '- Preserve unrelated working behavior.',
        '- Apply only the requested edits cleanly.',
        '- Keep the file internally consistent and runnable.',
        'TASK:',
        String(taskText || '').trim(),
        'RECENT_TOOL_RESULTS:',
        toolLog || '(none yet)',
        priorAttempt
          ? `PREVIOUS_ATTEMPT_TO_IMPROVE:\n${String(priorAttempt).slice(0, 1800)}`
          : '',
        'CURRENT_FILE:',
        String(currentContent || '').slice(0, 22000),
        'FILE_CONTENT:',
      ].filter(Boolean).join('\n');
    }

    async function buildAgentPlanPrompt(chatId, taskText) {
      const transcript = buildAgentHistoryTranscript(chatId, 10);
      const workspace = typeof getWorkspaceContext === 'function' ? getWorkspaceContext() : {};
      const template = await loadPromptTemplate('developer_agent_plan');
      return renderPromptTemplate(template, {
        CHAT_HISTORY: transcript || '(none)',
        CURRENT_WORKSPACE_ROOT: workspace.workspaceRootName ? `/${workspace.workspaceRootName}` : '(none)',
        CURRENT_SELECTION: normalizeWorkspacePath(workspace.currentPath || '/'),
        CURRENT_SELECTION_KIND: workspace.currentKind === 'file' ? 'file' : 'folder',
        TASK: String(taskText || '').trim(),
      });
    }

    async function buildAgentPlanSpec(chatId, taskText, planOptions = {}) {
      const forceProjectScope = Boolean(planOptions && planOptions.forceProjectScope);
      const prompt = await buildAgentPlanPrompt(chatId, taskText);
      const res = await Promise.race([
        requestAgentPlannerInference(prompt, agentDecisionMaxTokens, agentPlanGrammar),
        new Promise((resolve) => setTimeout(() => resolve({
          ok: false,
          timedOut: true,
          message: 'Agent plan step timed out.',
        }), agentStepTimeoutMs)),
      ]);
      if (!res || !res.ok) {
        return buildFallbackAgentPlanSpec(taskText, { chatId, forceProjectScope });
      }
      let parsed = null;
      try {
        parsed = JSON.parse(String(res.output || '').trim());
      } catch (_) {
        const raw = String(res.output || '');
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try {
            parsed = JSON.parse(raw.slice(start, end + 1));
          } catch (_) {
            parsed = null;
          }
        }
      }
      return parsed
        ? deps.normalizeAgentPlanSpec(parsed, taskText, { chatId, forceProjectScope })
        : buildFallbackAgentPlanSpec(taskText, { chatId, forceProjectScope });
    }

    // Relevance-ranked context: the per-turn window is recency-first, but a pure
    // last-N slice silently drops the file the user is actually asking about once
    // the run gets long. This pulls a few older tool results back into context when
    // their path/content matches the task focus (or when they were failures), so
    // edits stay grounded in the right files instead of just the most recent ones.
    function selectRelevantOlderEvents(olderEvents, taskText, planSpec, k = 3) {
      const events = Array.isArray(olderEvents) ? olderEvents : [];
      if (!events.length || k <= 0) return [];
      const focusText = [
        String(taskText || ''),
        ...(planSpec && Array.isArray(planSpec.affectedFiles) ? planSpec.affectedFiles : []),
        ...(planSpec && Array.isArray(planSpec.filesToInspect) ? planSpec.filesToInspect : []),
        ...(planSpec && Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles : []),
      ].join(' ').toLowerCase();
      const keywords = Array.from(new Set(
        focusText.replace(/[^a-z0-9/._-]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3)
      ));
      if (!keywords.length) return [];
      const scored = [];
      events.forEach((event, index) => {
        if (!event) return;
        const tool = String(event.tool || '').toLowerCase();
        if (!['read_file', 'write_file', 'edit_file', 'search_files', 'list_dir'].includes(tool)) return;
        const hay = `${String(event.path || '')} ${String(event.observation || '')}`.toLowerCase();
        let score = 0;
        keywords.forEach((kw) => { if (hay.includes(kw)) score += 1; });
        if (event.ok === false || event.validationPassed === false) score += 2;
        if (score > 0) scored.push({ index, score });
      });
      scored.sort((a, b) => b.score - a.score || b.index - a.index);
      const keepIdx = new Set(scored.slice(0, k).map((s) => s.index));
      return events.filter((_, index) => keepIdx.has(index));
    }

    function agentLineColAt(text, index) {
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

    function getPlannerJsSyntaxDiagnostic(path, jsText, parseError = null) {
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
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === quote) quote = '';
          continue;
        }
        if (inTemplate) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '`') inTemplate = false;
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
          const top = stack[stack.length - 1];
          if (!top || top.ch !== closers[ch]) {
            const loc = agentLineColAt(src, i);
            const found = top ? `expected ${pairs[top.ch]} for ${top.ch} opened at line ${agentLineColAt(src, top.index).line}` : 'nothing is open here';
            return `${path}:${loc.line}:${loc.col}: ${parseMessage || `unexpected ${ch}`} (${found})`;
          }
          stack.pop();
        }
      }
      if (stack.length) {
        const top = stack[stack.length - 1];
        const loc = agentLineColAt(src, top.index);
        return `${path}:${loc.line}:${loc.col}: ${parseMessage || `missing ${pairs[top.ch]}`} (${top.ch} opened here)`;
      }
      return parseMessage ? `${path}: ${parseMessage}` : '';
    }

    function buildAgentDiagnosticsLog(toolEvents) {
      const byPath = new Map();
      for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
        if (!event || !event.ok) continue;
        const tool = String(event.tool || '').toLowerCase();
        const path = normalizeWorkspacePath(event.path || '');
        const content = String(event.content || '');
        if (!path || !content || !['read_file', 'write_file', 'edit_file'].includes(tool)) continue;
        byPath.set(path, content);
      }
      const diagnostics = [];
      byPath.forEach((content, path) => {
        if (!/\.(?:js|mjs|cjs)$/i.test(path)) return;
        if (/\b(import|export)\b/.test(content)) return;
        try {
          // eslint-disable-next-line no-new, no-new-func
          new Function(content);
        } catch (err) {
          const detail = getPlannerJsSyntaxDiagnostic(path, content, err);
          if (detail) diagnostics.push(detail);
        }
      });
      if (!diagnostics.length) return '';
      return `CURRENT_CODE_DIAGNOSTICS (content-derived; fix these before broad inspection):\n${diagnostics.slice(0, 6).map((d) => `- ${d}`).join('\n')}\n\n`;
    }

    async function buildAgentDecisionPrompt(chatId, taskText, toolEvents, stepIndex, planSpec = null) {
      const transcript = buildAgentHistoryTranscript(chatId, 14);
      const workspace = typeof getWorkspaceContext === 'function' ? getWorkspaceContext() : {};
      const selectedPath = normalizeWorkspacePath(workspace.currentPath || '/');
      const selectedKind = workspace.currentKind === 'file' ? 'file' : 'folder';
      const currentWorkspaceRoot = workspace.workspaceRootName ? `/${workspace.workspaceRootName}` : '(none)';
      const allEvents = toolEvents || [];
      const recentEvents = allEvents.slice(-10);
      const olderEvents = allEvents.slice(0, allEvents.length - recentEvents.length);
      const mutationTools = new Set(['write_file', 'edit_file', 'new_project', 'mkdir', 'move', 'delete']);
      const inspectedMap = new Map();
      allEvents.forEach((e, i) => {
        if (!e) return;
        const tool = String(e.tool || '').toLowerCase();
        const path = String(e.path || '');
        if (e.ok && (tool === 'read_file' || tool === 'list_dir') && path) {
          const wasTruncated = String(e.observation || '').length >= agentMaxToolOutputChars - 20;
          inspectedMap.set(path, { eventIndex: i, wasTruncated, modifiedAfter: false });
        }
        if (e.ok && mutationTools.has(tool) && path) {
          if (inspectedMap.has(path)) inspectedMap.get(path).modifiedAfter = true;
        }
      });
      const olderInspected = Array.from(inspectedMap.entries()).filter(([, meta]) => {
        return meta.eventIndex < allEvents.length - recentEvents.length;
      });
      const inspectedNote = olderInspected.length
        ? `Files already in context (do not re-read unless noted):\n${olderInspected.map(([path, meta]) => {
          const flags = meta.wasTruncated
            ? '[TRUNCATED — re-read allowed]'
            : meta.modifiedAfter
            ? '[updated by your own edit — the edit result in TOOL_RESULTS is the current content; do not re-read]'
            : '[available — use cached content]';
          return `- ${path}  ${flags}`;
        }).join('\n')}\n\n`
        : '';
      const relevantOlder = selectRelevantOlderEvents(olderEvents, taskText, planSpec, 3);
      const diagnosticsLog = buildAgentDiagnosticsLog(allEvents);
      const expandedReadCap = Math.max(0, Number(getAgentExpandedReadChars()) || 0);
      const expandedReadEvent = !diagnosticsLog && expandedReadCap > agentMaxToolOutputChars
        ? [...allEvents].reverse().find((event) => {
          const tool = String(event && event.tool ? event.tool : '').toLowerCase();
          const path = normalizeWorkspacePath(event && event.path ? event.path : '');
          const content = String(event && event.content ? event.content : '');
          if (!event || !event.ok || tool !== 'read_file' || !path || !content) return false;
          if (!/\.(?:js|mjs|cjs|ts|tsx|jsx|html|css|py|java|go|rs|rb|php|json|md)$/i.test(path)) return false;
          return content.length > agentMaxToolOutputChars;
        })
        : null;
      const expandedReadLog = expandedReadEvent
        ? (() => {
          const path = normalizeWorkspacePath(expandedReadEvent.path || '');
          const content = String(expandedReadEvent.content || '');
          const clipped = content.length > expandedReadCap
            ? `${content.slice(0, expandedReadCap)}\n...[expanded read clipped at ${expandedReadCap} chars of ${content.length}]`
            : content;
          return `EXPANDED CURRENT READ CONTENT (use this instead of re-reading ${path}):\nFile: ${path}\n${clipped}\n\n`;
        })()
        : '';
      const relevantOlderLog = relevantOlder.length
        ? `RELEVANT EARLIER RESULTS (carried forward because they match this task — prefer these over re-reading):\n${relevantOlder.map((event, index) => {
          const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
          return `EarlierResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')} ${String(event && event.path ? event.path : '')}\n${observation}`;
        }).join('\n\n')}\n\n`
        : '';
      const toolLog = diagnosticsLog + expandedReadLog + relevantOlderLog + inspectedNote + recentEvents.map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const planSummary = planSpec
        ? [
          planSpec.summary ? `Goal: ${planSpec.summary}` : '',
          `Task kind: ${planSpec.taskKind || 'unknown'}`,
          `Primary stack: ${planSpec.primaryStack || 'generic'}`,
          planSpec.projectName ? `Project name: ${planSpec.projectName}` : '',
          Array.isArray(planSpec.expectedFiles) && planSpec.expectedFiles.length
            ? `Expected files: ${planSpec.expectedFiles.join(', ')}`
            : '',
          Array.isArray(planSpec.affectedFiles) && planSpec.affectedFiles.length
            ? `Affected files: ${planSpec.affectedFiles.join(', ')}`
            : '',
          Array.isArray(planSpec.filesToInspect) && planSpec.filesToInspect.length
            ? `Inspect first: ${planSpec.filesToInspect.join(', ')}`
            : '',
          Array.isArray(planSpec.doneCriteria) && planSpec.doneCriteria.length
            ? `Done criteria: ${planSpec.doneCriteria.join(' | ')}`
            : '',
          Array.isArray(planSpec.validationSteps) && planSpec.validationSteps.length
            ? `Validation: ${planSpec.validationSteps.join(' | ')}`
            : '',
          planSpec.projectContract ? `Project contract:\n${planSpec.projectContract}` : '',
          planSpec.needsReadme ? 'README required: yes' : 'README required: no',
        ].filter(Boolean).join('\n')
        : '(none)';

      const template = await loadPromptTemplate('developer_agent_decision');
      const vars = {
        AGENT_STEP: Number(stepIndex),
        AGENT_MAX_STEPS: agentMaxSteps,
        CURRENT_WORKSPACE_ROOT: currentWorkspaceRoot,
        CURRENT_SELECTION: selectedPath,
        CURRENT_SELECTION_KIND: selectedKind,
        CHAT_HISTORY: transcript || '(none)',
        PENDING_REQUIREMENTS: summarizeAgentPendingRequirements(taskText, toolEvents, planSpec),
        TOOL_RESULTS: toolLog || '(none yet)',
        TASK: String(taskText || '').trim(),
        PLAN_SUMMARY: planSummary,
      };
      const prompt = renderPromptTemplate(template, vars);
      // Split at the dynamic section so remote APIs receive proper system/user roles.
      const splitMarker = '\nAgent step: ';
      const splitIdx = prompt.indexOf(splitMarker);
      const systemPrompt = splitIdx > 0 ? prompt.slice(0, splitIdx).trim() : '';
      const userPrompt = splitIdx > 0 ? prompt.slice(splitIdx + 1).trim() : prompt;
      return { prompt, systemPrompt, userPrompt };
    }

    return {
      looksLikePlaceholderImplementation,
      isLikelyCompletePythonProjectSource,
      isLikelyCompleteJavaScriptProjectSource,
      isLikelyCompletePrimarySource,
      getLatestSuccessfulAgentSourceWrite,
      getLatestSuccessfulAgentWrite,
      hasSuccessfulAgentTool,
      buildAgentTaskRequirements,
      summarizeAgentPendingRequirements,
      validateAgentFinalDecision,
      buildAgentDecisionRepairPrompt,
      sanitizeAgentGeneratedFileContent,
      sanitizeAgentGeneratedEditProgram,
      buildAgentWriteFileContentPrompt,
      buildAgentEditFileContentPrompt,
      buildAgentRewriteExistingFilePrompt,
      buildAgentPlanPrompt,
      buildAgentPlanSpec,
      buildAgentDecisionPrompt,
      selectRelevantOlderEvents,
      buildAgentDiagnosticsLog,
      buildAgentProjectStateContext,
    };
  }

  global.AIExeAgentPlanner = {
    createAgentPlanner,
  };
})(window);
