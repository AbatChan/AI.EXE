(function initAIExeAgentPlanner(global) {
  function createAgentPlanner(deps) {
    const normalizeWorkspacePath = deps.normalizeWorkspacePath;
    const isAgentTaskGameLike = deps.isAgentTaskGameLike;
    const hasReadmeRunInstructions = deps.hasReadmeRunInstructions;
    const isLikelyCompleteReadme = deps.isLikelyCompleteReadme;
    const isExplicitReadmeOrDocsTask = deps.isExplicitReadmeOrDocsTask;
    const buildFallbackAgentPlanSpec = deps.buildFallbackAgentPlanSpec;
    const buildAgentFileGenerationHints = deps.buildAgentFileGenerationHints;
    const loadPromptTemplate = deps.loadPromptTemplate;
    const renderPromptTemplate = deps.renderPromptTemplate;
    const buildAgentHistoryTranscript = deps.buildAgentHistoryTranscript;
    const requestAgentPlannerInference = deps.requestAgentPlannerInference;
    const getWorkspaceContext = deps.getWorkspaceContext;
    const deriveProjectNameFromTask = deps.deriveProjectNameFromTask;
    const agentMaxSteps = Number(deps.agentMaxSteps) || 16;
    const agentDecisionMaxTokens = Number(deps.agentDecisionMaxTokens) || 120;
    const agentPlanGrammar = String(deps.agentPlanGrammar || '');
    const agentStepTimeoutMs = Number(deps.agentStepTimeoutMs) || 20000;

    function looksLikePlaceholderImplementation(content) {
      const text = String(content || '').toLowerCase();
      return [
        'functionality here',
        'todo:',
        'placeholder',
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

    function isLikelyCompleteJavaScriptProjectSource(content) {
      const text = String(content || '');
      const lower = text.toLowerCase();
      let score = 0;
      if (/function\s+\w+|const\s+\w+\s*=|class\s+\w+/i.test(text)) score += 1;
      if (/addEventListener|onclick|document\.querySelector|getElementById|localStorage|module\.exports|export\s+/i.test(text)) score += 1;
      if (/\b(save|load|render|update|delete|remove|list|total|summary)\b/i.test(lower)) score += 1;
      if (looksLikePlaceholderImplementation(text)) return false;
      return text.trim().length >= 700 && score >= 3;
    }

    function isLikelyCompletePrimarySource(path, content, taskText) {
      const normalized = normalizeWorkspacePath(path || '');
      if (/\.py$/i.test(normalized)) {
        return isAgentTaskGameLike(taskText)
          ? deps.isLikelyCompletePythonGameSource(content)
          : isLikelyCompletePythonProjectSource(content);
      }
      if (/\.(js|ts|jsx|tsx)$/i.test(normalized)) {
        return isLikelyCompleteJavaScriptProjectSource(content);
      }
      if (/\.html$/i.test(normalized)) {
        const text = String(content || '');
        const lower = text.toLowerCase();
        return text.trim().length >= 500 && /<html|<body|<script|<main|<section/i.test(lower) && !looksLikePlaceholderImplementation(text);
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
      const isDocsTask = isExplicitReadmeOrDocsTask(text);
      const isRenameTask = /\brename\b/.test(lower);

      const readmeWrite = getLatestSuccessfulAgentWrite(toolEvents, (event) => normalizeWorkspacePath(event.path || '') === '/README.md');
      const primarySourceWrite = getLatestSuccessfulAgentSourceWrite(toolEvents, (event, normalized) => {
        if (isPythonTask) return /\.py$/i.test(normalized);
        return true;
      });

      if (isSoftwareProject) {
        requirements.push({
          id: 'project_root',
          label: 'create the project workspace',
          met: hasSuccessfulAgentTool(toolEvents, (event) => event.tool === 'new_project'),
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
          met: Boolean(readmeWrite && isLikelyCompleteReadme(readmeWrite.content || '')),
        });
      }

      if (isSoftwareProject && plan.needsRunInstructions) {
        requirements.push({
          id: 'readme_run_instructions',
          label: 'add run instructions to /README.md',
          met: Boolean(readmeWrite && hasReadmeRunInstructions(readmeWrite.content || '')),
        });
      }

      if (isDocsTask) {
        requirements.push({
          id: 'readme_file',
          label: readmeWrite ? 'update /README.md' : 'write /README.md',
          met: Boolean(readmeWrite && isLikelyCompleteReadme(readmeWrite.content || '')),
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
        .filter((path) => !isDocsTask && path && path !== '/README.md' && path !== '/src')
        .slice(0, 6)
        .forEach((path) => {
          requirements.push({
            id: `expected_${path}`,
            label: `${plan.taskKind === 'edit' ? 'update' : 'write'} ${path}`,
            met: hasSuccessfulAgentTool(toolEvents, (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) && normalizeWorkspacePath(event.path || '') === path),
          });
        });

      const expectedNonReadmeFiles = plan.expectedFiles
        .filter((path) => !isDocsTask && path && path !== '/README.md' && path !== '/src');
      const allExpectedFilesWritten = expectedNonReadmeFiles.length > 0
        && expectedNonReadmeFiles.every((path) => hasSuccessfulAgentTool(
          toolEvents,
          (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()) && normalizeWorkspacePath(event.path || '') === path,
        ));
      if (isSoftwareProject && allExpectedFilesWritten) {
        requirements.push({
          id: 'validate_written_files',
          label: 'validate the written project files',
          met: hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true),
        });
      }

      if (!requirements.length) {
        requirements.push({
          id: 'deliverable',
          label: isAnalysisTask ? 'inspect the relevant workspace files and answer the request' : 'complete the requested workspace changes',
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
        const observation = String(event && event.observation ? event.observation : '').slice(0, 1200);
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
      const leakedPrompt = /return only the file contents\.|file path:\s*\/|mvp_requirements:|recent_tool_results:|file_content:/i.test(text);
      const fencedBlock = text.match(/```[a-z0-9_-]*\s*([\s\S]*?)```/i);
      if (leakedPrompt && fencedBlock && fencedBlock[1]) {
        text = String(fencedBlock[1] || '').trim();
      }
      text = text
        .replace(/^.*?\bFILE_CONTENT:\s*/is, '')
        .replace(/^(?:Return only the file contents\..*|File path:\s*.*|Rules:\s*|MVP_REQUIREMENTS:\s*|TASK:\s*|RECENT_TOOL_RESULTS:\s*|PREVIOUS_ATTEMPT_TO_IMPROVE:\s*)$/gim, '')
        .trim();
      if (/^```/i.test(text)) {
        text = text.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      text = text
        .replace(/^Here(?:'|’)s the file(?: content)?[:\s-]*/i, '')
        .replace(/^Below is the file(?: content)?[:\s-]*/i, '')
        .trim();
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

    async function buildAgentWriteFileContentPrompt(taskText, toolEvents, path, priorAttempt = '') {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, 1000);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const generationHints = buildAgentFileGenerationHints(taskText, normalizedPath);
      const template = await loadPromptTemplate('developer_agent_write_file');
      if (template) {
        return renderPromptTemplate(template, {
          FILE_PATH: normalizedPath,
          MVP_REQUIREMENTS: generationHints.length ? `- ${generationHints.join('\n- ')}` : '',
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
        'TASK:',
        String(taskText || '').trim(),
        'RECENT_TOOL_RESULTS:',
        toolLog || '(none yet)',
        priorAttempt
          ? `PREVIOUS_ATTEMPT_TO_IMPROVE:\n${String(priorAttempt).slice(0, 1800)}`
          : '',
        'FILE_CONTENT:',
      ].filter(Boolean).join('\n');
    }

    async function buildAgentEditFileContentPrompt(taskText, toolEvents, path, currentContent, priorAttempt = '') {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, 1000);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const template = await loadPromptTemplate('developer_agent_edit_file');
      if (template) {
        return renderPromptTemplate(template, {
          FILE_PATH: normalizedPath,
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

    async function buildAgentRewriteExistingFilePrompt(taskText, toolEvents, path, currentContent, priorAttempt = '') {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, 1000);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const template = await loadPromptTemplate('developer_agent_rewrite_file');
      if (template) {
        return renderPromptTemplate(template, {
          FILE_PATH: normalizedPath,
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

    async function buildAgentPlanSpec(chatId, taskText) {
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
        return buildFallbackAgentPlanSpec(taskText);
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
      return parsed ? deps.normalizeAgentPlanSpec(parsed, taskText) : buildFallbackAgentPlanSpec(taskText);
    }

    async function buildAgentDecisionPrompt(chatId, taskText, toolEvents, stepIndex, planSpec = null) {
      const transcript = buildAgentHistoryTranscript(chatId, 14);
      const workspace = typeof getWorkspaceContext === 'function' ? getWorkspaceContext() : {};
      const selectedPath = normalizeWorkspacePath(workspace.currentPath || '/');
      const selectedKind = workspace.currentKind === 'file' ? 'file' : 'folder';
      const currentWorkspaceRoot = workspace.workspaceRootName ? `/${workspace.workspaceRootName}` : '(none)';
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, 1600);
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
          planSpec.needsReadme ? 'README required: yes' : 'README required: no',
        ].filter(Boolean).join('\n')
        : '(none)';

      const template = await loadPromptTemplate('developer_agent_decision');
      return renderPromptTemplate(template, {
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
      });
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
    };
  }

  global.AIExeAgentPlanner = {
    createAgentPlanner,
  };
})(window);
