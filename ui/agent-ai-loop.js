(function initAIExeAiNativeAgentLoop(global) {
  function createAiNativeAgentLoop(deps) {
    const toolNames = [
      'new_project',
      'list_dir',
      'search_files',
      'read_file',
      'write_file',
      'edit_file',
      'validate_files',
      'mkdir',
      'move',
      'delete',
    ];

    const now = () => Date.now();
    const maxSteps = Number(deps.agentMaxSteps) || 18;
    const maxToolOutputChars = Number(deps.agentMaxToolOutputChars) || 3200;
    const maxTokens = Number(deps.agentDecisionMaxTokens) || 1400;

    function normalizeToolEvent(event) {
      if (!event) return null;
      return {
        tool: String(event.tool || ''),
        ok: Boolean(event.ok),
        path: String(event.path || ''),
        src_path: String(event.srcPath || event.src_path || ''),
        dst_path: String(event.dstPath || event.dst_path || ''),
        observation: String(event.observation || '').slice(0, maxToolOutputChars),
      };
    }

    function extractJsonObject(text) {
      const raw = String(text || '').trim();
      if (!raw) return null;
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const source = fenced ? fenced[1] : raw;
      const start = source.indexOf('{');
      if (start < 0) return null;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < source.length; i += 1) {
        const char = source[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (char === '{') depth += 1;
        if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(source.slice(start, i + 1));
            } catch (_) {
              return null;
            }
          }
        }
      }
      return null;
    }

    function splitThoughtAndJson(text) {
      const raw = String(text || '').trim();
      const fenceIndex = raw.search(/```(?:json)?/i);
      const objectIndex = raw.indexOf('{');
      const index = fenceIndex >= 0 ? fenceIndex : objectIndex;
      return index > 0 ? raw.slice(0, index).trim() : '';
    }

    function normalizeDecision(parsed) {
      if (!parsed || typeof parsed !== 'object') return null;
      const action = String(parsed.action || '').toLowerCase() === 'final' ? 'final' : 'tool';
      const tool = action === 'final' ? 'none' : String(parsed.tool || '').toLowerCase();
      if (action === 'tool' && !toolNames.includes(tool)) return null;
      return {
        action,
        tool,
        message: String(parsed.message || ''),
        path: String(parsed.path || ''),
        content: String(parsed.content || ''),
        srcPath: String(parsed.src_path || parsed.srcPath || ''),
        dstPath: String(parsed.dst_path || parsed.dstPath || ''),
      };
    }

    function buildToolTranscript(toolEvents) {
      if (!Array.isArray(toolEvents) || toolEvents.length === 0) return '(none yet)';
      return toolEvents
        .map(normalizeToolEvent)
        .filter(Boolean)
        .map((event, index) => [
          `#${index + 1} ${event.ok ? 'ok' : 'failed'} ${event.tool}${event.path ? ` ${event.path}` : ''}`,
          event.observation || '(no observation)',
        ].join('\n'))
        .join('\n\n');
    }

    function buildAiNativePrompt(taskText, toolEvents, previousInvalidOutput = '') {
      const workspace = typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() || {} : {};
      const workspaceLines = [
        `root: ${String(workspace.workspaceRootName || '(none)')}`,
        `current_path: ${String(workspace.currentPath || '/')}`,
        `root_loaded: ${workspace.rootLoaded ? 'yes' : 'no'}`,
        `root_entry_count: ${Number(workspace.rootEntryCount) || 0}`,
      ];
      if (Array.isArray(workspace.rootEntries) && workspace.rootEntries.length > 0) {
        workspaceLines.push('root_entries:');
        workspace.rootEntries.slice(0, 30).forEach((entry) => {
          workspaceLines.push(`- ${String(entry.kind || 'file')} ${String(entry.path || entry.name || '')}`);
        });
      }
      return [
        'You are AI.EXE Agent Experimental, an autonomous software-engineering agent.',
        '',
        'You own the workflow. Think like a practical software engineer.',
        'Use tools one step at a time. After every tool result, decide the next best step from the real evidence.',
        '',
        'Workflow guidance:',
        '- First understand whether the user wants a new project, an edit, debugging, review, docs, or an explanation.',
        '- For an unknown workspace, use list_dir before choosing files.',
        '- For a small known workspace, read the central files directly.',
        '- Use search_files for pasted errors, stack frames, function names, selectors, and keywords inside large or unknown files.',
        '- Do not use search_files as filename discovery; use list_dir for that.',
        '- Before editing an existing file, read it or rely on a fresh tool result that contains its current content.',
        '- For coordinated frontend features, inspect and update the structure, style, and behavior files that are actually needed.',
        '- Verify after changes with the available validation tool or the most relevant lightweight check.',
        '- Do not claim success until the tool results support it.',
        '- If blocked, explain the real blocker and choose a different grounded step only when it advances the user request.',
        '',
        'Available tools:',
        '- new_project: create or switch to a new project workspace when the user wants a new project.',
        '- list_dir: inspect files/folders.',
        '- search_files: search text inside files and return matching paths/lines.',
        '- read_file: read a file; after search hits in a large file it may return focused context around the hit.',
        '- write_file: create a new text file.',
        '- edit_file: edit an existing text file using precise instructions or an edit program.',
        '- validate_files: check written project files for obvious syntax/file-role/MVP issues.',
        '- mkdir, move, delete: filesystem operations.',
        '',
        'Response format:',
        'You may write one short natural progress note before the JSON when it helps the user understand what you learned or what you are about to do.',
        'Then return exactly one JSON object.',
        '',
        'For a tool step:',
        '{"action":"tool","tool":"read_file","path":"/index.html","content":"","src_path":"","dst_path":"","message":"Read the current HTML before editing."}',
        '',
        'For final:',
        '{"action":"final","tool":"none","message":"Natural final answer explaining what changed, what was verified, and how to run it if useful."}',
        '',
        previousInvalidOutput ? `Previous invalid output to repair:\n${previousInvalidOutput.slice(0, 1200)}` : '',
        'Workspace:',
        workspaceLines.join('\n'),
        '',
        'Tool results:',
        buildToolTranscript(toolEvents),
        '',
        'User task:',
        String(taskText || ''),
      ].filter(Boolean).join('\n');
    }

    async function requestAiNativeAgentReply(requestToken, chatId, promptText) {
      if (!deps.nativeBridge || !deps.nativeBridge.available || !deps.nativeBridge.available()) return false;
      const taskText = String(promptText || '').trim();
      if (!taskText) return false;

      const startedAt = now();
      const deadlineAt = startedAt + (Number(deps.agentTotalTimeoutMs) || 180000);
      const toolEvents = [];
      const agentActivities = [];

      const pushActivity = (activity) => {
        if (!activity) return;
        deps.mergeAgentActivityIntoList(agentActivities, activity);
        deps.pushActiveAgentStreamActivity(chatId, activity);
        deps.scheduleLiveStreamRender();
      };

      const setProgress = (text) => {
        if (!deps.isInferenceActive(requestToken)) return;
        if (!deps.hasLiveAssistantRow()) deps.createLiveAssistantRow(chatId);
        deps.setActiveAgentStreamStatus(chatId, text);
        deps.setLiveAgentProgress(text);
        deps.scheduleLiveStreamRender();
      };

      setProgress('Thinking...');

      let previousInvalidOutput = '';
      for (let step = 1; step <= maxSteps && now() < deadlineAt; step += 1) {
        const prompt = buildAiNativePrompt(taskText, toolEvents, previousInvalidOutput);
        const response = await deps.requestAgentPlannerInference(prompt, maxTokens, '');
        const raw = String(response && response.output ? response.output : '');
        const thought = splitThoughtAndJson(raw);
        if (thought) {
          pushActivity({
            kind: 'thought',
            title: '',
            detail: thought.slice(0, 900),
            status: 'done',
          });
        }

        const parsed = normalizeDecision(extractJsonObject(raw));
        if (!parsed) {
          previousInvalidOutput = raw || 'No model output.';
          toolEvents.push({
            tool: 'model_output',
            ok: false,
            observation: `The previous response was not a valid agent JSON step. Repair it and continue from the same task.`,
          });
          continue;
        }

        if (parsed.action === 'final' || parsed.tool === 'none') {
          const finalText = deps.sanitizeAssistantText(parsed.message || thought || 'Done.');
          if (toolEvents.some((event) => event && event.ok && ['new_project', 'write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(event.tool || '').toLowerCase()))) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.consumeLiveAssistantText();
          deps.commitAssistantMessage(chatId, finalText, finalText, {
            agentActivities,
            agentMeta: { startedAt, completedAt: now(), collapsed: true, experimental: true },
            forceNeedsContinue: false,
          });
          return true;
        }

        const target = deps.describeAgentToolTarget(parsed);
        const label = deps.describeAgentToolPhase(parsed.tool, target, 'start');
        setProgress(`${label}...`);
        pushActivity({
          kind: 'tool',
          title: label,
          detail: parsed.message || target || '',
          status: 'running',
          tool: parsed.tool,
          path: parsed.path,
        });

        const result = await deps.executeDeveloperToolCall(chatId, parsed, taskText, toolEvents, null);
        const event = {
          tool: parsed.tool,
          ok: Boolean(result && result.ok),
          path: deps.normalizeWorkspacePath(parsed.path || (result && result.path) || ''),
          srcPath: deps.normalizeWorkspacePath(parsed.srcPath || ''),
          dstPath: deps.normalizeWorkspacePath(parsed.dstPath || ''),
          observation: String(result && result.observation ? result.observation : ''),
        };
        toolEvents.push(event);
        pushActivity(deps.buildAgentActivityFromToolResult(parsed, result || {}, toolEvents));

        if (result && (result.requiresUserInput || result.requiresProjectScopeConfirmation)) {
          const text = deps.sanitizeAssistantText(result.userFacingMessage || result.observation || 'I need confirmation before continuing.');
          deps.consumeLiveAssistantText();
          deps.commitAssistantMessage(chatId, text, text, {
            agentActivities,
            agentMeta: { startedAt, completedAt: now(), collapsed: true, experimental: true },
            forceNeedsContinue: false,
          });
          return true;
        }
      }

      const finalPrompt = [
        buildAiNativePrompt(taskText, toolEvents, ''),
        '',
        'The step budget or time budget is exhausted. Return a final JSON object only. Explain what was completed, what remains, and the real blocker if any.',
      ].join('\n');
      const finalResponse = await deps.requestAgentPlannerInference(finalPrompt, maxTokens, '');
      const finalParsed = normalizeDecision(extractJsonObject(String(finalResponse && finalResponse.output ? finalResponse.output : '')));
      const finalText = deps.sanitizeAssistantText(
        finalParsed && finalParsed.message
          ? finalParsed.message
          : 'I reached the experimental agent step limit before the task was complete.'
      );
      if (toolEvents.some((event) => event && event.ok && ['new_project', 'write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(event.tool || '').toLowerCase()))) {
        await deps.refreshWorkspaceTree(true);
      }
      deps.consumeLiveAssistantText();
      deps.commitAssistantMessage(chatId, finalText, finalText, {
        agentActivities,
        agentMeta: { startedAt, completedAt: now(), collapsed: true, experimental: true },
        forceNeedsContinue: true,
      });
      return true;
    }

    return {
      requestAiNativeAgentReply,
      buildAiNativePrompt,
    };
  }

  global.AIExeAiNativeAgentLoop = {
    createAiNativeAgentLoop,
  };
})(window);
