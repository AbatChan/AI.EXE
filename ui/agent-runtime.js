(function initAIExeAgentRuntime(global) {
  function createAgentRuntime(deps) {
    const agentPlannerEndpoint = String(deps.agentPlannerEndpoint || '');
    const agentPlannerRequestTimeoutMs = Number(deps.agentPlannerRequestTimeoutMs) || 15000;
    const agentDecisionMaxTokens = Number(deps.agentDecisionMaxTokens) || 120;
    const agentFileContentMaxTokens = Number(deps.agentFileContentMaxTokens) || 5000;
    // Model-aware per-call output budget (provider/context dependent); falls back to
    // the flat cap when the host doesn't supply one.
    const getAgentFileOutputBudget = typeof deps.getAgentFileOutputBudget === 'function'
      ? deps.getAgentFileOutputBudget
      : () => agentFileContentMaxTokens;
    const recordDebugTrace = typeof deps.recordDebugTrace === 'function'
      ? deps.recordDebugTrace
      : () => {};
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

    // Detect a file cut off by the per-call output token cap (the dominant cause of
    // "unclosed CSS blocks" / mid-function truncation that then traps the agent in a
    // repair loop). Brace/bracket imbalance or an obviously mid-token ending are
    // strong, language-agnostic signals.
    function looksTruncatedFileContent(content, path) {
      const text = String(content || '');
      if (!text.trim()) return false;
      const ext = ((String(path || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
      if (['css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json'].includes(ext)) {
        const bal = (o, c) => (text.split(o).length - 1) - (text.split(c).length - 1);
        if (bal('{', '}') > 0 || bal('(', ')') > 0 || bal('[', ']') > 0) return true;
      }
      if (['css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) {
        // Unterminated /* block comment */ — a common mid-comment truncation.
        if ((text.match(/\/\*/g) || []).length > (text.match(/\*\//g) || []).length) return true;
      }
      if (['html', 'htm'].includes(ext)) {
        if (/<html[\s>]/i.test(text) && !/<\/html\s*>/i.test(text)) return true;
      }
      const tail = text.replace(/\s+$/, '');
      const lastChar = tail.slice(-1);
      if (tail.length > 400 && /[A-Za-z0-9_,:(\[{]/.test(lastChar) && !/[}\])>;]$/.test(tail)) return true;
      return false;
    }

    // Append a continuation chunk, dropping a repeated seam: find the largest
    // suffix of the base that the continuation re-emitted as its prefix and trim it,
    // so "continue from where you stopped" doesn't duplicate the overlap.
    function stitchFileContinuation(base, addition) {
      const b = String(base || '');
      let add = String(addition || '');
      if (!add) return b;
      if (!b) return add;
      const max = Math.min(b.length, add.length, 240);
      for (let n = max; n > 0; n -= 1) {
        if (b.slice(-n) === add.slice(0, n)) {
          add = add.slice(n);
          break;
        }
      }
      return b + add;
    }

    // Returns { output, truncated }. `truncated` prefers the provider's real signal
    // (OpenAI finish_reason==='length' / Anthropic stop_reason==='max_tokens'); the
    // native path has no such flag, so completeness there is judged structurally.
    async function runRawAgentFileInference(prompt) {
      const budget = Math.max(1, Number(getAgentFileOutputBudget()) || agentFileContentMaxTokens);
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, budget);
      if (remote && remote.ok && String(remote.output || '').trim()) {
        return { output: String(remote.output || ''), truncated: Boolean(remote.truncated) };
      }
      const external = await requestExternalAgentPlanner(prompt, budget, agentFileGenerationRequestTimeoutMs);
      if (external && external.ok && String(external.output || '').trim()) {
        return { output: String(external.output || ''), truncated: Boolean(external.truncated) };
      }
      if (!deps.nativeBridge.available()) return { output: '', truncated: false };
      const res = await deps.nativeBridge.invoke('infer', { prompt, maxTokens: budget, max_tokens: budget });
      if (!res || !res.ok) return { output: '', truncated: false };
      return { output: String(res.output || ''), truncated: Boolean(res.truncated) };
    }

    // Generate a full file, continuing across multiple capped calls when a large
    // file overflows a single response, then sanitize the stitched result once.
    // Continues on either the provider's truncation signal or a structural check.
    // Emits an `agent_file_generation` trace (prompt size, output size, #continuations)
    // so under-generation / context-overflow is visible instead of silent.
    async function generateFullAgentFile(prompt, path) {
      const promptChars = String(prompt || '').length;
      // Heartbeat so the loop's idle-timeout knows this slow multi-pass generation
      // is actually progressing (not hung) and lets it finish a large file.
      const beat = () => { if (typeof deps.markAgentToolProgress === 'function') deps.markAgentToolProgress(); };
      beat();
      const first = await runRawAgentFileInference(prompt);
      beat();
      let raw = first.output;
      if (!raw) {
        recordAgentFileGenTrace(path, promptChars, 0, 0, first.truncated, 'empty_output');
        return '';
      }
      let wasTruncated = first.truncated;
      let guard = 0;
      while (guard < 3 && (wasTruncated || looksTruncatedFileContent(raw, path))) {
        guard += 1;
        const continuationPrompt = `${prompt}\n\nPARTIAL_OUTPUT_ALREADY_SAVED (do NOT repeat any of this):\n${raw.slice(-1600)}\n\nContinue the file from exactly where it stopped. Output ONLY the remaining content — no repetition, no commentary, no code fences.`;
        const next = await runRawAgentFileInference(continuationPrompt);
        beat();
        if (!next.output || !next.output.trim()) break;
        const before = raw.length;
        raw = stitchFileContinuation(raw, next.output);
        wasTruncated = next.truncated;
        if (raw.length <= before) break;
      }
      const finalContent = deps.sanitizeAgentGeneratedFileContent(raw, path);
      recordAgentFileGenTrace(path, promptChars, String(finalContent || '').length, guard, wasTruncated,
        guard >= 3 ? 'continuation_exhausted' : 'ok');
      return finalContent;
    }

    // Visibility into file generation: a tiny output next to a large prompt (as when
    // sibling-file bloat overflowed the local 8192-token context) is now diagnosable.
    function recordAgentFileGenTrace(path, promptChars, outputChars, continuations, truncated, status) {
      recordDebugTrace('agent_file_generation', {
        path: String(path || ''),
        promptChars: String(promptChars),
        approxPromptTokens: String(Math.round(Number(promptChars) / 3.7)),
        outputChars: String(outputChars),
        continuations: String(continuations),
        truncatedSignal: String(Boolean(truncated)),
        status: String(status || ''),
      }, {
        path: String(path || ''),
        promptChars,
        outputChars,
        continuations,
        truncated: Boolean(truncated),
        status,
      });
    }

    async function generateAgentWriteFileContent(taskText, toolEvents, path, priorAttempt = '', planSpec = null) {
      const prompt = await deps.buildAgentWriteFileContentPrompt(taskText, toolEvents, path, priorAttempt, planSpec);
      return generateFullAgentFile(prompt, path);
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
      return generateFullAgentFile(prompt, path);
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
      const createdProject = rows.some((item) => String(item.tool || '').toLowerCase() === 'new_project');
      const action = createdProject && uniqueWritten.length ? 'Created' : 'Updated';
      const fileSummary = uniqueWritten.length
        ? `${action} ${uniqueWritten.map((path) => `\`${path}\``).join(', ')}.`
        : 'Done.';
      const validated = rows.some((item) => String(item.tool || '').toLowerCase() === 'validate_files' && item.validationPassed === true);
      const verification = validated ? ' Validation passed.' : '';
      return `${fileSummary}${verification}`;
    }

    function isLikelyIncompleteCompletion(text) {
      const value = String(text || '').trim();
      if (!value) return true;
      if (/[,:;(\[{]$/.test(value)) return true;
      if (/(?:\b(and|or|with|for|to|by|including|computing|showing|using|plus))$/i.test(value)) return true;
      const lines = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || value;
      if (/^[-*]\s+\S[^.!?`)]*$/.test(lastLine) && lines.length > 1) return true;
      const hasTerminalPunctuation = /[.!?`)"]$/.test(value);
      if (!hasTerminalPunctuation && value.length > 120) return true;
      return false;
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
        'Return a complete answer. Do not end mid-sentence or mid-list.',
        'Do not dump raw tool results.',
        'Mention the workspace name only if it is useful.',
        'Mention changed files when they help the user understand what happened.',
        'For multi-file app work, short bullets are allowed.',
        'Keep it concise and specific to the actual work. Prefer under 120 words.',
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
      const remote = await deps.requestSelectedRemoteTextCompletion(prompt, 420);
      if (remote && remote.ok) {
        const text = deps.sanitizeAssistantText(remote.output || '');
        if (text && !isLikelyIncompleteCompletion(text)) return text;
      }
      const external = await requestExternalAgentPlanner(prompt, 420, 12000);
      if (external && external.ok) {
        const text = deps.sanitizeAssistantText(external.output || '');
        if (text && !isLikelyIncompleteCompletion(text)) return text;
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
      looksTruncatedFileContent,
      stitchFileContinuation,
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
