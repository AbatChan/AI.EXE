(function initAIExeAgentRuntime(global) {
  function createAgentRuntime(deps) {
    const agentPlannerEndpoint = String(deps.agentPlannerEndpoint || '');
    const agentPlannerRequestTimeoutMs = Number(deps.agentPlannerRequestTimeoutMs) || 15000;
    const agentDecisionMaxTokens = Number(deps.agentDecisionMaxTokens) || 120;
    const agentFileContentMaxTokens = Number(deps.agentFileContentMaxTokens) || 5000;
    const agentFileGenerationRequestTimeoutMs = Number(deps.agentFileGenerationRequestTimeoutMs) || 30000;

    async function requestExternalAgentPlanner(prompt, maxTokens, timeoutMs = agentPlannerRequestTimeoutMs) {
      if (!agentPlannerEndpoint) return null;
      try {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
        const response = await fetch(agentPlannerEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: String(prompt || ''),
            max_tokens: Number(maxTokens) || agentDecisionMaxTokens,
          }),
          signal: controller ? controller.signal : undefined,
        });
        if (timeoutId) clearTimeout(timeoutId);
        if (!response.ok) return null;
        const payload = await response.json();
        if (!payload || !payload.ok) return null;
        return {
          ok: true,
          output: String(payload.output || ''),
          externalPlanner: true,
        };
      } catch (_) {
        return null;
      }
    }

    async function generateAgentWriteFileContent(taskText, toolEvents, path, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentWriteFileContentPrompt(taskText, toolEvents, path, priorAttempt, planSpec);
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, agentFileContentMaxTokens);
      if (remote && remote.ok) {
        const cleaned = deps.sanitizeAgentGeneratedFileContent(remote.output || '', path);
        if (cleaned) return cleaned;
      }
      const external = await requestExternalAgentPlanner(prompt, agentFileContentMaxTokens, agentFileGenerationRequestTimeoutMs);
      if (external && external.ok) {
        const cleaned = deps.sanitizeAgentGeneratedFileContent(external.output || '', path);
        if (cleaned) return cleaned;
      }
      if (!deps.nativeBridge.available()) return '';
      const res = await deps.nativeBridge.invoke('infer', {
        prompt,
        maxTokens: agentFileContentMaxTokens,
        max_tokens: agentFileContentMaxTokens,
      });
      if (!res || !res.ok) return '';
      return deps.sanitizeAgentGeneratedFileContent(res.output || '', path);
    }

    async function generateAgentEditFileProgram(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentEditFileContentPrompt(taskText, toolEvents, path, currentContent, priorAttempt, planSpec);
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, agentDecisionMaxTokens * 3);
      if (remote && remote.ok) {
        const cleaned = deps.sanitizeAgentGeneratedEditProgram(remote.output || '');
        if (cleaned) return cleaned;
      }
      const external = await requestExternalAgentPlanner(prompt, agentDecisionMaxTokens * 3, agentFileGenerationRequestTimeoutMs);
      if (external && external.ok) {
        const cleaned = deps.sanitizeAgentGeneratedEditProgram(external.output || '');
        if (cleaned) return cleaned;
      }
      if (!deps.nativeBridge.available()) return '';
      const res = await deps.nativeBridge.invoke('infer', {
        prompt,
        maxTokens: agentDecisionMaxTokens * 3,
        max_tokens: agentDecisionMaxTokens * 3,
      });
      if (!res || !res.ok) return '';
      return deps.sanitizeAgentGeneratedEditProgram(res.output || '');
    }

    async function generateAgentRewriteExistingFileContent(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentRewriteExistingFilePrompt(taskText, toolEvents, path, currentContent, priorAttempt, planSpec);
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, agentFileContentMaxTokens);
      if (remote && remote.ok) {
        const cleaned = deps.sanitizeAgentGeneratedFileContent(remote.output || '', path);
        if (cleaned) return cleaned;
      }
      const external = await requestExternalAgentPlanner(prompt, agentFileContentMaxTokens, agentFileGenerationRequestTimeoutMs);
      if (external && external.ok) {
        const cleaned = deps.sanitizeAgentGeneratedFileContent(external.output || '', path);
        if (cleaned) return cleaned;
      }
      if (!deps.nativeBridge.available()) return '';
      const res = await deps.nativeBridge.invoke('infer', {
        prompt,
        maxTokens: agentFileContentMaxTokens,
        max_tokens: agentFileContentMaxTokens,
      });
      if (!res || !res.ok) return '';
      return deps.sanitizeAgentGeneratedFileContent(res.output || '', path);
    }

    const loadPromptTemplate = typeof deps.loadPromptTemplate === 'function'
      ? deps.loadPromptTemplate
      : null;
    const renderPromptTemplate = typeof deps.renderPromptTemplate === 'function'
      ? deps.renderPromptTemplate
      : null;

    function buildAgentCompletionFallbackText(taskText, toolEvents, workspaceLabel) {
      const rows = Array.isArray(toolEvents) ? toolEvents.filter((item) => item && item.ok) : [];
      const writtenPaths = rows
        .filter((item) => ['write_file', 'edit_file'].includes(String(item.tool || '').toLowerCase()))
        .map((item) => deps.normalizeWorkspacePath(item.path || ''))
        .filter(Boolean);
      const uniqueWritten = Array.from(new Set(writtenPaths)).slice(0, 6);
      const fileSummary = uniqueWritten.length
        ? `Updated ${uniqueWritten.map((path) => `\`${path}\``).join(', ')}.`
        : 'Done.';
      const validated = rows.some((item) => String(item.tool || '').toLowerCase() === 'validate_files' && item.validationPassed === true);
      const verification = validated ? ' Validation passed.' : '';
      return `${fileSummary}${verification}`;
    }

    async function generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec = null) {
      const rows = Array.isArray(toolEvents) ? toolEvents.filter((item) => item && item.ok) : [];
      const writtenPaths = rows
        .filter((item) => ['write_file', 'edit_file'].includes(String(item.tool || '').toLowerCase()))
        .map((item) => deps.normalizeWorkspacePath(item.path || ''))
        .filter(Boolean)
        .slice(-6);
      const deterministicCompletion = buildAgentCompletionFallbackText(taskText, toolEvents, workspaceLabel);
      const readResults = rows
        .filter((item) => String(item.tool || '').toLowerCase() === 'read_file')
        .slice(-2)
        .map((item, index) => [
          `ReadResult ${index + 1}: ${deps.normalizeWorkspacePath(item.path || '')}`,
          String(item.content || '').slice(0, 8000),
        ].join('\n'))
        .join('\n\n');
      let prompt = [
        'Write a natural completion message for the user.',
        'Do not dump raw tool results.',
        'Mention the workspace name only if it is useful.',
        'Mention changed files when they help the user understand what happened.',
        'For multi-file app work, short bullets are allowed.',
        'Keep it concise and specific to the actual work.',
        `Workspace name: ${workspaceLabel || deps.deriveProjectNameFromTask(taskText) || 'project'}`,
        `Task: ${String(taskText || '').trim()}`,
        planSpec && planSpec.summary ? `Plan summary: ${planSpec.summary}` : '',
        writtenPaths.length ? `Written files: ${Array.from(new Set(writtenPaths)).slice(0, 6).join(', ')}` : '',
        readResults ? `READ_RESULTS:\n${readResults}` : '',
        'Completion message:',
      ].filter(Boolean).join('\n');
      if (loadPromptTemplate && renderPromptTemplate) {
        const template = await loadPromptTemplate('developer_agent_completion');
        if (template) {
          prompt = renderPromptTemplate(template, {
            WORKSPACE_NAME: workspaceLabel || deps.deriveProjectNameFromTask(taskText) || 'project',
            TASK: String(taskText || '').trim(),
            PLAN_SUMMARY: planSpec && planSpec.summary ? planSpec.summary : '',
            WRITTEN_FILES: writtenPaths.length ? Array.from(new Set(writtenPaths)).slice(0, 6).join(', ') : '',
            READ_RESULTS: readResults || '(none)',
          });
        }
      }
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, 240);
      if (remote && remote.ok) {
        const text = deps.sanitizeAssistantText(remote.output || '');
        if (text) return text;
      }
      const external = await requestExternalAgentPlanner(prompt, 240, 12000);
      if (external && external.ok) {
        const text = deps.sanitizeAssistantText(external.output || '');
        if (text) return text;
      }
      return deterministicCompletion;
    }

    function buildAgentProgressMarkdown(progressEntries, startedAtMs) {
      const rows = Array.isArray(progressEntries) ? progressEntries : [];
      const elapsed = Math.max(0, Date.now() - Number(startedAtMs || 0));
      const elapsedSec = (elapsed / 1000).toFixed(1);
      const iconFor = (status) => {
        const key = String(status || '').toLowerCase();
        if (key === 'done') return '✅';
        if (key === 'error') return '❌';
        if (key === 'tool') return '🔧';
        if (key === 'running') return '⏳';
        return '•';
      };
      const lines = [
        '**Developer agent is running...**',
        `Elapsed: ${elapsedSec}s`,
        '',
      ];
      rows.forEach((row) => {
        if (!row || !row.text) return;
        lines.push(`- ${iconFor(row.status)} ${row.text}`);
      });
      return lines.join('\n');
    }

    function describeAgentToolTarget(decision) {
      const tool = String(decision && decision.tool ? decision.tool : '').toLowerCase();
      const path = deps.normalizeWorkspacePath(decision && decision.path ? decision.path : '');
      const srcPath = deps.normalizeWorkspacePath(decision && (decision.srcPath || decision.src_path) ? (decision.srcPath || decision.src_path) : '');
      const dstPath = deps.normalizeWorkspacePath(decision && (decision.dstPath || decision.dst_path) ? (decision.dstPath || decision.dst_path) : '');
      if (tool === 'new_project') return 'new project';
      if (tool === 'move') {
        if (srcPath && dstPath) return `${srcPath} -> ${dstPath}`;
        return srcPath || dstPath || '';
      }
      return path || srcPath || '';
    }

    return {
      requestExternalAgentPlanner,
      generateAgentWriteFileContent,
      generateAgentEditFileProgram,
      generateAgentRewriteExistingFileContent,
      buildAgentCompletionFallbackText,
      generateAgentCompletionText,
      buildAgentProgressMarkdown,
      describeAgentToolTarget,
    };
  }

  global.AIExeAgentRuntime = {
    createAgentRuntime,
  };
})(window);
