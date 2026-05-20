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
        if (!activity) return;
        deps.mergeAgentActivityIntoList(agentActivities, activity);
        deps.pushActiveAgentStreamActivity(chatId, activity);
        if (deps.isInferenceActive(requestToken)) {
          deps.scheduleLiveStreamRender();
        }
      };

      let lastNarrationDetail = '';
      const appendAgentNarration = (text) => {
        const detail = String(text || '').trim();
        if (!detail || detail.length < 8) return;
        if (/^(return exactly|keys:|rules:|json:|toolresult|agent step:)/i.test(detail)) return;
        if (detail === lastNarrationDetail) return;
        appendAgentActivity({
          kind: 'thought',
          title: '',
          detail: detail.slice(0, 900),
          status: 'done',
        });
        lastNarrationDetail = detail;
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

      const isWeakEditPlan = () => {
        if (String(planSpec && planSpec.taskKind || '').toLowerCase() !== 'edit') return false;
        const affectedFiles = Array.isArray(planSpec && planSpec.affectedFiles) ? planSpec.affectedFiles.filter(Boolean) : [];
        const doneCriteria = Array.isArray(planSpec && planSpec.doneCriteria) ? planSpec.doneCriteria.filter(Boolean) : [];
        return affectedFiles.length === 0 && doneCriteria.length === 0;
      };

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
        if (
          signature.tool === 'edit_file'
          && !lastEvent.ok
          && /read the file first/i.test(String(lastEvent.observation || ''))
          && toolEvents.slice(lastIndex + 1).some((event) => (
            event
            && event.ok
            && String(event.tool || '').toLowerCase() === 'read_file'
            && normalizeDecisionPath(event.path || '') === signature.path
          ))
        ) {
          return '';
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
        // Coerce raw edit_file payloads only while creating planned project files.
        if (String(decision.tool || '').toLowerCase() === 'edit_file') {
          const rawContent = String(decision.content || '').trim();
          const looksLikeEditProgram = rawContent.startsWith('[') || rawContent.startsWith('{');
          const looksLikeRawCode = rawContent.length > 40 && !looksLikeEditProgram;
          const isProjectCreation = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'project';
          const isEditTask = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'edit';
          const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
          const plannedInspectFiles = Array.isArray(planSpec && planSpec.filesToInspect)
            ? planSpec.filesToInspect.map((path) => deps.normalizeWorkspacePath(path || '')).filter(Boolean)
            : [];
          const plannedAffectedFiles = Array.isArray(planSpec && planSpec.affectedFiles)
            ? planSpec.affectedFiles.map((path) => deps.normalizeWorkspacePath(path || '')).filter(Boolean)
            : [];
          const targetPath = deps.normalizeWorkspacePath(decision.path || '');
          const isExpectedFile = expectedFiles.map((path) => deps.normalizeWorkspacePath(path || '')).includes(targetPath);
          const successfulReads = new Set(toolEvents
            .filter((event) => event && event.ok && String(event.tool || '').toLowerCase() === 'read_file')
            .map((event) => deps.normalizeWorkspacePath(event.path || ''))
            .filter(Boolean));
          const successfulWrites = new Set(toolEvents
            .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
            .map((event) => deps.normalizeWorkspacePath(event.path || ''))
            .filter(Boolean));
          if (isEditTask && plannedInspectFiles.length > 1) {
            const unreadPlannedFile = plannedInspectFiles.find((path) => !successfulReads.has(path));
            if (unreadPlannedFile) {
              recordDebugTrace('agent_edit_deferred_for_planned_read', {
                chatId: String(chatId || ''),
                step: String(step),
                attemptedPath: deps.debugPreview(targetPath, 180),
                readPath: deps.debugPreview(unreadPlannedFile, 180),
              }, {
                chatId: String(chatId || ''),
                step,
                originalDecision: decision,
                planSpec,
                toolEvents,
              });
              return {
                action: 'tool',
                tool: 'read_file',
                message: `Read ${unreadPlannedFile} before editing the coordinated feature.`,
                path: unreadPlannedFile,
                content: '',
                srcPath: '',
                dstPath: '',
                raw: '[repair-read-planned-file-before-edit]',
              };
            }
          }
          if (isEditTask && plannedAffectedFiles.length > 1 && targetPath && successfulWrites.has(targetPath)) {
            const untouchedAffectedFile = plannedAffectedFiles.find((path) => path !== targetPath && !successfulWrites.has(path));
            if (untouchedAffectedFile) {
              recordDebugTrace('agent_repeat_edit_redirected_to_planned_file', {
                chatId: String(chatId || ''),
                step: String(step),
                attemptedPath: deps.debugPreview(targetPath, 180),
                nextPath: deps.debugPreview(untouchedAffectedFile, 180),
              }, {
                chatId: String(chatId || ''),
                step,
                originalDecision: decision,
                planSpec,
                toolEvents,
              });
              return {
                action: 'tool',
                tool: successfulReads.has(untouchedAffectedFile) ? 'edit_file' : 'read_file',
                message: successfulReads.has(untouchedAffectedFile)
                  ? `Update ${untouchedAffectedFile} as the next planned file for this feature.`
                  : `Read ${untouchedAffectedFile} before editing the next planned file.`,
                path: untouchedAffectedFile,
                content: '',
                srcPath: '',
                dstPath: '',
                raw: successfulReads.has(untouchedAffectedFile)
                  ? '[repair-edit-next-planned-file]'
                  : '[repair-read-next-planned-file]',
              };
            }
          }
          const hasReadTarget = toolEvents.some((event) => (
            event
            && event.ok
            && String(event.tool || '').toLowerCase() === 'read_file'
            && deps.normalizeWorkspacePath(event.path || '') === targetPath
          ));
          if (looksLikeRawCode && isProjectCreation && isExpectedFile && !hasReadTarget) {
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
          return {
            action: 'final',
            tool: 'none',
            message: 'Done.',
            path: '',
            content: '',
            srcPath: '',
            dstPath: '',
            raw: '[repair-final-after-duplicate-validation]',
          };
        }
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

      setAgentProgress('Thinking...');
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
        let agentPrompt = '';
        let rawPlannerOutput = '';
        let decision = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'project'
          ? deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec)
          : null;
        if (decision) {
          recordDebugTrace('agent_deterministic_decision', {
            chatId: String(chatId || ''),
            step: String(step),
            tool: String(decision.tool || ''),
            path: deps.debugPreview(String(decision.path || ''), 180),
          }, {
            chatId: String(chatId || ''),
            step,
            decision,
            reason: 'project_requirements',
            toolEvents,
          });
        } else {
          setAgentProgress('Thinking...');
          agentPrompt = await deps.buildAgentDecisionPrompt(chatId, taskText, toolEvents, step, planSpec);
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
              forceNeedsContinue: true,
            });
            return true;
          }

          rawPlannerOutput = String(res.output || '');
          decision = deps.parseAgentDecision(rawPlannerOutput);
          recordDebugTrace('agent_planner_output', {
            chatId: String(chatId || ''),
            step: String(step),
            model: deps.debugPreview(String((res && res.model) || ''), 120),
            rawPreview: deps.debugPreview(rawPlannerOutput, 320),
          }, {
            chatId: String(chatId || ''),
            step,
            plannerSource: 'primary',
            plannerModel: String((res && res.model) || ''),
            agentPrompt,
            rawPlannerOutput,
          });
          if (!decision) {
            const fallbackDecision = deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec);
            if (fallbackDecision) {
              decision = fallbackDecision;
              recordDebugTrace('agent_fallback_decision', {
                chatId: String(chatId || ''),
                step: String(step),
                tool: fallbackDecision.tool,
                path: deps.debugPreview(fallbackDecision.path, 180),
                reason: 'primary-invalid',
              }, {
                chatId: String(chatId || ''),
                step,
                fallbackDecision,
                reason: 'primary-invalid',
                rawPlannerOutput,
              });
            }
          }
          if (!decision) {
            const repairPrompt = await deps.buildAgentDecisionRepairPrompt(taskText, toolEvents, step, rawPlannerOutput, planSpec);
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
              reason: 'fallback-after-planner',
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
            rawPreview: deps.debugPreview(rawPlannerOutput, 320),
          }, {
            chatId: String(chatId || ''),
            step,
            rawPlannerOutput,
          });
          deps.consumeLiveAssistantText();
          const failure = 'I started the workspace changes, but the agent returned an invalid planning step. Ask me to continue from the current project state.';
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.commitAssistantMessage(chatId, failure, failure, {
            agentActivities,
            agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
            forceNeedsContinue: true,
          });
          return true;
        }

        decision = repairDecisionBeforeExecution(decision);

        appendAgentNarration(decision.thought);

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
          let duplicateRepairedToFallback = false;
          const duplicateTool = String(decision.tool || '').toLowerCase();
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
          if (duplicateTool === 'validate_files') {
            const finalCheck = deps.validateAgentFinalDecision(taskText, toolEvents, planSpec);
            const missing = Array.isArray(finalCheck && finalCheck.missing) ? finalCheck.missing : [];
            const onlyValidationMissing = missing.length > 0 && missing.every((item) => /validate/i.test(String(item || '')));
            if (((finalCheck && finalCheck.ok) || onlyValidationMissing) && !isWeakEditPlan()) {
              deps.consumeLiveAssistantText();
              setAgentProgress('Finalizing...');
              const workspaceLabel = deps.getWorkspaceRootName() || deps.deriveProjectNameFromTask(taskText) || 'project';
              const finalText = await deps.generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec);
              if (agentHasWorkspaceMutations()) {
                await deps.refreshWorkspaceTree(true);
              }
              deps.consumeLiveAssistantText();
              deps.commitAssistantMessage(chatId, finalText, finalText, {
                agentActivities,
                agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
                forceNeedsContinue: false,
              });
              recordDebugTrace('agent_done', {
                chatId: String(chatId || ''),
                step: String(step),
                autoFinalized: 'true',
                reason: 'duplicate_validate_files_only_missing_requirement',
                finalPreview: deps.debugPreview(finalText, 260),
              }, {
                chatId: String(chatId || ''),
                step,
                autoFinalized: true,
                reason: 'duplicate_validate_files_only_missing_requirement',
                finalText,
                toolEvents,
              });
              return true;
            }
          }
          if (duplicateTool === 'edit_file' || duplicateTool === 'read_file') {
            const duplicatePath = normalizeDecisionPath(decision.path || '');
            const fallbackDecision = deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec);
            if (fallbackDecision && fallbackDecision.action === 'tool' && fallbackDecision.tool && fallbackDecision.tool !== 'none') {
              const fallbackSignature = buildDecisionSignature(fallbackDecision);
              const duplicateSignature = buildDecisionSignature(decision);
              const sameTarget = fallbackSignature.tool === duplicateSignature.tool
                && fallbackSignature.path === duplicateSignature.path
                && fallbackSignature.srcPath === duplicateSignature.srcPath
                && fallbackSignature.dstPath === duplicateSignature.dstPath;
              if (!sameTarget) {
                recordDebugTrace('agent_duplicate_decision_repaired', {
                  chatId: String(chatId || ''),
                  step: String(step),
                  fromTool: String(decision.tool || ''),
                  fromPath: deps.debugPreview(String(decision.path || ''), 180),
                  toTool: String(fallbackDecision.tool || ''),
                  toPath: deps.debugPreview(String(fallbackDecision.path || ''), 180),
                }, {
                  chatId: String(chatId || ''),
                  step,
                  originalDecision: decision,
                  repairedDecision: fallbackDecision,
                  duplicateDecisionObservation,
                  toolEvents,
                });
                decision = fallbackDecision;
                duplicateRepairedToFallback = true;
              }
            }
            if (duplicateRepairedToFallback) {
              setAgentProgress('Continuing...');
            } else {
              const duplicateBlockedCount = toolEvents.filter((event) => (
                event
                && !event.ok
                && String(event.tool || '').toLowerCase() === duplicateTool
                && normalizeDecisionPath(event.path || '') === duplicatePath
                && /same tool\/target already failed|already read and no workspace changes/i.test(String(event.observation || ''))
              )).length;
              if (duplicateBlockedCount >= 2) {
                const blockedText = duplicateTool === 'edit_file'
                  ? `I stopped because editing ${duplicatePath || 'the target file'} kept hitting the same blocker. I did not switch to unrelated files just to keep the loop running.`
                  : `I stopped because ${duplicatePath || 'that file'} was already read and no workspace changes happened after it. I did not keep rereading or switch to unrelated files.`;
                setAgentProgress('Stopped.');
                deps.consumeLiveAssistantText();
                deps.commitAssistantMessage(chatId, blockedText, blockedText, {
                  agentActivities,
                  agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
                  forceNeedsContinue: true,
                });
                recordDebugTrace('agent_done', {
                  chatId: String(chatId || ''),
                  step: String(step),
                  fallback: 'true',
                  reason: 'duplicate_target_blocker',
                }, {
                  chatId: String(chatId || ''),
                  step,
                  fallback: true,
                  reason: 'duplicate_target_blocker',
                  toolEvents,
                });
                return true;
              }
              setAgentProgress('Continuing...');
              continue;
            }
          }
          const fallbackDecision = duplicateRepairedToFallback ? null : deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec);
          if (fallbackDecision && fallbackDecision.action === 'tool' && fallbackDecision.tool && fallbackDecision.tool !== 'none') {
            const fallbackSignature = buildDecisionSignature(fallbackDecision);
            const duplicateSignature = buildDecisionSignature(decision);
            const sameTarget = fallbackSignature.tool === duplicateSignature.tool
              && fallbackSignature.path === duplicateSignature.path
              && fallbackSignature.srcPath === duplicateSignature.srcPath
              && fallbackSignature.dstPath === duplicateSignature.dstPath;
            if (!sameTarget) {
              recordDebugTrace('agent_duplicate_decision_repaired', {
                chatId: String(chatId || ''),
                step: String(step),
                fromTool: String(decision.tool || ''),
                fromPath: deps.debugPreview(String(decision.path || ''), 180),
                toTool: String(fallbackDecision.tool || ''),
                toPath: deps.debugPreview(String(fallbackDecision.path || ''), 180),
              }, {
                chatId: String(chatId || ''),
                step,
                originalDecision: decision,
                repairedDecision: fallbackDecision,
                duplicateDecisionObservation,
                toolEvents,
              });
              decision = fallbackDecision;
            } else {
              setAgentProgress('Continuing...');
              continue;
            }
          } else {
          setAgentProgress('Continuing...');
          continue;
          }
        }

        if (decision.action !== 'tool' || decision.tool === 'none') {
          const finalCheck = deps.validateAgentFinalDecision(taskText, toolEvents, planSpec);
          if (!finalCheck.ok) {
            const fallbackDecision = deps.deriveFallbackAgentDecision(taskText, toolEvents, planSpec);
            if (fallbackDecision && fallbackDecision.action === 'tool' && fallbackDecision.tool && fallbackDecision.tool !== 'none') {
              decision = fallbackDecision;
              recordDebugTrace('agent_final_repaired', {
                chatId: String(chatId || ''),
                step: String(step),
                tool: String(fallbackDecision.tool || ''),
                path: deps.debugPreview(String(fallbackDecision.path || ''), 180),
                missing: deps.debugPreview(finalCheck.missing.join('; '), 260),
              }, {
                chatId: String(chatId || ''),
                step,
                missing: finalCheck.missing,
                repairedDecision: fallbackDecision,
                toolEvents,
              });
            } else {
              const missingText = finalCheck.missing.join('; ');
              toolEvents.push({
                tool: 'final_guard',
                ok: false,
                observation: `final blocked: still missing - ${missingText}`,
              });
              recordDebugTrace('agent_final_rejected', {
                chatId: String(chatId || ''),
                step: String(step),
                missing: deps.debugPreview(missingText, 260),
                stopped: 'true',
              }, {
                chatId: String(chatId || ''),
                step,
                missing: finalCheck.missing,
                toolEvents,
                stopped: true,
              });
              setAgentProgress('Stopped.');
              appendAgentActivity({
                kind: 'error',
                title: 'Stopped',
                detail: `I could not determine the next safe workspace step. Still missing: ${missingText}`,
                status: 'error',
              });
              deps.consumeLiveAssistantText();
              if (agentHasWorkspaceMutations()) {
                await deps.refreshWorkspaceTree(true);
              }
              const failure = `I stopped because the agent planner kept trying to finish before the work was complete. Still missing: ${missingText}`;
              deps.commitAssistantMessage(chatId, failure, failure, {
                agentActivities,
                agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
                forceNeedsContinue: false,
              });
              return true;
            }
          }
          if (decision.action === 'tool' && decision.tool !== 'none') {
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
              repairedFromFinal: true,
            });
          } else {
            deps.consumeLiveAssistantText();
            setAgentProgress('Finalizing...');
            const finalText = deps.sanitizeAssistantText(decision.message || 'Done.') || 'Done.';
            if (agentHasWorkspaceMutations()) {
              await deps.refreshWorkspaceTree(true);
            }
            deps.consumeLiveAssistantText();
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
          validationIssues: Array.isArray(toolResult && toolResult.validationIssues)
            ? toolResult.validationIssues.map((issue) => String(issue || '')).filter(Boolean)
            : [],
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
        if (!toolResult.ok && String(decision.tool || '').toLowerCase() === 'write_file') {
          const failedPath = deps.normalizeWorkspacePath(decision.path || '');
          const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles)
            ? planSpec.expectedFiles.map((path) => deps.normalizeWorkspacePath(path || '')).filter(Boolean)
            : [];
          const isExpectedFile = expectedFiles.includes(failedPath);
          const observation = String(toolResult.observation || '');
          const isGenerationBlock = /content still looks too small|placeholder-like|incomplete|empty content|syntax error|did not pass validation|unclosed|unterminated|truncated|unmatched/i.test(observation);
          if (isExpectedFile && isGenerationBlock) {
            const writtenPaths = toolEvents
              .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
              .map((event) => deps.normalizeWorkspacePath(event.path || ''))
              .filter(Boolean);
            const writtenSummary = writtenPaths.length
              ? ` I kept the files already written: ${writtenPaths.slice(0, 4).join(', ')}.`
              : '';
            const stoppedText = `I stopped because the generated content for ${failedPath} did not pass the project quality check.${writtenSummary} The workspace is left in its current state so you can continue or retry without losing the files already created.`;
            setAgentProgress('Stopped.');
            deps.consumeLiveAssistantText();
            if (agentHasWorkspaceMutations()) {
              await deps.refreshWorkspaceTree(true);
            }
            deps.commitAssistantMessage(chatId, stoppedText, stoppedText, {
              agentActivities,
              agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
              forceNeedsContinue: false,
            });
            recordDebugTrace('agent_stopped_after_blocked_file_generation', {
              chatId: String(chatId || ''),
              step: String(step),
              path: failedPath,
              observationPreview: deps.debugPreview(observation, 300),
            }, {
              chatId: String(chatId || ''),
              step,
              path: failedPath,
              observation,
              toolEvents,
            });
            return true;
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
          if (finalCheck.ok && !isWeakEditPlan()) {
            deps.consumeLiveAssistantText();
            setAgentProgress('Finalizing...');
            const workspaceLabel = deps.getWorkspaceRootName() || deps.deriveProjectNameFromTask(taskText) || 'project';
            const finalText = await deps.generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec);
            if (agentHasWorkspaceMutations()) {
              await deps.refreshWorkspaceTree(true);
            }
            deps.consumeLiveAssistantText();
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
