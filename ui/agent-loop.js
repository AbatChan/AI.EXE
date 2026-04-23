(function initAIExeAgentLoop(global) {
  function createAgentLoop(deps) {
    const recordDebugTrace = typeof deps.recordDebugTrace === 'function'
      ? deps.recordDebugTrace
      : (kind, payload) => deps.pushDebugTrace(kind, payload);

    async function requestDeveloperAgentReply(requestToken, chatId, promptText) {
      if (!deps.nativeBridge.available()) return false;
      const taskText = String(promptText || '').trim();
      if (!taskText) return false;
      const toolEvents = [];
      const agentActivities = [];
      let lastCorrectionDetail = '';
      const startedAt = Date.now();
      const deadlineAt = startedAt + deps.agentTotalTimeoutMs;
      let planSpec = null;

      const appendAgentActivity = (activity) => {
        deps.mergeAgentActivityIntoList(agentActivities, activity);
        deps.pushActiveAgentStreamActivity(chatId, activity);
        if (deps.isInferenceActive(requestToken)) {
          deps.scheduleLiveStreamRender();
        }
      };

      const setAgentProgress = (text) => {
        if (!deps.isInferenceActive(requestToken)) return;
        if (!deps.hasLiveAssistantRow()) {
          deps.createLiveAssistantRow(chatId);
        }
        if (!deps.hasLiveAssistantRow()) return;
        deps.setActiveAgentStreamStatus(chatId, text);
        deps.setLiveAgentProgress(text);
        deps.scheduleLiveStreamRender();
      };

      const agentHasWorkspaceMutations = () => toolEvents.some((event) => (
        event
        && event.ok
        && ['new_project', 'write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(event.tool || '').toLowerCase())
      ));

      const isMutationTool = (tool) => ['new_project', 'write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(tool || '').toLowerCase());
      const normalizeDecisionPath = (value) => deps.normalizeWorkspacePath ? deps.normalizeWorkspacePath(value || '') : String(value || '');
      const buildDecisionSignature = (decision) => ({
        tool: String(decision && decision.tool ? decision.tool : '').toLowerCase(),
        path: normalizeDecisionPath(decision && decision.path),
        srcPath: normalizeDecisionPath(decision && decision.srcPath),
        dstPath: normalizeDecisionPath(decision && decision.dstPath),
      });
      const hasWorkspaceMutationSince = (index) => {
        const start = Math.max(-1, Number(index));
        for (let i = start + 1; i < toolEvents.length; i += 1) {
          const event = toolEvents[i];
          if (event && event.ok && isMutationTool(event.tool)) return true;
        }
        return false;
      };
      const findLastToolEventIndex = (predicate) => {
        for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
          if (predicate(toolEvents[i], i)) return i;
        }
        return -1;
      };
      const getDuplicateDecisionObservation = (decision) => {
        const signature = buildDecisionSignature(decision);
        if (!signature.tool) return '';
        const lastIndex = findLastToolEventIndex((event) => {
          if (!event) return false;
          return String(event.tool || '').toLowerCase() === signature.tool
            && normalizeDecisionPath(event.path || '') === signature.path
            && normalizeDecisionPath(event.srcPath || '') === signature.srcPath
            && normalizeDecisionPath(event.dstPath || '') === signature.dstPath;
        });
        if (lastIndex < 0) return '';
        const lastEvent = toolEvents[lastIndex];
        if (!lastEvent) return '';
        if (signature.tool === 'read_file' && lastEvent.ok && !hasWorkspaceMutationSince(lastIndex)) {
          return `read_file blocked for ${signature.path || 'this file'}: it was already read and no workspace changes happened since then. Use that result or take the next corrective step instead of rereading it.`;
        }
        if (!lastEvent.ok && !hasWorkspaceMutationSince(lastIndex)) {
          return `${signature.tool} blocked for ${signature.path || signature.dstPath || signature.srcPath || 'this target'}: the same tool/target already failed and nothing changed since then. Follow the latest observation and choose a different corrective step.`;
        }
        return '';
      };
      const hasSuccessfulNewProject = () => toolEvents.some((event) => (
        event && event.ok && String(event.tool || '').toLowerCase() === 'new_project'
      ));
      const repairDecisionBeforeExecution = (decision) => {
        if (!decision || decision.action !== 'tool') return decision;
        // Coerce edit_file with raw file content (not a JSON edit program) to write_file
        if (String(decision.tool || '').toLowerCase() === 'edit_file') {
          const rawContent = String(decision.content || '').trim();
          const looksLikeEditProgram = rawContent.startsWith('[') || rawContent.startsWith('{');
          const looksLikeRawCode = rawContent.length > 40 && !looksLikeEditProgram;
          if (looksLikeRawCode) {
            recordDebugTrace('agent_edit_file_coerced_to_write', {
              chatId: String(chatId || ''),
              step: String(step),
              path: String(decision.path || ''),
              reason: 'content_looks_like_raw_code_not_edit_program',
            }, {
              chatId: String(chatId || ''),
              step,
              originalDecision: decision,
            });
            return {
              ...decision,
              tool: 'write_file',
              raw: '[coerced-edit-file-to-write-file]',
            };
          }
        }
        if (String(decision.tool || '').toLowerCase() !== 'new_project') return decision;
        if (!hasSuccessfulNewProject()) return decision;
        const fallbackDecision = deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec);
        if (fallbackDecision && String(fallbackDecision.tool || '').toLowerCase() !== 'new_project') {
          recordDebugTrace('agent_decision_repaired', {
            chatId: String(chatId || ''),
            step: String(toolEvents.length + 1),
            fromTool: 'new_project',
            toTool: String(fallbackDecision.tool || ''),
            reason: 'workspace_already_created',
          }, {
            chatId: String(chatId || ''),
            originalDecision: decision,
            repairedDecision: fallbackDecision,
            reason: 'workspace_already_created',
            toolEvents,
          });
          return fallbackDecision;
        }
        const lastValidateIndex = findLastToolEventIndex((e) => String(e && e.tool || '').toLowerCase() === 'validate_files');
        if (lastValidateIndex >= 0 && !hasWorkspaceMutationSince(lastValidateIndex)) {
          const validateEvent = toolEvents[lastValidateIndex];
          if (validateEvent && validateEvent.validationPassed === false && Array.isArray(validateEvent.validationIssues) && validateEvent.validationIssues.length > 0) {
            const firstBrokenPathMatch = validateEvent.validationIssues[0].match(/^(\/[^[\]:\s]+)/);
            if (firstBrokenPathMatch && firstBrokenPathMatch[1]) {
              return {
                action: 'tool',
                tool: 'read_file',
                message: `Read ${firstBrokenPathMatch[1]} to begin repairing the validation issues instead of repeatedly recreating the workspace.`,
                path: deps.normalizeWorkspacePath(firstBrokenPathMatch[1]),
                content: '',
                srcPath: '',
                dstPath: '',
                raw: '[repair-read-broken-file]',
              };
            }
          }
        }
        return {
          action: 'tool',
          tool: 'validate_files',
          message: 'Validate the project files that were already created instead of recreating the workspace.',
          path: '',
          content: '',
          srcPath: '',
          dstPath: '',
          raw: '[repair-validate-after-new-project]',
        };
      };

      setAgentProgress('Planning...');
      if (typeof deps.syncWorkspaceStateFromNative === 'function') {
        await deps.syncWorkspaceStateFromNative('agent_start', { render: false });
      }
      planSpec = await deps.buildAgentPlanSpec(chatId, taskText);
      deps.applyAgentProjectChatName(chatId, planSpec);
      const workspaceStateComparison = typeof deps.getWorkspaceStateComparison === 'function'
        ? deps.getWorkspaceStateComparison()
        : null;
      const workspaceStatusSnapshot = typeof deps.requestWorkspaceStatusSnapshot === 'function'
        ? await deps.requestWorkspaceStatusSnapshot()
        : null;

      recordDebugTrace('agent_start', {
        chatId: String(chatId || ''),
        taskPreview: deps.debugPreview(taskText, 300),
        planKind: String(planSpec && planSpec.taskKind || ''),
        planProject: deps.debugPreview(String(planSpec && planSpec.projectName || ''), 80),
        planFiles: deps.debugPreview((planSpec && Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles.join(' | ') : ''), 220),
      }, {
        chatId: String(chatId || ''),
        taskText,
        planSpec,
        workspaceContext: typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() : null,
        workspaceStateComparison,
        workspaceStatusSnapshot,
      });
      deps.resetActiveAgentStreamState();
      appendAgentActivity(deps.buildAgentPlanActivity(planSpec));
      setAgentProgress('Starting...');

      for (let step = 1; step <= deps.agentMaxSteps; step += 1) {
        if (!deps.isInferenceActive(requestToken)) return true;
        if (Date.now() >= deadlineAt) {
          recordDebugTrace('agent_timeout', {
            chatId: String(chatId || ''),
            stage: 'total',
            elapsedMs: String(Date.now() - startedAt),
          }, {
            chatId: String(chatId || ''),
            stage: 'total',
            elapsedMs: Date.now() - startedAt,
          });
          appendAgentActivity({
            kind: 'error',
            title: 'Stopped',
            detail: 'Agent timed out before finishing.',
            status: 'error',
          });
          setAgentProgress('Stopped.');
          deps.setThinkingStatus('');
          deps.consumeLiveAssistantText();
          break;
        }

        deps.setThinkingStatus('');
        setAgentProgress('Thinking...');
        const agentPrompt = await deps.buildAgentDecisionPrompt(chatId, taskText, toolEvents, step, planSpec);
        const res = await Promise.race([
          deps.requestAgentPlannerInference(agentPrompt, deps.agentDecisionMaxTokens, deps.agentDecisionGrammar),
          new Promise((resolve) => setTimeout(() => resolve({
            ok: false,
            timedOut: true,
            message: 'Agent step timed out.',
          }), deps.agentStepTimeoutMs)),
        ]);

        if (!deps.isInferenceActive(requestToken)) return true;
        if (!res || !res.ok) {
          setAgentProgress('Stopped.');
          appendAgentActivity({
            kind: 'error',
            title: 'Stopped',
            detail: (res && res.timedOut) ? 'Agent step timed out.' : ((res && res.message) || 'Agent step failed.'),
            status: 'error',
          });
          recordDebugTrace('agent_error', {
            chatId: String(chatId || ''),
            step: String(step),
            reason: deps.debugPreview((res && res.message) || 'agent infer failed', 240),
            timedOut: String(Boolean(res && res.timedOut)),
          }, {
            chatId: String(chatId || ''),
            step,
            reason: String((res && res.message) || 'agent infer failed'),
            timedOut: Boolean(res && res.timedOut),
            agentPrompt,
          });
          deps.consumeLiveAssistantText();
          const failure = (res && res.timedOut)
            ? 'I started the workspace changes, but the agent timed out before finishing. Ask me to continue from the current project state.'
            : 'I started the workspace changes, but the agent hit an error before finishing. Ask me to continue from the current project state.';
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.commitAssistantMessage(chatId, failure, failure, {
            agentActivities,
            agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
            forceNeedsContinue: false,
          });
          return true;
        }

        let decision = deps.parseAgentDecision(String(res.output || ''));
        recordDebugTrace('agent_planner_output', {
          chatId: String(chatId || ''),
          step: String(step),
          model: deps.debugPreview(String((res && res.model) || ''), 120),
          rawPreview: deps.debugPreview(String(res.output || ''), 320),
        }, {
          chatId: String(chatId || ''),
          step,
          plannerSource: 'primary',
          plannerModel: String((res && res.model) || ''),
          agentPrompt,
          rawPlannerOutput: String(res.output || ''),
        });
        if (!decision) {
          const repairPrompt = await deps.buildAgentDecisionRepairPrompt(taskText, toolEvents, step, String(res.output || ''), planSpec);
          const repair = await Promise.race([
            deps.requestAgentPlannerInference(repairPrompt, deps.agentDecisionMaxTokens, deps.agentDecisionGrammar),
            new Promise((resolve) => setTimeout(() => resolve({
              ok: false,
              timedOut: true,
              message: 'Agent repair step timed out.',
            }), deps.agentStepTimeoutMs)),
          ]);
          if (deps.isInferenceActive(requestToken) && repair && repair.ok) {
            decision = deps.parseAgentDecision(String(repair.output || ''));
            recordDebugTrace('agent_planner_output', {
              chatId: String(chatId || ''),
              step: String(step),
              model: deps.debugPreview(String((repair && repair.model) || ''), 120),
              rawPreview: deps.debugPreview(String(repair.output || ''), 320),
            }, {
              chatId: String(chatId || ''),
              step,
              plannerSource: 'repair',
              plannerModel: String((repair && repair.model) || ''),
              agentPrompt: repairPrompt,
              rawPlannerOutput: String(repair.output || ''),
            });
          }
        }
        if (!decision) {
          const nativeRes = await Promise.race([
            deps.requestNativeAgentPlannerInference(agentPrompt, deps.agentDecisionMaxTokens, deps.agentDecisionGrammar),
            new Promise((resolve) => setTimeout(() => resolve({
              ok: false,
              timedOut: true,
              message: 'Native agent step timed out.',
            }), deps.agentStepTimeoutMs)),
          ]);
          if (deps.isInferenceActive(requestToken) && nativeRes && nativeRes.ok) {
            decision = deps.parseAgentDecision(String(nativeRes.output || ''));
            recordDebugTrace('agent_planner_output', {
              chatId: String(chatId || ''),
              step: String(step),
              model: deps.debugPreview(String((nativeRes && nativeRes.model) || ''), 120),
              rawPreview: deps.debugPreview(String(nativeRes.output || ''), 320),
            }, {
              chatId: String(chatId || ''),
              step,
              plannerSource: 'native',
              plannerModel: String((nativeRes && nativeRes.model) || ''),
              agentPrompt,
              rawPlannerOutput: String(nativeRes.output || ''),
            });
          }
          if (!decision) {
            const nativeRepairPrompt = await deps.buildAgentDecisionRepairPrompt(
              taskText,
              toolEvents,
              step,
              String((nativeRes && nativeRes.output) || (res && res.output) || ''),
              planSpec
            );
            const nativeRepair = await Promise.race([
              deps.requestNativeAgentPlannerInference(nativeRepairPrompt, deps.agentDecisionMaxTokens, deps.agentDecisionGrammar),
              new Promise((resolve) => setTimeout(() => resolve({
                ok: false,
                timedOut: true,
                message: 'Native agent repair step timed out.',
              }), deps.agentStepTimeoutMs)),
            ]);
            if (deps.isInferenceActive(requestToken) && nativeRepair && nativeRepair.ok) {
              decision = deps.parseAgentDecision(String(nativeRepair.output || ''));
              recordDebugTrace('agent_planner_output', {
                chatId: String(chatId || ''),
                step: String(step),
                model: deps.debugPreview(String((nativeRepair && nativeRepair.model) || ''), 120),
                rawPreview: deps.debugPreview(String(nativeRepair.output || ''), 320),
              }, {
                chatId: String(chatId || ''),
                step,
                plannerSource: 'native_repair',
                plannerModel: String((nativeRepair && nativeRepair.model) || ''),
                agentPrompt: nativeRepairPrompt,
                rawPlannerOutput: String(nativeRepair.output || ''),
              });
            }
          }
        }
        if (!decision) {
          const fallbackDecision = deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec);
          if (fallbackDecision) {
            decision = fallbackDecision;
            recordDebugTrace('agent_fallback_decision', {
              chatId: String(chatId || ''),
              step: String(step),
              tool: fallbackDecision.tool,
              path: deps.debugPreview(fallbackDecision.path, 180),
              reason: 'edit-after-read',
            }, {
              chatId: String(chatId || ''),
              step,
              fallbackDecision,
              reason: 'edit-after-read',
            });
          }
        }
        if (!decision) {
          setAgentProgress('Stopped.');
          appendAgentActivity({
            kind: 'error',
            title: 'Stopped',
            detail: 'Agent returned an invalid planning step.',
            status: 'error',
          });
          recordDebugTrace('agent_parse_error', {
            chatId: String(chatId || ''),
            step: String(step),
            rawPreview: deps.debugPreview(String(res.output || ''), 320),
          }, {
            chatId: String(chatId || ''),
            step,
            rawPlannerOutput: String(res.output || ''),
          });
          deps.consumeLiveAssistantText();
          const failure = 'I started the workspace changes, but the agent returned an invalid planning step. Ask me to continue from the current project state.';
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.commitAssistantMessage(chatId, failure, failure, {
            agentActivities,
            agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
            forceNeedsContinue: false,
          });
          return true;
        }

        decision = repairDecisionBeforeExecution(decision);

        recordDebugTrace('agent_decision', {
          chatId: String(chatId || ''),
          step: String(step),
          action: decision.action,
          tool: decision.tool,
          messagePreview: deps.debugPreview(decision.message, 220),
        }, {
          chatId: String(chatId || ''),
          step,
          decision,
          toolEvents,
        });

        const duplicateDecisionObservation = decision.action === 'tool'
          ? getDuplicateDecisionObservation(decision)
          : '';
        if (duplicateDecisionObservation) {
          toolEvents.push({
            tool: decision.tool,
            ok: false,
            path: normalizeDecisionPath(decision.path || ''),
            srcPath: normalizeDecisionPath(decision.srcPath || ''),
            dstPath: normalizeDecisionPath(decision.dstPath || ''),
            content: '',
            observation: duplicateDecisionObservation.slice(0, deps.agentMaxToolOutputChars),
          });
          recordDebugTrace('agent_tool_result', {
            chatId: String(chatId || ''),
            step: String(step),
            tool: decision.tool,
            ok: 'false',
            observationPreview: deps.debugPreview(duplicateDecisionObservation, 260),
          }, {
            chatId: String(chatId || ''),
            step,
            tool: decision.tool,
            ok: false,
            observation: duplicateDecisionObservation,
          });
          setAgentProgress('Continuing...');
          continue;
        }

        if (decision.action !== 'tool' || decision.tool === 'none') {
          const finalCheck = deps.validateAgentFinalDecision(taskText, toolEvents, planSpec);
          if (!finalCheck.ok) {
            toolEvents.push({
              tool: 'final_guard',
              ok: false,
              observation: `final blocked: still missing - ${finalCheck.missing.join('; ')}`,
            });
            recordDebugTrace('agent_final_rejected', {
              chatId: String(chatId || ''),
              step: String(step),
              missing: deps.debugPreview(finalCheck.missing.join('; '), 260),
            }, {
              chatId: String(chatId || ''),
              step,
              missing: finalCheck.missing,
              toolEvents,
            });
            setAgentProgress('Continuing...');
            continue;
          }
          setAgentProgress('Finalizing...');
          deps.consumeLiveAssistantText();
          const finalText = deps.sanitizeAssistantText(decision.message || 'Done.') || 'Done.';
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.commitAssistantMessage(chatId, finalText, finalText, {
            agentActivities,
            agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
            forceNeedsContinue: false,
          });
          recordDebugTrace('agent_done', {
            chatId: String(chatId || ''),
            step: String(step),
            finalPreview: deps.debugPreview(finalText, 260),
          }, {
            chatId: String(chatId || ''),
            step,
            finalText,
            toolEvents,
          });
          return true;
        }

        if (decision.thought) {
          appendAgentActivity({
            kind: 'thought',
            detail: decision.thought,
            status: 'done',
          });
        }

        const targetInfo = deps.describeAgentToolTarget(decision);
        const startLabel = decision.tool === 'write_file' && deps.isLikelyNewAgentFileTarget(toolEvents, targetInfo)
          ? (targetInfo ? `Creating file ${targetInfo}` : 'Creating file')
          : deps.describeAgentToolPhase(decision.tool, targetInfo, 'start');
        setAgentProgress(`${startLabel}...`);
        appendAgentActivity(deps.buildAgentPendingActivity(decision, toolEvents));
        const toolResult = await deps.executeDeveloperToolCall(chatId, decision, taskText, toolEvents, planSpec);
        if (toolResult && (toolResult.requiresUserInput || toolResult.requiresProjectScopeConfirmation)) {
          setAgentProgress('Waiting for confirmation...');
          deps.consumeLiveAssistantText();
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          let userChoice = null;
          if (toolResult.requiresProjectScopeConfirmation && typeof deps.requestProjectScopeConfirmation === 'function') {
            userChoice = await deps.requestProjectScopeConfirmation(chatId, {
              kind: 'project_scope',
              originalTask: String(taskText || ''),
              userMessage: String(toolResult.userFacingMessage || ''),
              workspaceOpen: toolResult.workspaceOpen === false ? false : Boolean(toolResult.workspaceOpen),
            });
            if (userChoice === 'create_new_project') {
              const response = await deps.invokeWorkspaceAction('workspaceNewProject', {});
              if (response && response.ok) {
                deps.resetWorkspaceForNewProject();
                toolResult.ok = true;
                toolResult.mutated = true;
                toolResult.observation = 'User explicitly confirmed creating a new project via UI. Workspace reset.';
              } else {
                toolResult.ok = false;
                toolResult.mutated = false;
                toolResult.observation = 'User confirmed creating a new project via UI, but creation failed: ' + String(response && response.message ? response.message : 'unknown error');
              }
            } else if (userChoice === 'use_existing_workspace') {
              toolResult.ok = true;
              toolResult.mutated = false;
              toolResult.observation = 'User explicitly bypassed new workspace creation via UI and chose to keep using the current workspace context.';
            }
          }
          
          if (!toolResult.requiresProjectScopeConfirmation || !userChoice) {
            const userFacingMessage = toolResult.requiresProjectScopeConfirmation
              ? 'I paused to ask for your confirmation before continuing. Please select an option below.'
              : deps.sanitizeAssistantText(toolResult.userFacingMessage || toolResult.observation || 'I need confirmation before continuing.');
            deps.commitAssistantMessage(chatId, userFacingMessage, userFacingMessage, {
              agentActivities,
              agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
              forceNeedsContinue: false,
            });
            recordDebugTrace('agent_confirmation_requested', {
              chatId: String(chatId || ''),
              step: String(step),
              tool: decision.tool,
              observationPreview: deps.debugPreview(String(toolResult.observation || ''), 260),
            }, {
              chatId: String(chatId || ''),
              step,
              tool: decision.tool,
              observation: String(toolResult.observation || ''),
              userFacingMessage: String(toolResult.userFacingMessage || ''),
              workspaceContext: typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() : null,
            });
            return true;
          }
          
          recordDebugTrace('agent_confirmation_resolved_inline', {
            chatId: String(chatId || ''),
            step: String(step),
            userChoice,
          }, {
            chatId: String(chatId || ''),
            step,
            userChoice,
            toolResultObservation: String(toolResult.observation || ''),
          });
          setAgentProgress('Continuing...');
        }
        const clippedObservation = String(toolResult.observation || '').slice(0, deps.agentMaxToolOutputChars);
        toolEvents.push({
          tool: decision.tool,
          ok: Boolean(toolResult.ok),
          path: deps.normalizeWorkspacePath(toolResult && toolResult.writtenPath ? toolResult.writtenPath : decision.path || ''),
          srcPath: deps.normalizeWorkspacePath(decision.srcPath || ''),
          dstPath: deps.normalizeWorkspacePath(decision.dstPath || ''),
          validationPassed: toolResult && toolResult.validationPassed === true,
          content: ['write_file', 'edit_file'].includes(String(decision.tool || '').toLowerCase())
            ? String(toolResult && typeof toolResult.writtenContent === 'string' ? toolResult.writtenContent : decision.content || '')
            : (String(decision.tool || '').toLowerCase() === 'read_file'
              ? String(toolResult && typeof toolResult.readContent === 'string' ? toolResult.readContent : '')
              : ''),
          observation: clippedObservation,
        });
        if (toolEvents.length > 48) {
          const removableIndex = toolEvents.findIndex((event) => {
            if (!event) return true;
            const tool = String(event.tool || '').toLowerCase();
            const ok = Boolean(event.ok);
            const path = deps.normalizeWorkspacePath(event.path || '');
            const criticalSuccess = ok && (
              tool === 'new_project'
              || tool === 'validate_files'
              || ['write_file', 'edit_file'].includes(tool)
              || path === '/README.md'
            );
            return !criticalSuccess;
          });
          if (removableIndex >= 0) {
            toolEvents.splice(removableIndex, 1);
          } else {
            toolEvents.shift();
          }
        }
        recordDebugTrace('agent_tool_result', {
          chatId: String(chatId || ''),
          step: String(step),
          tool: decision.tool,
          ok: String(Boolean(toolResult.ok)),
          observationPreview: deps.debugPreview(clippedObservation, 260),
        }, {
          chatId: String(chatId || ''),
          step,
          tool: decision.tool,
          ok: Boolean(toolResult.ok),
          observation: String(toolResult.observation || ''),
          writtenPath: String(toolResult && toolResult.writtenPath ? toolResult.writtenPath : ''),
          writtenContent: String(toolResult && toolResult.writtenContent ? toolResult.writtenContent : ''),
          readPath: String(toolResult && toolResult.readPath ? toolResult.readPath : ''),
          readContent: String(toolResult && toolResult.readContent ? toolResult.readContent : ''),
          validationPassed: toolResult && toolResult.validationPassed === true,
        });
        if (!toolResult.ok) {
          recordDebugTrace('agent_tool_blocked', {
            chatId: String(chatId || ''),
            step: String(step),
            tool: decision.tool,
            path: deps.normalizeWorkspacePath(decision.path || ''),
            srcPath: deps.normalizeWorkspacePath(decision.srcPath || ''),
            dstPath: deps.normalizeWorkspacePath(decision.dstPath || ''),
            observationPreview: deps.debugPreview(clippedObservation, 420),
          }, {
            chatId: String(chatId || ''),
            step,
            tool: decision.tool,
            path: deps.normalizeWorkspacePath(decision.path || ''),
            srcPath: deps.normalizeWorkspacePath(decision.srcPath || ''),
            dstPath: deps.normalizeWorkspacePath(decision.dstPath || ''),
            observation: String(toolResult.observation || ''),
          });
        }
        appendAgentActivity(deps.buildAgentActivityFromToolResult(decision, toolResult, toolEvents));
        if (decision.tool === 'validate_files' && toolResult.validationPassed === false) {
          const summary = Array.isArray(toolResult.validationIssues) && toolResult.validationIssues.length
            ? toolResult.validationIssues.slice(0, 3).join('; ')
            : clippedObservation.replace(/^validate_files found issues:\s*/i, '').trim();
          if (summary && summary !== lastCorrectionDetail) {
            appendAgentActivity(deps.buildAgentCorrectionActivity(summary));
            lastCorrectionDetail = summary;
          }
        }
        if (toolResult.ok) {
          const finalCheck = deps.validateAgentFinalDecision(taskText, toolEvents, planSpec);
          if (!finalCheck.ok) {
            const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
            const writtenPaths = toolEvents
              .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
              .map((event) => deps.normalizeWorkspacePath(event.path || ''))
              .filter(Boolean);
            const allExpectedFilesWritten = expectedFiles.length > 0
              && expectedFiles
                .filter((path) => path && path !== '/README.md' && path !== '/src')
                .every((path) => writtenPaths.includes(path));
            const correctionDetail = String(finalCheck.missing && finalCheck.missing[0] ? finalCheck.missing[0] : '').trim();
            // Suppress if validate_files already posted a correction this same step
            const validateJustFailed = decision.tool === 'validate_files' && toolResult.validationPassed === false;
            if (!validateJustFailed && allExpectedFilesWritten && correctionDetail && correctionDetail !== lastCorrectionDetail) {
              appendAgentActivity(deps.buildAgentCorrectionActivity(correctionDetail));
              lastCorrectionDetail = correctionDetail;
            }
          }
          if (finalCheck.ok) {
            setAgentProgress('Finalizing...');
            deps.consumeLiveAssistantText();
            const workspaceLabel = deps.getWorkspaceRootName() || deps.deriveProjectNameFromTask(taskText) || 'project';
            const finalText = await deps.generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec);
            if (agentHasWorkspaceMutations()) {
              await deps.refreshWorkspaceTree(true);
            }
            deps.commitAssistantMessage(chatId, finalText, finalText, {
              agentActivities,
              agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
              forceNeedsContinue: false,
            });
            recordDebugTrace('agent_done', {
              chatId: String(chatId || ''),
              step: String(step),
              autoFinalized: 'true',
              finalPreview: deps.debugPreview(finalText, 260),
            }, {
              chatId: String(chatId || ''),
              step,
              autoFinalized: true,
              finalText,
              toolEvents,
            });
            return true;
          }
        }
        if (!toolResult.ok) setAgentProgress('Adjusting...');

        if (toolResult.mutated) {
          await deps.refreshWorkspaceTree(true);
          deps.scheduleWorkspaceExplorerBackgroundRefresh(220);
        }
      }

      const fallback = 'I could not complete all tool steps in time. Tell me the exact file or folder changes you want next, and I will continue from the current workspace state.';
      setAgentProgress('Stopped.');
      deps.consumeLiveAssistantText();
      if (agentHasWorkspaceMutations()) {
        await deps.refreshWorkspaceTree(true);
      }
      deps.commitAssistantMessage(chatId, fallback, fallback, {
        agentActivities,
        agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
        forceNeedsContinue: false,
      });
      recordDebugTrace('agent_done', {
        chatId: String(chatId || ''),
        step: String(deps.agentMaxSteps),
        fallback: 'true',
      }, {
        chatId: String(chatId || ''),
        step: deps.agentMaxSteps,
        fallback: true,
        toolEvents,
      });
      return true;
    }

    return {
      requestDeveloperAgentReply,
    };
  }

  global.AIExeAgentLoop = {
    createAgentLoop,
  };
})(window);
