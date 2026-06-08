(function initAIExeAgentLoop(global) {
  // Pure derivation for the bounded self-correction circuit breaker: given a tool
  // decision + its result, return a stable failure signature ({ streakPath,
  // shortReason, normIssue, streakKey }) when this step is a "file is bad" failure
  // worth retrying, or null otherwise. Keyed on path + normalized issue so the same
  // failure repeating accumulates, while a productive fix (different issue) resets.
  // Extracted so it can be unit-tested without driving the full inference loop.
  function deriveAgentFailureSignature(decision, toolResult, normalizeWorkspacePath) {
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const failTool = String((decision && decision.tool) || '').toLowerCase();
    const isValidationBad = failTool === 'validate_files' && toolResult && toolResult.validationPassed === false;
    const isHardEditFailure = Boolean(toolResult && !toolResult.ok && failTool === 'edit_file');
    if (!isValidationBad && !isHardEditFailure) return null;
    const rawIssue = isValidationBad
      ? (Array.isArray(toolResult.validationIssues) && toolResult.validationIssues.length
        ? String(toolResult.validationIssues[0])
        : 'validation failed')
      : String(toolResult.observation || '');
    const issuePathMatch = rawIssue.match(/(\/[^[\]:\s]+)/);
    const failedPath = norm((toolResult && toolResult.writtenPath) || (decision && decision.path) || '');
    const streakPath = (issuePathMatch && issuePathMatch[1]) || failedPath || `tool:${failTool}`;
    const shortReason = rawIssue
      .replace(/^[a-z_]+ (?:blocked|failed) for [^:]+:\s*/i, '')
      .trim()
      .slice(0, 140) || 'it did not pass the check';
    const normIssue = shortReason.replace(/`[^`]*`/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    return { streakPath, shortReason, normIssue, rawIssue, streakKey: `${streakPath}|${normIssue}` };
  }

  // Successful reads+searches since the last mutation. Drives the inspection-budget
  // guard (stop inspecting forever without editing); resets on each mutation.
  function countInspectionsSinceMutation(toolEvents) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    let inspections = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (!e || !e.ok) continue;
      const tool = String(e.tool || '').toLowerCase();
      if (tool === 'write_file' || tool === 'edit_file' || tool === 'new_project') break;
      if (tool === 'read_file' || tool === 'search_files') inspections += 1;
    }
    return inspections;
  }

  // Range/truncation-aware read-loop guard: blocks exact re-reads, re-reads of a
  // fully-seen file, and a hard cap — but allows paging forward while truncated.
  function summarizeReadRange(ev) {
    return `${Number(ev && ev.startLine) || 0}:${Number(ev && ev.endLine) || 0}:${Number(ev && ev.offset) || 0}`;
  }
  function readEventWasTruncated(ev) {
    return /\[file continues/i.test(String((ev && ev.observation) || ''));
  }
  function evaluateRepeatedRead(toolEvents, readPath, currentSig, hardCap = 6) {
    const events = Array.isArray(toolEvents) ? toolEvents : [];
    // Only count reads AFTER the last edit/write — re-reading to verify a change is legit.
    let lastMutationIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e && e.ok && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase())
        && String(e.path || '') === readPath) { lastMutationIndex = i; break; }
    }
    const priorReads = events.filter((e, i) => e && e.ok && i > lastMutationIndex
      && String(e.tool || '').toLowerCase() === 'read_file'
      && String(e.path || '') === readPath);
    if (priorReads.length === 0) return null;
    if (priorReads.some((e) => summarizeReadRange(e) === currentSig)) return 'exact-repeat';
    if (priorReads.length >= hardCap) return 'hard-cap';
    const last = priorReads[priorReads.length - 1];
    // "already-seen" only blocks BROAD/full re-reads; a targeted line-range read
    // (focusing on a section to edit) is allowed, bounded by exact-repeat + hard cap.
    const sigParts = String(currentSig).split(':');
    const currentIsTargeted = (Number(sigParts[0]) || 0) > 0 || (Number(sigParts[2]) || 0) > 0;
    if (priorReads.length >= 2 && !readEventWasTruncated(last) && !currentIsTargeted) return 'already-seen';
    // Otherwise the file is still partially unseen (last read truncated) — allow
    // the model to page forward to the part it has not read yet.
    return null;
  }

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
      // Oscillation guard: if an edit returns a file to a prior content state, the
      // agent is flip-flopping — block further edits to it and finalize.
      const fileStateHistory = new Map(); // path -> Set(contentHash)
      const oscillatingEditPaths = new Set();
      const hashFileState = (text) => {
        const s = String(text || '');
        let h = 5381;
        for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return `${s.length}:${h}`;
      };
      let lastCorrectionDetail = '';
      // Advisory final-gate: nudge the model at most once when it tries to
      // finish with planned items still unmet, then trust its judgment.
      let finalNudges = 0;
      const startedAt = Date.now();
      const deadlineAt = startedAt + deps.agentTotalTimeoutMs;
      let planSpec = null;
      // Guaranteed finalizer (see the matching finally at the end): the run must
      // never exit — via early return, stop, or a thrown error — while the chat
      // still shows an in-progress "...". loader. The send-button state is always
      // reset by the outer handler's completeInferenceRequest; this gives the chat
      // stream the same guarantee so the partial response is committed (saved) and
      // the spinner clears instead of being orphaned and lost on reload.
      try {

      const appendAgentActivity = (activity) => {
        if (!activity) return;
        deps.mergeAgentActivityIntoList(agentActivities, activity);
        deps.pushActiveAgentStreamActivity(chatId, activity);
        if (deps.isInferenceActive(requestToken)) {
          deps.scheduleLiveStreamRender();
        }
      };

      const synthesizeToolNarration = (decision) => {
        const tool = String(decision && decision.tool || '').toLowerCase();
        const path = String(decision && decision.path || '').trim();
        if (tool === 'read_file') return path ? `Reading ${path} before deciding the next change.` : 'Reading the file before deciding the next change.';
        if (tool === 'search_files') return 'Searching for relevant code patterns before choosing files to edit.';
        if (tool === 'edit_file') return path ? `Applying the targeted edit in ${path}.` : 'Applying the targeted file edit.';
        if (tool === 'write_file') return path ? `Writing ${path}.` : 'Writing the file.';
        if (tool === 'validate_files') return 'Checking the changed files before finishing.';
        if (tool === 'list_dir') return 'Checking the workspace structure.';
        if (tool === 'mkdir') return path ? `Creating directory ${path}.` : 'Creating the directory.';
        if (tool === 'move') return 'Moving the file to its final location.';
        if (tool === 'delete') return path ? `Removing ${path}.` : 'Removing the file.';
        return '';
      };

      let lastNarrationDetail = '';
      let deterministicBatchNarrated = false;
      const appendAgentNarration = (text) => {
        const detail = String(text || '').trim();
        if (!detail || detail.length < 8) return;
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
        offset: Number(decision && decision.offset || 0),
        startLine: Number(decision && decision.start_line || 0),
        endLine: Number(decision && decision.end_line || 0),
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
            && normalizeDecisionPath(event.dstPath || '') === signature.dstPath
            && Number(event.offset || 0) === signature.offset
            && Number(event.startLine || 0) === signature.startLine
            && Number(event.endLine || 0) === signature.endLine;
        });
        if (lastIndex < 0) return '';
        const lastEvent = toolEvents[lastIndex];
        if (!lastEvent) return '';
        if (signature.tool === 'read_file' && lastEvent.ok && !hasWorkspaceMutationSince(lastIndex)) {
          const truncLimit = Number(deps.agentMaxToolOutputChars) || 8000;
          const obs = String(lastEvent.observation || '');
          const wasLikelyTruncated = obs.length >= truncLimit - 20 || obs.includes('[file continues');
          if (!wasLikelyTruncated) {
            return `read_file blocked for ${signature.path || 'this file'}: it was already read and no workspace changes happened since then. Use that result or take the next corrective step instead of rereading it.`;
          }
        }
        if (signature.tool === 'list_dir' && lastEvent.ok && !hasWorkspaceMutationSince(lastIndex)) {
          return `list_dir blocked for ${signature.path || '/'}: you already listed this folder and nothing has changed since then. Use that result and take the next concrete step (write or edit a file) instead of re-listing.`;
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
          if (signature.tool === 'edit_file') {
            const hasRefreshedRead = toolEvents.slice(lastIndex + 1).some((e) => (
              e && e.ok
              && String(e.tool || '').toLowerCase() === 'read_file'
              && normalizeDecisionPath(e.path || '') === signature.path
            ));
            if (hasRefreshedRead) return '';
          }
          return `${signature.tool} blocked for ${signature.path || signature.dstPath || signature.srcPath || 'this target'}: the same tool/target already failed and nothing changed since then. Follow the latest observation and choose a different corrective step.`;
        }
        return '';
      };
      const hasSuccessfulNewProject = () => toolEvents.some((event) => (
        event && event.ok && String(event.tool || '').toLowerCase() === 'new_project'
      ));
      const isCoordinatedFrontendEdit = () => (
        String(planSpec && planSpec.taskKind || '').toLowerCase() === 'edit'
        && /\b(design|style|layout|responsive|mobile|dark\s*mode|light\s*mode|theme|toggle|calculator|modern|polish|ui|frontend)\b/i.test(taskText)
      );
      const getKnownRootFilePaths = () => {
        const paths = [];
        const workspaceContext = typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() : null;
        const rootEntries = Array.isArray(workspaceContext && workspaceContext.rootEntries) ? workspaceContext.rootEntries : [];
        rootEntries.forEach((entry) => {
          if (!entry || String(entry.kind || '').toLowerCase() === 'folder') return;
          const path = deps.normalizeWorkspacePath((entry.path || (entry.name ? `/${entry.name}` : '')));
          if (path) paths.push(path);
        });
        toolEvents.forEach((event) => {
          if (!event || !event.ok || String(event.tool || '').toLowerCase() !== 'list_dir') return;
          String(event.observation || '').split(/\n/).forEach((line) => {
            const match = line.match(/-\s+\[file\]\s+([^\s(]+)/i);
            if (match && match[1]) {
              const base = deps.normalizeWorkspacePath(event.path || '/') || '/';
              const name = match[1].replace(/^\/+/, '');
              paths.push(deps.normalizeWorkspacePath(base === '/' ? `/${name}` : `${base}/${name}`));
            }
          });
        });
        return Array.from(new Set(paths.filter(Boolean)));
      };
      const getCoordinatedFrontendFiles = () => {
        const plannedFiles = []
          .concat(Array.isArray(planSpec && planSpec.filesToInspect) ? planSpec.filesToInspect : [])
          .concat(Array.isArray(planSpec && planSpec.affectedFiles) ? planSpec.affectedFiles : [])
          .concat(Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [])
          .map((path) => deps.normalizeWorkspacePath(path || ''))
          .filter(Boolean);
        const knownRootFiles = getKnownRootFilePaths();
        const sourceCandidates = knownRootFiles.filter((path) => /\.(?:html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx)$/i.test(path));
        const coordinated = isCoordinatedFrontendEdit()
          ? [
            sourceCandidates.find((path) => /\.html?$/i.test(path)) || '',
            sourceCandidates.find((path) => /\.(?:css|scss|sass|less)$/i.test(path)) || '',
            sourceCandidates.find((path) => /\.(?:js|mjs|cjs|ts|jsx|tsx)$/i.test(path)) || '',
          ].filter(Boolean)
          : [];
        return Array.from(new Set(plannedFiles.concat(coordinated))).filter(Boolean);
      };
      const repairDecisionBeforeExecution = (decision, step) => {
        if (!decision || decision.action !== 'tool') return decision;
        // Coerce raw edit_file payloads only while creating planned project files.
        if (String(decision.tool || '').toLowerCase() === 'edit_file') {
          const rawContent = String(decision.content || '').trim();
          const looksLikeEditProgram = rawContent.startsWith('[') || rawContent.startsWith('{');
          const looksLikeRawCode = rawContent.length > 40 && !looksLikeEditProgram;
          const isProjectCreation = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'project';
          const isEditTask = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'edit';
          const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
          const plannedInspectFiles = getCoordinatedFrontendFiles();
          const plannedAffectedFiles = plannedInspectFiles.length
            ? plannedInspectFiles
            : (Array.isArray(planSpec && planSpec.affectedFiles)
              ? planSpec.affectedFiles.map((path) => deps.normalizeWorkspacePath(path || '')).filter(Boolean)
              : []);
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
      // When the user explicitly approved creating a new project at preflight,
      // force project scope INSIDE the planner so expectedFiles/finalRequiresRealFiles
      // are derived coherently. (Just relabelling taskKind afterward produced an
      // "empty project is done" plan that finalized after new_project with no files.)
      const approvedNewProject = Boolean(requestToken && requestToken.approvedNewProject);
      planSpec = await deps.buildAgentPlanSpec(chatId, taskText, { forceProjectScope: approvedNewProject });
      // Safety net: if a planner ever returns a non-project plan despite the flag,
      // rebuild a coherent project plan rather than leaving derived fields stale.
      if (approvedNewProject && planSpec && String(planSpec.taskKind || '').toLowerCase() !== 'project'
        && typeof deps.buildFallbackAgentPlanSpec === 'function') {
        planSpec = deps.buildFallbackAgentPlanSpec(taskText, { chatId, forceProjectScope: true });
      }
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
      const planActivity = deps.buildAgentPlanActivity(planSpec);
      appendAgentActivity(planActivity);
      if (!planActivity && planSpec && planSpec.summary) {
        appendAgentNarration(planSpec.summary);
      }

      // Harness-driven checklist from planSpec.doneCriteria (marked done mechanically).
      const checklistItems = Array.isArray(planSpec && planSpec.doneCriteria)
        ? planSpec.doneCriteria.filter(Boolean)
        : [];
      let lastChecklistSignature = '';
      const refreshChecklist = () => {
        if (!checklistItems.length || typeof deps.computeAgentChecklistProgress !== 'function') return null;
        const progress = deps.computeAgentChecklistProgress(checklistItems, toolEvents);
        const doneCount = progress.filter((p) => p && p.done).length;
        const signature = progress.map((p) => `${p.done ? '1' : '0'}:${p.text}`).join('|');
        if (signature !== lastChecklistSignature) {
          lastChecklistSignature = signature;
          appendAgentActivity({
            kind: 'checklist',
            title: 'Plan',
            meta: `${doneCount}/${progress.length}`,
            items: progress.map((p) => ({ text: p.text, done: p.done })),
            status: 'done',
          });
        }
        return {
          progress,
          doneCount,
          total: progress.length,
          remaining: progress.filter((p) => p && !p.done).map((p) => p.text),
          allDone: doneCount >= progress.length && progress.length > 0,
        };
      };
      refreshChecklist();
      setAgentProgress('Starting...');

      const sameFailureLimit = 3;
      const failureStreak = { key: '', count: 0 };
      // "One repair, then ship": count how many times validate_files has failed. After
      // the first repair attempt (2nd failure), if only MINOR cross-file naming gaps
      // remain, the project finishes successfully with an advisory note instead of
      // looping or stopping over polish. A "minor" gap is a cross-file id/class
      // reference mismatch — NOT a syntax/truncation/empty problem (those still get
      // repaired, and continuation prevents most of them now).
      let validationFailureCount = 0;
      const isMinorCrossFileIssue = (issue) => {
        const s = String(issue || '').toLowerCase();
        if (/unclosed|unterminated|truncat|syntax error|incomplete|placeholder|empty|unmatched|too small|did not pass validation/.test(s)) return false;
        return /references\s+#[\w-]+.*does not define that id/.test(s)
          || /toggles\s+\.[\w-]+.*define that class/.test(s)
          || /but (?:neither|the)\b.*\bdefine/.test(s);
      };
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
          decision._deterministic = true;
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
          const decisionPrompt = await deps.buildAgentDecisionPrompt(chatId, taskText, toolEvents, step, planSpec);
          agentPrompt = decisionPrompt && decisionPrompt.prompt ? decisionPrompt.prompt : decisionPrompt;
          const decisionSystemPrompt = (decisionPrompt && decisionPrompt.systemPrompt) || '';
          // A single transient inference failure (e.g. "API unavailable — check
          // your connection") used to kill the whole run. Retry a couple of times
          // with short backoff so a momentary network/provider blip is survived.
          // We do NOT retry timeouts (the model was simply too slow — retrying
          // burns another full timeout) or user cancellations.
          let res = null;
          const maxInferenceRetries = 2;
          for (let attempt = 0; attempt <= maxInferenceRetries; attempt += 1) {
            // Capture + swallow so an inference abandoned by the timeout (and later
            // aborted) cannot surface as an unhandledRejection.
            const inferPromise = deps.requestAgentPlannerInference(agentPrompt, deps.agentDecisionMaxTokens, deps.agentDecisionGrammar, decisionSystemPrompt);
            inferPromise.catch(() => {});
            res = await Promise.race([
              inferPromise,
              new Promise((resolve) => setTimeout(() => resolve({
                ok: false,
                timedOut: true,
                message: 'Agent step timed out.',
              }), deps.agentStepTimeoutMs)),
            ]);
            // On a timeout the decision inference is still running in the background;
            // kill it before retrying or stopping so we don't stack ghost requests.
            if (res && res.timedOut && typeof deps.abortInFlightInference === 'function') {
              deps.abortInFlightInference('decision_timeout');
            }
            if (!deps.isInferenceActive(requestToken)) return true;
            if (res && res.ok) break;
            const retriable = Boolean(res && !res.ok && !res.timedOut);
            if (!retriable || attempt === maxInferenceRetries) break;
            recordDebugTrace('agent_infer_retry', {
              chatId: String(chatId || ''), step: String(step), attempt: String(attempt + 1),
              reason: deps.debugPreview((res && res.message) || 'inference failed', 160),
            }, { chatId: String(chatId || ''), step, attempt: attempt + 1, reason: String((res && res.message) || 'inference failed') });
            setAgentProgress(`Reconnecting (retry ${attempt + 1}/${maxInferenceRetries})...`);
            await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
            if (!deps.isInferenceActive(requestToken)) return true;
          }

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
              agentMeta: { startedAt, completedAt: Date.now(), collapsed: false },
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
            // Primary output was invalid (e.g. partial/path-only JSON like {"path":"/x.css","offset":4000}).
            // Record corrective guidance and let the REPAIR prompt re-ask first. Do NOT coerce a malformed
            // read-intent straight into a destructive edit_file here — that skipped repair entirely and
            // caused edit_file timeouts on large files. The final fallback below still catches it if repair fails.
            const recentInvalidCount = toolEvents.slice(-4).filter((e) => e && e.tool === '_invalid_output').length;
            const rawSnippet = String(rawPlannerOutput || '').slice(0, 200);
            toolEvents.push({
              tool: '_invalid_output',
              ok: false,
              path: '',
              observation: recentInvalidCount >= 1
                ? `Repeated invalid output. You returned partial/path-only JSON again: ${rawSnippet}. You must return {"action":"tool","tool":"<name>","path":"..."} or {"action":"final","message":"..."}. To read more of a file use {"action":"tool","tool":"read_file","path":"...","start_line":N,"end_line":M}. Do not return path-only or partial JSON.`
                : `Invalid output: missing required "action" and "tool" fields. Got: ${rawSnippet}. To read a file return {"action":"tool","tool":"read_file","path":"..."} (add "start_line"/"end_line" to read a specific range). To finish return {"action":"final","message":"..."}.`,
            });
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
          deps.setThinkingStatus('');
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
            agentMeta: { startedAt, completedAt: Date.now(), collapsed: false },
            forceNeedsContinue: true,
          });
          return true;
        }

        decision = repairDecisionBeforeExecution(decision, step);
        decision.path = normalizeDecisionPath(decision.path || '');
        decision.srcPath = normalizeDecisionPath(decision.srcPath || '');
        decision.dstPath = normalizeDecisionPath(decision.dstPath || '');

        if (!decision._deterministic) {
          const isFinal = decision.action === 'final' || String(decision.tool || '').toLowerCase() === 'none';
          const isExplore = ['read_file', 'search_files', 'list_dir'].includes(String(decision.tool || '').toLowerCase());
          // Don't pre-narrate a FINAL message — a rejected finish would otherwise
          // leave a stray conclusion in the feed; an accepted one shows when committed.
          const narration = isFinal ? '' : (decision.thought || decision.message || (isExplore ? '' : synthesizeToolNarration(decision)));
          if (narration) appendAgentNarration(narration);
        } else if (!deterministicBatchNarrated) {
          const batchThought = decision.thought;
          if (batchThought) appendAgentNarration(batchThought);
          deterministicBatchNarrated = true;
        }

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
            offset: Number(decision.offset || 0),
            startLine: Number(decision.start_line || 0),
            endLine: Number(decision.end_line || 0),
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
          if (duplicateTool === 'edit_file') {
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
                  agentMeta: { startedAt, completedAt: Date.now(), collapsed: false },
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
          // Advisory gate (not a veto): on the first finish attempt with planned
          // items still unmet, surface them as a tool observation and let the
          // model decide. We never override its decision or hard-stop on this.
          if (!finalCheck.ok && finalNudges < 1) {
            finalNudges += 1;
            const missingText = finalCheck.missing.join('; ');
            toolEvents.push({
              tool: 'final_check',
              ok: false,
              observation: `You chose to finish, but these planned items still look incomplete: ${missingText}. If they are actually done or genuinely not needed for this request, finish again and it will be accepted. Otherwise take the next concrete step to complete them.`,
            });
            recordDebugTrace('agent_final_advisory', {
              chatId: String(chatId || ''),
              step: String(step),
              missing: deps.debugPreview(missingText, 260),
            }, {
              chatId: String(chatId || ''),
              step,
              missing: finalCheck.missing,
              toolEvents,
            });
            setAgentProgress('Reviewing...');
            continue;
          }
          // Honor the model's final decision: requirements met, or it reaffirmed
          // finishing after the single advisory nudge.
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
            honoredAfterAdvisory: String(!finalCheck.ok),
          }, {
            chatId: String(chatId || ''),
            step,
            finalText,
            toolEvents,
            honoredAfterAdvisory: !finalCheck.ok,
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

        // Read-loop guard (see evaluateRepeatedRead).
        if (decision.action === 'tool' && String(decision.tool || '').toLowerCase() === 'read_file') {
          const readPath = deps.normalizeWorkspacePath(decision.path || '');
          const currentSig = `${Number(decision.start_line) || 0}:${Number(decision.end_line) || 0}:${Number(decision.offset) || 0}`;
          const blockReason = readPath ? evaluateRepeatedRead(toolEvents, readPath, currentSig) : null;
          if (blockReason) {
            recordDebugTrace('agent_read_loop_blocked', {
              chatId: String(chatId || ''), step: String(step), path: readPath, reason: blockReason,
            }, { chatId: String(chatId || ''), step, path: readPath, reason: blockReason });
            toolEvents.push({
              tool: 'read_file',
              ok: false,
              path: readPath,
              observation: `You have already read the relevant parts of ${readPath} (${blockReason}) — stop re-reading; you have enough context. To find a specific selector/class/id/function, use ONE search_files query on ${readPath}. Otherwise MAKE THE EDIT now (edit_file) or finalize. Do NOT call read_file on ${readPath} again.`,
            });
            continue;
          }
        }

        // Inspection-budget guard: too many reads/searches with no edit -> steer to act.
        if (decision.action === 'tool'
          && (String(decision.tool || '').toLowerCase() === 'read_file'
            || String(decision.tool || '').toLowerCase() === 'search_files')) {
          const inspections = countInspectionsSinceMutation(toolEvents);
          if (inspections >= 8) {
            recordDebugTrace('agent_inspection_budget_blocked', {
              chatId: String(chatId || ''), step: String(step), tool: String(decision.tool || ''), inspections: String(inspections),
            }, { chatId: String(chatId || ''), step, tool: String(decision.tool || ''), inspections });
            const cl = refreshChecklist();
            const nextItem = cl && cl.remaining && cl.remaining.length ? cl.remaining[0] : '';
            const checklistSteer = cl && cl.allDone
              ? ' All planned items appear addressed — finalize now.'
              : (nextItem ? ` Next planned item to handle: "${nextItem}".` : '');
            toolEvents.push({
              tool: String(decision.tool || ''),
              ok: false,
              path: deps.normalizeWorkspacePath(decision.path || ''),
              observation: `You have inspected the workspace ${inspections} times without making a single change — you already have enough context. STOP inspecting: no more read_file or search_files. Make the change now with edit_file using the lines you have already located, or finalize if the task is done. Anchors do NOT need to be byte-exact — close matches (whitespace/indent differences) are accepted, so edit from what you have.${checklistSteer}`,
            });
            continue;
          }
        }

        // Oscillation guard: file cycled back to a prior state -> block re-edit, finalize.
        if (decision.action === 'tool'
          && ['write_file', 'edit_file'].includes(String(decision.tool || '').toLowerCase())) {
          const editPath = deps.normalizeWorkspacePath(decision.path || '');
          if (editPath && oscillatingEditPaths.has(editPath)) {
            recordDebugTrace('agent_edit_oscillation_blocked', {
              chatId: String(chatId || ''), step: String(step), path: editPath,
            }, { chatId: String(chatId || ''), step, path: editPath });
            toolEvents.push({
              tool: String(decision.tool || ''),
              ok: false,
              path: editPath,
              observation: `Stop editing ${editPath}: your edits have cycled it back to a state it was already in this run — you are going in circles, removing the same code you just added. It is correct as-is. Do NOT edit ${editPath} again. Finalize now (or move to a different file if one genuinely still needs changes).`,
            });
            continue;
          }
        }

        const targetInfo = deps.describeAgentToolTarget(decision);
        const startLabel = decision.tool === 'write_file' && deps.isLikelyNewAgentFileTarget(toolEvents, targetInfo)
          ? (targetInfo ? `Creating file ${targetInfo}` : 'Creating file')
          : deps.describeAgentToolPhase(decision.tool, targetInfo, 'start');
        setAgentProgress(`${startLabel}...`);
        appendAgentActivity(deps.buildAgentPendingActivity(decision, toolEvents));
        // Tool execution can itself make a (slow) inference call to generate file
        // content. Only the decision step was timeout-bounded, so a stalled
        // write/edit generation used to hang the whole loop forever — the deadline
        // check only runs at the top of a step, which is never reached while a tool
        // is stuck. Race the tool against a generous timeout so a stall surfaces as
        // a normal failure (which the circuit breaker then handles) instead of a
        // frozen "Repairing..." UI.
        const toolTimeoutMs = Number(deps.agentToolTimeoutMs) || 150000;
        // Idle watchdog (not flat wall-clock): generation heartbeats each pass; abandon
        // only on no progress for idleLimitMs, with an absolute ceiling.
        const idleLimitMs = Number(deps.agentToolIdleTimeoutMs) || toolTimeoutMs;
        const hardCapMs = Math.max(
          idleLimitMs,
          Math.min(Number(deps.agentToolHardCapMs) || (toolTimeoutMs * 3), Math.max(60000, deadlineAt - Date.now() - 5000)),
        );
        let toolResult;
        try {
          if (typeof deps.markAgentToolProgress === 'function') deps.markAgentToolProgress();
          // Capture + swallow so a late abort of an abandoned tool can't throw unhandled.
          const toolPromise = deps.executeDeveloperToolCall(chatId, decision, taskText, toolEvents, planSpec, {
            approvedNewProject: Boolean(requestToken && requestToken.approvedNewProject),
            skipNewProjectConfirmation: Boolean(requestToken && requestToken.skipNewProjectConfirmation),
            forceCurrentWorkspace: Boolean(requestToken && requestToken.forceCurrentWorkspace),
          });
          toolPromise.catch(() => {});
          let toolSettled = false;
          toolPromise.then(() => { toolSettled = true; }, () => { toolSettled = true; });
          const toolStartedAt = Date.now();
          const watchdog = new Promise((resolve) => {
            const iv = setInterval(() => {
              if (toolSettled) { clearInterval(iv); resolve(null); return; }
              const lastProgress = typeof deps.getLastAgentToolProgressAt === 'function'
                ? Number(deps.getLastAgentToolProgressAt()) || toolStartedAt
                : toolStartedAt;
              const idleMs = Date.now() - lastProgress;
              const totalMs = Date.now() - toolStartedAt;
              if (idleMs >= idleLimitMs || totalMs >= hardCapMs) {
                clearInterval(iv);
                const why = totalMs >= hardCapMs ? `ran past ${Math.round(hardCapMs / 1000)}s` : `made no progress for ${Math.round(idleMs / 1000)}s`;
                resolve({
                  ok: false,
                  _toolTimedOut: true,
                  observation: `${decision.tool} for ${deps.normalizeWorkspacePath(decision.path || decision.srcPath || '/')} ${why} and was abandoned.`,
                });
              }
            }, 4000);
          });
          toolResult = await Promise.race([toolPromise, watchdog]);
        } catch (toolErr) {
          recordDebugTrace('agent_tool_exception', {
            chatId: String(chatId || ''),
            step: String(step),
            tool: String(decision.tool || ''),
            path: deps.normalizeWorkspacePath(decision.path || ''),
            message: String(toolErr && toolErr.message ? toolErr.message : toolErr),
            stack: typeof deps.debugPreview === 'function' ? deps.debugPreview(String(toolErr && toolErr.stack ? toolErr.stack : ''), 600) : '',
          }, {
            chatId: String(chatId || ''),
            step,
            tool: String(decision.tool || ''),
            error: String(toolErr && toolErr.stack ? toolErr.stack : (toolErr && toolErr.message ? toolErr.message : toolErr)),
          });
          toolResult = {
            ok: false,
            observation: `${decision.tool} failed with an error: ${String(toolErr && toolErr.message ? toolErr.message : toolErr)}`,
          };
        }
        if (toolResult && toolResult.requiresDeleteConfirmation) {
          // Human-in-the-loop approval for a destructive op. Surface what's being
          // deleted and only trash it if the user explicitly confirms.
          setAgentProgress('Waiting for confirmation...');
          const delPath = deps.normalizeWorkspacePath(toolResult.deletePath || decision.path || '');
          recordDebugTrace('agent_delete_confirm_prompt', {
            chatId: String(chatId || ''), step: String(step), path: delPath,
          }, { chatId: String(chatId || ''), step, path: delPath });
          let delChoice = null;
          if (typeof deps.requestProjectScopeConfirmation === 'function') {
            delChoice = await deps.requestProjectScopeConfirmation(chatId, {
              kind: 'delete',
              deletePath: delPath,
              userMessage: String(toolResult.userFacingMessage || `Delete ${delPath}?`),
            });
          }
          recordDebugTrace('agent_delete_confirm_choice', {
            chatId: String(chatId || ''), step: String(step), choice: String(delChoice || 'null'),
          }, { chatId: String(chatId || ''), step, choice: String(delChoice || '') });
          if (delChoice === 'confirm_delete') {
            const trashRes = await deps.invokeWorkspaceAction('workspaceTrash', { path: delPath });
            if (trashRes && trashRes.ok) {
              toolResult = { ok: true, mutated: true, observation: `delete ok: moved ${delPath} to Trash after user confirmation.` };
              await deps.refreshWorkspaceTree(true);
            } else {
              toolResult = { ok: false, mutated: false, observation: `delete failed for ${delPath}: ${(trashRes && trashRes.message) || 'unknown error'}` };
            }
          } else {
            toolResult = { ok: false, mutated: false, observation: `User declined to delete ${delPath}. Do NOT retry the delete; continue with other steps or finalize.` };
          }
        }
        if (toolResult && (toolResult.requiresUserInput || toolResult.requiresProjectScopeConfirmation)) {
          setAgentProgress('Waiting for confirmation...');
          // Only consume/remove live text for generic input requests.
          // For project scope confirmation, leave the activity stream visible so the user
          // can see what the agent was doing before the confirmation prompt appeared.
          if (!toolResult.requiresProjectScopeConfirmation) {
            deps.consumeLiveAssistantText();
          }
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          let userChoice = null;
          if (toolResult.requiresProjectScopeConfirmation && typeof deps.requestProjectScopeConfirmation === 'function') {
            recordDebugTrace('agent_project_scope_prompt_shown', {
              chatId: String(chatId || ''),
              step: String(step),
              tool: String(decision.tool || ''),
              workspaceOpen: String(Boolean(toolResult.workspaceOpen)),
            }, {
              chatId: String(chatId || ''),
              step,
              taskText: String(taskText || ''),
              userFacingMessage: String(toolResult.userFacingMessage || ''),
            });
            userChoice = await deps.requestProjectScopeConfirmation(chatId, {
              kind: 'project_scope',
              originalTask: String(taskText || ''),
              userMessage: String(toolResult.userFacingMessage || ''),
              workspaceOpen: toolResult.workspaceOpen === false ? false : Boolean(toolResult.workspaceOpen),
            });
            recordDebugTrace('agent_project_scope_choice_received', {
              chatId: String(chatId || ''),
              step: String(step),
              userChoice: String(userChoice || 'null'),
            }, {
              chatId: String(chatId || ''),
              step,
              userChoice: String(userChoice || ''),
            });
            if (userChoice === 'create_new_project') {
              const derivedName = planSpec && planSpec.projectName
                ? String(planSpec.projectName).trim()
                : String(typeof deps.deriveProjectNameFromTask === 'function' ? deps.deriveProjectNameFromTask(taskText) : '').trim();
              recordDebugTrace('agent_new_project_close_workspace', {
                chatId: String(chatId || ''),
                step: String(step),
                derivedName,
              }, { chatId: String(chatId || ''), derivedName, taskText: String(taskText || '') });
              // Close the old workspace first — native bridge requires this before creating a new project.
              const closeRes = await deps.invokeWorkspaceAction('workspaceCloseRoot', {});
              recordDebugTrace('agent_new_project_close_result', {
                chatId: String(chatId || ''),
                ok: String(Boolean(closeRes && closeRes.ok)),
                message: String(closeRes && closeRes.message ? closeRes.message : ''),
              }, { chatId: String(chatId || ''), closeRes });
              if (closeRes && !closeRes.ok) {
                toolResult.ok = false;
                toolResult.mutated = false;
                toolResult.observation = 'Could not close current workspace before creating new project: ' + String(closeRes.message || 'unknown error');
              } else {
                const response = await deps.invokeWorkspaceAction('workspaceNewProject', derivedName ? { name: derivedName } : {});
                recordDebugTrace('agent_new_project_create_result', {
                  chatId: String(chatId || ''),
                  ok: String(Boolean(response && response.ok)),
                  derivedName,
                  message: String(response && response.message ? response.message : ''),
                }, { chatId: String(chatId || ''), response, derivedName });
                if (response && response.ok) {
                  if (typeof deps.resetWorkspaceForNewProject === 'function') {
                    deps.resetWorkspaceForNewProject();
                  }
                  // Sync workspace tree in the background — don't block agent continuation.
                  void deps.syncWorkspaceStateFromNative('new_project_confirmed', { render: true, log: true });
                  toolResult.ok = true;
                  toolResult.mutated = true;
                  toolResult.observation = `User confirmed creating a new project via UI. Workspace reset to ${derivedName || 'new project'}.`;
                } else {
                  toolResult.ok = false;
                  toolResult.mutated = false;
                  toolResult.observation = 'User confirmed creating a new project via UI, but creation failed: ' + String(response && response.message ? response.message : 'unknown error');
                }
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
          // Update the status in place so the narration the user already saw stays
          // visible. Do NOT consume/remove the live row here — that wipes the prior
          // activities (the "cut off" content) and starts a blank stream.
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
          // Read range — for the range-aware read-loop guard.
          startLine: Number(decision.start_line) || 0,
          endLine: Number(decision.end_line) || 0,
          offset: Number(decision.offset) || 0,
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
          offset: Number(decision.offset || 0),
          startLine: Number(decision.start_line || 0),
          endLine: Number(decision.end_line || 0),
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
        // Flag a path whose content returned to a prior state (oscillation).
        if (toolResult && toolResult.ok && toolResult.mutated
          && ['write_file', 'edit_file'].includes(String(decision.tool || '').toLowerCase())
          && typeof toolResult.writtenContent === 'string') {
          const mutatedPath = deps.normalizeWorkspacePath((toolResult.writtenPath || decision.path) || '');
          if (mutatedPath) {
            const stateHash = hashFileState(toolResult.writtenContent);
            const seen = fileStateHistory.get(mutatedPath) || new Set();
            if (seen.has(stateHash) && seen.size > 0) {
              oscillatingEditPaths.add(mutatedPath);
              recordDebugTrace('agent_edit_oscillation_detected', {
                chatId: String(chatId || ''), step: String(step), path: mutatedPath,
              }, { chatId: String(chatId || ''), step, path: mutatedPath });
            }
            seen.add(stateHash);
            fileStateHistory.set(mutatedPath, seen);
          }
        }
        // After real progress (an edit landed or validation ran), re-check the
        // checklist: re-render it if an item just flipped to done, and surface the
        // count so the user sees the agent working through the plan item by item.
        if (toolResult && toolResult.ok
          && (toolResult.mutated || String(decision.tool || '').toLowerCase() === 'validate_files')) {
          const cl = refreshChecklist();
          if (cl && cl.total) {
            setAgentProgress(cl.allDone
              ? `All ${cl.total} planned items addressed — finalizing...`
              : `Progress ${cl.doneCount}/${cl.total} — continuing...`);
          }
        }
        // A tool that hit the execution timeout will NOT recover on retry — the local
        // model is simply too slow for this operation. Abandon immediately with a clean
        // message instead of burning multiple 150s timeouts (that was the 11-minute hang).
        if (toolResult && toolResult._toolTimedOut) {
          // Kill the abandoned background inference (no ghost work after "Stopped").
          if (typeof deps.abortInFlightInference === 'function') {
            deps.abortInFlightInference('tool_timeout');
          }
          const timedOutPath = deps.normalizeWorkspacePath(decision.path || decision.srcPath || '/');
          const keptList = [...new Set(toolEvents
            .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
            .map((event) => deps.normalizeWorkspacePath(event.path || ''))
            .filter(Boolean))];
          const keptSummary = keptList.length ? ` I kept the files that are already done: ${keptList.slice(0, 6).join(', ')}.` : '';
          const stoppedText = `${decision.tool} for ${timedOutPath} took too long, so I stopped instead of retrying for several minutes.${keptSummary} Tell me the exact change you want for ${timedOutPath} and I'll continue from here.`;
          appendAgentActivity({
            kind: 'error',
            title: 'Stopped (timed out)',
            detail: `${decision.tool} for ${timedOutPath} exceeded the time limit`,
            status: 'error',
            openPath: timedOutPath.startsWith('/') ? timedOutPath : '',
            openKind: 'file',
          });
          setAgentProgress('Stopped.');
          deps.consumeLiveAssistantText();
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.commitAssistantMessage(chatId, stoppedText, stoppedText, {
            agentActivities,
            agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
            forceNeedsContinue: true,
          });
          recordDebugTrace('agent_stopped_after_tool_timeout', {
            chatId: String(chatId || ''),
            step: String(step),
            tool: String(decision.tool || ''),
            path: timedOutPath,
          }, {
            chatId: String(chatId || ''),
            step,
            tool: String(decision.tool || ''),
            path: timedOutPath,
            toolEvents,
          });
          return true;
        }
        // Bounded self-correction: when the same file keeps failing the same way,
        // narrate the retry in real time, and after a few identical failures stop
        // cleanly instead of looping until the step/token budget is exhausted. The
        // streak is keyed on path + normalized issue, so a productive fix (different
        // issue, or validation passing) naturally resets it.
        {
          const failTool = String(decision.tool || '').toLowerCase();
          const failSig = deriveAgentFailureSignature(decision, toolResult, deps.normalizeWorkspacePath);
          if (failSig) {
            const { streakPath, shortReason, rawIssue, streakKey } = failSig;
            if (streakKey === failureStreak.key) failureStreak.count += 1;
            else { failureStreak.key = streakKey; failureStreak.count = 1; }

            if (failureStreak.count >= sameFailureLimit) {
              const keptList = [...new Set(toolEvents
                .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
                .map((event) => deps.normalizeWorkspacePath(event.path || ''))
                .filter(Boolean))];
              const keptSummary = keptList.length ? ` I kept the files that are already done: ${keptList.slice(0, 6).join(', ')}.` : '';
              const stoppedText = `I tried ${streakPath} ${failureStreak.count} times and it kept failing the same way (${shortReason}). I'm stopping here instead of looping and using up the run.${keptSummary} Tell me how you want to handle ${streakPath} and I'll pick it back up.`;
              appendAgentActivity({
                kind: 'error',
                title: 'Stopped after retries',
                detail: `${streakPath} failed ${failureStreak.count}× — ${shortReason}`,
                status: 'error',
                openPath: streakPath.startsWith('/') ? streakPath : '',
                openKind: 'file',
              });
              setAgentProgress('Stopped.');
              deps.consumeLiveAssistantText();
              if (agentHasWorkspaceMutations()) {
                await deps.refreshWorkspaceTree(true);
              }
              deps.commitAssistantMessage(chatId, stoppedText, stoppedText, {
                agentActivities,
                agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
                forceNeedsContinue: true,
              });
              recordDebugTrace('agent_stopped_after_repeated_failures', {
                chatId: String(chatId || ''),
                step: String(step),
                path: streakPath,
                count: String(failureStreak.count),
                observationPreview: deps.debugPreview(rawIssue, 300),
              }, {
                chatId: String(chatId || ''),
                step,
                path: streakPath,
                count: failureStreak.count,
                observation: rawIssue,
                toolEvents,
              });
              return true;
            }

            appendAgentActivity({
              kind: 'validate',
              title: 'Retrying',
              detail: `${streakPath} didn't pass: ${shortReason}. Fixing it and trying again (attempt ${failureStreak.count + 1} of ${sameFailureLimit}).`,
              status: 'running',
              openPath: streakPath.startsWith('/') ? streakPath : '',
              openKind: 'file',
            });
          } else if (failTool === 'validate_files' && toolResult.validationPassed === true) {
            failureStreak.key = '';
            failureStreak.count = 0;
          }
        }
        if (decision.tool === 'validate_files' && toolResult.validationPassed === false) {
          validationFailureCount += 1;
          const issues = Array.isArray(toolResult.validationIssues) ? toolResult.validationIssues.filter(Boolean) : [];
          const onlyMinorGaps = issues.length > 0 && issues.every(isMinorCrossFileIssue);
          const expectedProjectFiles = Array.isArray(planSpec && planSpec.expectedFiles)
            ? planSpec.expectedFiles.map((p) => deps.normalizeWorkspacePath(p || '')).filter((p) => p && p !== '/README.md' && p !== '/src')
            : [];
          const writtenSet = new Set(toolEvents
            .filter((e) => e && e.ok && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase()))
            .map((e) => deps.normalizeWorkspacePath(e.path || '')));
          const allExpectedWritten = expectedProjectFiles.length > 0 && expectedProjectFiles.every((p) => writtenSet.has(p));
          // After one repair attempt, ship if only minor cross-file gaps remain.
          if (validationFailureCount >= 2 && onlyMinorGaps && allExpectedWritten) {
            setAgentProgress('Finalizing...');
            const workspaceLabel = deps.getWorkspaceRootName() || deps.deriveProjectNameFromTask(taskText) || 'project';
            const baseText = String(await deps.generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec) || '').trim();
            // Short summary only — gap details are in the steps above.
            const gapCount = issues.length;
            const gapNote = `\n\nIt runs, but ${gapCount} cross-file reference${gapCount === 1 ? '' : 's'} still need wiring (details in the steps above). Press Continue and I'll finish them.`;
            const finalText = `${baseText}${gapNote}`;
            if (agentHasWorkspaceMutations()) await deps.refreshWorkspaceTree(true);
            deps.consumeLiveAssistantText();
            deps.commitAssistantMessage(chatId, finalText, finalText, {
              agentActivities,
              agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
              // Was false — so "continue" fell through to chat (which just
              // re-summarized). True puts the chat in resume state so a bare
              // "continue" re-enters the agent and wires up the gaps.
              forceNeedsContinue: true,
            });
            recordDebugTrace('agent_shipped_with_minor_gaps', {
              chatId: String(chatId || ''),
              step: String(step),
              gaps: String(issues.length),
            }, { chatId: String(chatId || ''), step, issues, toolEvents });
            return true;
          }
          const summary = issues.length
            ? issues.slice(0, 3).join('; ')
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
              forceNeedsContinue: true,
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
        if (!toolResult.ok) {
          setAgentProgress('Adjusting...');
        } else if (decision.tool === 'validate_files' && String(toolResult.observation || '').includes('found issues')) {
          setAgentProgress('Repairing...');
        }

        if (toolResult.mutated) {
          await deps.refreshWorkspaceTree(true);
          deps.scheduleWorkspaceExplorerBackgroundRefresh(220);
        }
      }

      const fallbackChanged = [...new Set(toolEvents
        .filter((e) => e && e.ok && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase()))
        .map((e) => deps.normalizeWorkspacePath(e.path || ''))
        .filter(Boolean))];
      // Report checklist progress (done/left) and enable Continue.
      const cl = refreshChecklist();
      const changedClause = fallbackChanged.length
        ? ` Changed: ${fallbackChanged.slice(0, 6).join(', ')}.`
        : '';
      const remainingClause = cl && cl.remaining && cl.remaining.length
        ? ` Still to do: ${cl.remaining.join('; ')}.`
        : '';
      let fallback = '';
      if (cl && cl.allDone) {
        // Work is done — let the model write the wrap-up naturally rather than a template.
        const workspaceLabel = deps.getWorkspaceRootName() || deps.deriveProjectNameFromTask(taskText) || 'project';
        fallback = String(await deps.generateAgentCompletionText(taskText, toolEvents, workspaceLabel, planSpec) || '').trim();
      }
      if (!fallback) {
        if (cl && cl.total && !cl.allDone) {
          fallback = `I ran out of steps with ${cl.doneCount} of ${cl.total} planned items done.${changedClause}${remainingClause} Press Continue to finish the rest, or leave it here.`;
        } else if (cl && cl.allDone) {
          fallback = `Done — I made the planned changes.${changedClause}`;
        } else if (fallbackChanged.length) {
          fallback = `I ran out of steps before fully wrapping up.${changedClause} Press Continue to keep going, or tell me what to adjust.`;
        } else {
          fallback = 'I could not finish in time. Press Continue to keep going, or tell me the exact change you want.';
        }
      }
      deps.setThinkingStatus('');
      setAgentProgress('Stopped.');
      deps.consumeLiveAssistantText();
      if (agentHasWorkspaceMutations()) {
        await deps.refreshWorkspaceTree(true);
      }
      deps.commitAssistantMessage(chatId, fallback, fallback, {
        agentActivities,
        agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
        forceNeedsContinue: !(cl && cl.allDone),
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
      } catch (err) {
        // Capture the actual exception so a leaked throw (e.g. in the edit/repair
        // path that triggered the orphaned-stream finalizer) is diagnosable instead
        // of swallowed. Re-thrown so the outer handler's state reset is unchanged.
        recordDebugTrace('agent_run_exception', {
          chatId: String(chatId || ''),
          message: String(err && err.message ? err.message : err),
          stack: typeof deps.debugPreview === 'function' ? deps.debugPreview(String(err && err.stack ? err.stack : ''), 600) : '',
        }, {
          chatId: String(chatId || ''),
          error: String(err && err.stack ? err.stack : (err && err.message ? err.message : err)),
          toolEvents,
        });
        throw err;
      } finally {
        // If we reach here with the live assistant stream still connected, no exit
        // path committed it — finalize so the loader can't get stuck and the work so
        // far is persisted (the workspace files already are). Best-effort: this must
        // never throw or alter the function's return value.
        try {
          if (typeof deps.hasLiveAssistantRow === 'function' && deps.hasLiveAssistantRow()) {
            if (typeof deps.setThinkingStatus === 'function') deps.setThinkingStatus('');
            if (typeof deps.consumeLiveAssistantText === 'function') deps.consumeLiveAssistantText();
            const stoppedText = 'The agent stopped before finishing. The files generated so far are saved in the workspace — say "continue" and I will pick up from the current state.';
            deps.commitAssistantMessage(chatId, stoppedText, stoppedText, {
              agentActivities,
              agentMeta: { startedAt, completedAt: Date.now(), collapsed: true },
              forceNeedsContinue: true,
            });
            recordDebugTrace('agent_finalized_orphaned_stream', {
              chatId: String(chatId || ''),
              activities: String(agentActivities.length),
            }, {
              chatId: String(chatId || ''),
              toolEvents,
            });
          }
        } catch (_) { /* best-effort finalize; never mask the original outcome */ }
      }
    }

    return {
      requestDeveloperAgentReply,
    };
  }

  global.AIExeAgentLoop = {
    createAgentLoop,
    deriveAgentFailureSignature,
    countInspectionsSinceMutation,
    evaluateRepeatedRead,
  };
})(window);
