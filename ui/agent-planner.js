(function initAIExeAgentPlanner(global) {
  function createAgentPlanner(deps) {
    const normalizeWorkspacePath = deps.normalizeWorkspacePath;
    const getWorkspaceFileTreeSummary = deps.getWorkspaceFileTreeSummary;
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
    const getAgentEnvironmentContext = typeof deps.getAgentEnvironmentContext === 'function'
      ? deps.getAgentEnvironmentContext
      : () => [
        'AGENT_ENVIRONMENT:',
        '- Selected inference provider: local model (offline/local runtime).',
        '- Prefer self-contained local projects that run without hosted services. If a requested framework/build step is unavailable locally, plan the closest static/local equivalent and say so honestly.',
      ].join('\n');
    const deriveProjectNameFromTask = deps.deriveProjectNameFromTask;
    const agentMaxSteps = Number(deps.agentMaxSteps) || 16;
    const agentMaxToolOutputChars = Number(deps.agentMaxToolOutputChars) || 8000;
    const getAgentExpandedReadChars = typeof deps.getAgentExpandedReadChars === 'function'
      ? deps.getAgentExpandedReadChars
      : () => 0;
    const agentDecisionMaxTokens = Number(deps.agentDecisionMaxTokens) || 120;
    const agentPlanGrammar = String(deps.agentPlanGrammar || '');
    // Read per call, not snapshot at boot — the budget is provider-dependent (the Venice
    // adapter needs minutes; a snapshot froze the wrong value and the plan step timed out,
    // silently downgrading runs to the fallback plan: wrong name, 2 files, no phases).
    const agentStepTimeoutMs = () => Number(deps.agentStepTimeoutMs) || 20000;

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
        if (/(?:^|\/)(?:package|tsconfig(?:\.[^/]*)?|components)\.json$/i.test(normalized)
          || /(?:^|\/)(?:next|vite|tailwind|postcss)\.config\.[cm]?[jt]s$/i.test(normalized)) continue;
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

      // An edit that matched but changed nothing means the file already contains the
      // intended content — that file needs no further work and must not keep blocking
      // finalize (the "update /index.html" false-incomplete loop).
      const hasNoOpEditAttempt = (targetPath) => (toolEvents || []).some((event) => event
        && String(event.tool || '').toLowerCase() === 'edit_file'
        && event.ok === false
        && normalizeWorkspacePath(event.path || '') === targetPath
        && /already contains that exact text/i.test(String(event.observation || '')));
      // "Check/verify X and fix IF broken" that found nothing broken is complete:
      // a zero-mutation run with a clean validate pass must not keep demanding
      // "update /x" (that forces the model to argue with the harness or invent
      // no-op edits). Scoped to verification-worded tasks so a plain edit request
      // can't lazily "verify" its way past the gate.
      const verificationConditionalTask = /\b(?:are\s+you\s+sure|confirm|verify|check\s+(?:if|whether|that)|make\s+sure|analy[sz]e|review|audit)\b/i.test(text);
      const anyWorkspaceMutation = hasSuccessfulAgentTool(toolEvents, (event) => (
        ['write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(event.tool || '').toLowerCase())
      ));
      const cleanValidatePassed = hasSuccessfulAgentTool(toolEvents, (event) => (
        String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true
      ));
      const verifiedNoDefects = verificationConditionalTask && !anyWorkspaceMutation && cleanValidatePassed;
      // Work done in earlier runs of this task (Continue/crash recovery) counts.
      const priorDone = plan && plan._priorRunDone && typeof plan._priorRunDone === 'object' ? plan._priorRunDone : null;
      const priorMutated = (p) => Boolean(priorDone && priorDone.mutated && priorDone.mutated.has(p));
      const priorRead = (p) => Boolean(priorDone && ((priorDone.read && priorDone.read.has(p)) || priorMutated(p)));
      const priorValidatePassed = Boolean(priorDone && priorDone.validatePassed === true);
      const activePhaseTaskText = plan._activePhase && Array.isArray(plan._activePhase.tasks)
        ? plan._activePhase.tasks.join(' ') : '';
      const readmeInCurrentScope = !plan._activePhase || /(?:^|[\s/])readme\.md\b/i.test(activePhaseTaskText);
      const affectedFileSatisfied = (targetPath) => hasSuccessfulAgentTool(
        toolEvents,
        (event) => ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
          && normalizeWorkspacePath(event.path || '') === targetPath
          && !String(event.structuralIssue || '').trim(),
      ) || priorMutated(targetPath) || hasNoOpEditAttempt(targetPath) || verifiedNoDefects;

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

      if (isSoftwareProject && plan.needsReadme && readmeInCurrentScope) {
        requirements.push({
          id: 'readme_file',
          label: 'write /README.md',
          met: Boolean(readmeWrite && String(readmeWrite.content || '').trim().length >= 80),
        });
      }

      // Only when a README is actually planned — without one, run instructions are
      // delivered in the final message (never demand a file the plan didn't include).
      if (isSoftwareProject && plan.needsReadme && plan.needsRunInstructions && readmeInCurrentScope) {
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

      if (plan.finalRequiresRealFiles && !plan._activePhase) {
        requirements.push({
          id: 'main_source_file',
          label: 'create the main implementation file',
          met: Boolean(primarySourceWrite && String(primarySourceWrite.content || '').trim()),
        });
      }

      if (plan.finalRequiresRealFiles && primarySourceWrite && !plan._activePhase) {
        const primaryPath = normalizeWorkspacePath(primarySourceWrite.path || '');
        requirements.push({
          id: 'main_source_complete',
          label: isGameTask
            ? `make ${primaryPath || 'the main implementation file'} complete and runnable`
            : `make ${primaryPath || 'the main implementation file'} non-placeholder and usable`,
          met: isLikelyCompletePrimarySource(primarySourceWrite.path || '', primarySourceWrite.content || '', lower),
        });
      }

      // Phased run: pending "write X" must track THIS phase's files. Slicing the head
      // of the whole-project list pins phase-1's config files as forever-"unmet" noise
      // in every later phase (they were written in an earlier run, not this one).
      const activePhasePaths = [];
      if (plan._activePhase && Array.isArray(plan._activePhase.tasks)) {
        plan._activePhase.tasks.forEach((task) => {
          // Normalized phase tasks commonly store `tailwind.config.ts` or
          // `app/page.tsx` without a leading slash. Accept both forms; requiring
          // `/` silently dropped root config tasks from the phase contract.
          (String(task || '').match(/(?:^|\s)(?:\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]+(?=$|[\s,;])/g) || []).forEach((raw) => {
            const p = normalizeWorkspacePath(String(raw).replace(/[.,;:]+$/, ''));
            if (p && /\.[A-Za-z0-9]+$/.test(p) && !activePhasePaths.includes(p)) activePhasePaths.push(p);
          });
        });
      }
      (activePhasePaths.length ? activePhasePaths : plan.expectedFiles)
        .filter((path) => isSoftwareProject && !isDocsTask && path && path !== '/README.md' && path !== '/src')
        .slice(0, activePhasePaths.length ? 8 : 6)
        .forEach((path) => {
          const isWriteDeliverable = plan.taskKind !== 'edit';
          requirements.push({
            id: `expected_${path}`,
            label: `${isWriteDeliverable ? 'write' : 'update'} ${path}`,
            // A "write X" deliverable that already exists on disk (built by an
            // earlier phase/run) is done — demanding a write here pressures the
            // model toward a forbidden overwrite and burns steps proving it.
            met: affectedFileSatisfied(path)
              || (isWriteDeliverable && typeof deps.workspaceTreeHasFile === 'function' && deps.workspaceTreeHasFile(path)),
          });
        });

      if (!isSoftwareProject) {
        plannedInspectFiles.slice(0, 8).forEach((path) => {
          requirements.push({
            id: `inspect_${path}`,
            label: `inspect ${path}`,
            met: priorRead(path)
              || hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'read_file' && normalizeWorkspacePath(event.path || '') === path),
          });
        });

        plannedAffectedFiles.slice(0, 8).forEach((path) => {
          requirements.push({
            id: `affected_${path}`,
            label: `update ${path}`,
            met: affectedFileSatisfied(path),
          });
        });
      }

      const expectedNonReadmeFiles = (activePhasePaths.length ? activePhasePaths : plan.expectedFiles)
        .filter((path) => !isDocsTask && path && path !== '/README.md' && path !== '/src');
      const allExpectedFilesWritten = expectedNonReadmeFiles.length > 0
        && expectedNonReadmeFiles.every((path) => affectedFileSatisfied(path));
      const validateRequested = validationSteps.some((step) => /validate_files|static|syntax|check|test|verify/.test(step));
      const plannedAffectedFilesUpdated = plannedAffectedFiles.length > 0
        && plannedAffectedFiles.every((path) => affectedFileSatisfied(path));
      if ((isSoftwareProject && allExpectedFilesWritten) || (!isSoftwareProject && validateRequested && plannedAffectedFilesUpdated)) {
        requirements.push({
          id: 'validate_written_files',
          label: isSoftwareProject ? 'validate the written project files' : 'validate the updated files',
          met: priorValidatePassed
            || hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true),
        });
      }

      // Code mutations always require one passing validate before finishing —
      // a "fixed" file that still fails to parse must block, not ship.
      const codeMutated = hasSuccessfulAgentTool(toolEvents, (event) => (
        ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
        && /\.(?:js|mjs|cjs|ts|tsx|jsx|html?|css|json)$/i.test(normalizeWorkspacePath(event.path || ''))
      ));
      if (codeMutated && !requirements.some((item) => /^validate/.test(String(item.id || '')))) {
        requirements.push({
          id: 'validate_code_mutations',
          label: 'validate the changed code files',
          met: priorValidatePassed
            || hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true),
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
            met: priorValidatePassed
              || hasSuccessfulAgentTool(toolEvents, (event) => String(event.tool || '').toLowerCase() === 'validate_files' && event.validationPassed === true),
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

    function buildImmediateNextAction(taskText, toolEvents = [], planSpec = null, stepIndex = 0) {
      const missing = buildAgentTaskRequirements(taskText, toolEvents, planSpec).filter((item) => !item.met);
      const remainingSteps = Math.max(0, agentMaxSteps - Math.max(0, Number(stepIndex) || 0));
      if (!missing.length) {
        return `Execution budget: ${remainingSteps} tool step${remainingSteps === 1 ? '' : 's'} remain. NOW: return the final result; do not invent optional work.`;
      }
      const label = String(missing[0].label || 'finish the next pending requirement').trim();
      let action = label;
      if (/^write\s+\//i.test(label)) action = label.replace(/^write\s+/i, 'create ');
      else if (/^make\s+\//i.test(label)) action = label.replace(/^make\s+/i, 'repair ');
      return `Execution budget: ${remainingSteps} tool step${remainingSteps === 1 ? '' : 's'} remain. NOW: ${action}. Take exactly one grounded tool action for this requirement; do not polish earlier completed files.`;
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
          IMMEDIATE_NEXT_ACTION: buildImmediateNextAction(taskText, toolEvents, planSpec, stepIndex),
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
        'IMMEDIATE NEXT ACTION:',
        buildImmediateNextAction(taskText, toolEvents, planSpec, stepIndex),
        'JSON:',
      ].join('\n');
    }

    function sanitizeAgentGeneratedFileContent(outputText, path = '') {
      let text = String(outputText || '').replace(/\r/g, '').trim();
      if (!text) return '';
      // A whole tool-call envelope as file content ({"action":"tool","tool":
      // "write_file",...,"content":"..."}) corrupted a real tailwind.config.js —
      // unwrap to the inner content when the envelope parses cleanly.
      if (text.startsWith('{') && text.includes('"content"') && /"(?:action|tool)"\s*:/.test(text.slice(0, 200))) {
        try {
          const envelope = JSON.parse(text);
          if (envelope && typeof envelope === 'object'
            && typeof envelope.content === 'string' && envelope.content.trim()
            && (envelope.action || envelope.tool)) {
            text = envelope.content.replace(/\r/g, '').trim();
          }
        } catch (_) { }
      }
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

      // 1) Fence unwrap, WRAPPER-FIRST: reply starting with ``` gets head/tail
      //    peeled only — interior ``` is real code (pair-scan amputated files).
      if (/^```/.test(text)) {
        text = text.replace(/^```[a-z0-9_+\-]*[^\S\n]*\n?/i, '');
        text = text.replace(/\n?```\s*$/, '').trim();
      } else {
        // Prose-wrapped reply: extract the matching-language block.
        const fencedBlocks = [];
        for (const match of text.matchAll(/```([a-z0-9_+\-]*)\s*([\s\S]*?)```/gi)) {
          const language = String(match[1] || '').trim().toLowerCase();
          const body = String(match[2] || '').trim();
          if (body) fencedBlocks.push({ language, body });
        }
        if (fencedBlocks.length) {
          const matched = fencedBlocks.find((b) => wantedLanguages.includes(b.language))
            || fencedBlocks.find((b) => !b.language) || fencedBlocks[0];
          if (matched && matched.body) text = matched.body;
        }
      }

      // 2) JSON-escaped blob (literal \n, ~no real newlines) → unescape so it parses.
      if ((text.match(/\\n/g) || []).length >= 3 && (text.match(/\n/g) || []).length <= 2) {
        text = text.replace(/\\([nrt"'\\])/g, (m, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '' : ch === 't' ? '\t' : ch)).trim();
      }

      // 3) Drop WHOLE LINES that are verbatim prompt scaffolding a weak model echoed.
      //    Line-level only — never a delete-to-EOF regex (that cut real code, e.g. a
      //    JSX <Header> read as an <head> tag).
      const isScaffoldLine = (t) =>
        /^(?:FILE_CONTENT|TASK|RULES|MVP_REQUIREMENTS|PROJECT_CONTRACT|PROJECT_STATE|RECENT_TOOL_RESULTS|PREVIOUS_ATTEMPT_TO_IMPROVE|Planned files|Quality contract|Web project contract|Python project contract|Generation budget contract)\s*:/i.test(t)
        || /^Return only the file contents\b/i.test(t)
        || /^File path:\s*\/\S+$/i.test(t)
        || /^(?:Today's date is|Current date)\b/i.test(t)
        || /^-\s+If this is (?:README\.md|a main source file)\b/i.test(t)
        || /^-\s+(?:Build the complete|Reuse shared|Write a usable MVP|Keep the file internally|Prefer (?:a |self-contained)|Return only )\b/i.test(t);
      text = text.split('\n').filter((line) => !isScaffoldLine(line.trim())).join('\n').trim();
      if (/^```/.test(text)) text = text.replace(/^```[a-z0-9_+\-]*\s*/i, '').replace(/\s*```$/, '').trim();

      // 4) A single leading prose lead-in ("Here's the file:", "Below is the file:").
      text = text.replace(/^(?:Sure[,!.]?\s*)?(?:Here(?:'|’)?s|Here is|Below is)\b[^\n]{0,40}?\bfile(?:\s+content)?\b[^\n]{0,20}?[:\-]\s*\n?/i, '').trim();

      // 5) JSX-text `\${expr}` quirk: fix only outside strings/comments
      //    (`\${` inside a template literal is a real escape).
      if (/^(?:jsx|tsx)$/i.test(String(extension || ''))) {
        let out = '';
        let mode = '';                // '' code/JSX-text, else the open quote or comment kind
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i];
          const two = text.slice(i, i + 2);
          if (mode === '') {
            if (text.slice(i, i + 3) === '\\${') { out += '${'; i += 2; continue; }
            if (two === '//' || two === '/*') { mode = two; out += two; i += 1; continue; }
            // Apostrophe after a letter/digit = contraction (Here's), not a string.
            if (ch === '"' || ch === '`' || (ch === "'" && !/[A-Za-z0-9]/.test(text[i - 1] || ''))) mode = ch;
          } else if (mode === '//') {
            if (ch === '\n') mode = '';
          } else if (mode === '/*') {
            if (two === '*/') { mode = ''; out += two; i += 1; continue; }
          } else if (ch === '\\') {
            out += two; i += 1; continue;   // escaped char inside a string
          } else if (ch === mode || (mode !== '`' && ch === '\n')) {
            mode = '';                      // close quote (raw newline ends '/" strings)
          }
          out += ch;
        }
        text = out;
      }

      // That's it. No tag-based/HTML-document stripping and no "find where the code
      // starts" slicing — those second-guessed good output and cut real code. If a
      // model genuinely returns the wrong shape, the build surfaces it loudly.
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

    // Condensed design brief injected into HTML/CSS generation (full design_guide.md
    // kept as reference; the brief is ~1/4 the tokens to avoid per-file bloat).
    async function loadDesignFoundationFor(normalizedPath) {
      if (!/\.(html?|css)$/i.test(String(normalizedPath || ''))) return '';
      const guide = await loadPromptTemplate('design_guide_brief');
      return guide
        ? `\n\n=== DESIGN FOUNDATION (apply these defaults) ===\n${guide}\n===\n`
        : '';
    }

    async function buildAgentWriteFileContentPrompt(taskText, toolEvents, path, priorAttempt = '', planSpec = null) {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const fileBudget = /(?:^|\/)(?:tailwind|postcss|next|vite)\.config\.[cm]?[jt]s$/i.test(normalizedPath)
        ? 'Target 2,500 characters; hard maximum 8,000 characters. This is a configuration file: include only required configuration, never decorative variants or repeated blocks.'
        : /(?:^|\/)(?:package|tsconfig(?:\.[^/]*)?|components)\.json$/i.test(normalizedPath)
        ? 'Target 3,000 characters; hard maximum 8,000 characters. Include only valid configuration fields required by this project.'
        : 'Keep this file focused on its own role. Finish all opened syntax before adding optional polish.';
      // Single planned HTML, no separate css/js → inline everything.
      const planFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles.map((p) => String(p || '')) : [];
      const frameworkWeb = planFiles.some((p) => (
        /(?:^|\/)package\.json$/i.test(p)
        || /(?:^|\/)(?:vite|next|nuxt|astro|svelte|tsconfig|tailwind\.config|postcss\.config)[^/]*\.(?:js|mjs|cjs|ts|json)$/i.test(p)
        || /\/src\/.+\.(?:tsx|jsx)$/i.test(p)
      ));
      const selfContained = /\.html?$/i.test(normalizedPath)
        && planFiles.some((p) => /\.html?$/i.test(p))
        && !planFiles.some((p) => /\.(css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx)$/i.test(p));
      const generationHints = buildAgentFileGenerationHints(taskText, normalizedPath, { selfContained, frameworkWeb });
      if (/\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(normalizedPath) && frameworkWeb) {
        generationHints.push('Import local modules/components only when their files already exist in PROJECT_STATE or are explicitly listed in Expected files. Do not invent imports such as @/components/providers, sidebar, mobile-nav, or command-palette unless those exact files are planned; keep this file self-contained when its support components are not part of the project contract.');
      }
      // New page in a site with shared CSS: consume it + reuse the shared header/footer
      // (consistent from first write, not generate-then-repair). Mirrors the edit path.
      const sharedSourceHints = (() => {
        if (!/\.html?$/i.test(normalizedPath) || selfContained) return [];
        const allFiles = Array.from(new Set([
          ...planFiles,
          ...(Array.isArray(planSpec && planSpec._allExpectedFiles) ? planSpec._allExpectedFiles.map((p) => String(p || '')) : []),
        ].map((p) => normalizeWorkspacePath(p || '')).filter(Boolean)));
        const cssFiles = allFiles.filter((p) => /\.(css|scss|sass|less)$/i.test(p));
        if (!cssFiles.length) return [];
        const htmlCount = allFiles.filter((p) => /\.html?$/i.test(p)).length;
        const componentScripts = allFiles.filter((p) => /(?:^|\/)(?:components?|layout|shared|shell)\.[cm]?js$/i.test(p));
        const hints = [
          `This page is part of a multi-page site. Link the shared stylesheet(s) in <head>: ${cssFiles.join(', ')}. They are the single SOURCE OF TRUTH for all colors, fonts, spacing, and layout.`,
          'Do NOT add a <style> block or inline style="..." attributes. If a style you need is missing, add it to the shared stylesheet instead of restyling this page locally.',
          'Reuse the existing CSS classes and design tokens from the shared stylesheet — do not invent new colors, fonts, or a different look for this page.',
        ];
        if (htmlCount >= 2) {
          if (componentScripts.length) {
            hints.push(`The header, nav, and footer are shared across every page via ${componentScripts.join(', ')}: render them with the existing component placeholders (e.g. <div data-site-header></div> / <div data-site-footer></div>) and load that script. Do NOT hand-write a different header or footer.`);
          } else {
            hints.push('Copy the EXACT header, nav, and footer markup used by the other pages (shown in PROJECT_STATE) so every page is identical — same structure, classes, and links. Do not redesign them for this page.');
          }
        }
        return hints;
      })();
      if (sharedSourceHints.length) generationHints.push(...sharedSourceHints);
      // Structure-first: a stylesheet is written AFTER the HTML, so style the real markup.
      if (/\.(css|scss|sass|less)$/i.test(normalizedPath)) {
        const htmlSiblings = planFiles.filter((p) => /\.html?$/i.test(p));
        if (htmlSiblings.length) {
          generationHints.push('Style every class/id the sibling HTML actually uses (shown in PROJECT_STATE) — leave no section unstyled, and do not add selectors no page uses. This is the single source of truth for the whole site.');
        }
      }
      const projectState = buildAgentProjectStateContext(toolEvents, planSpec, normalizedPath);
      const designFoundation = await loadDesignFoundationFor(normalizedPath);
      // Harvested foundation vocab (real tokens/classes/components) so the page reuses
      // existing names instead of inventing a new look.
      const foundationVocab = String(planSpec && planSpec._foundationVocab || '').trim();
      const foundationBlock = foundationVocab
        ? `\n\n=== FOUNDATION VOCABULARY (already built in an earlier phase — REUSE these EXACT names; never invent alternatives or redefine them) ===\n${foundationVocab}\n===\n`
        : '';
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
          FILE_BUDGET: fileBudget,
        }) + designFoundation + foundationBlock;
      }
      return [
        'Write the complete final contents for one project file.',
        'Return the complete file inside ONE fenced code block (```<language> first line, ``` last line, nothing outside it). No explanation.',
        `File path: ${normalizedPath}`,
        `FILE BUDGET: ${fileBudget}`,
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
        designFoundation || '',
        foundationBlock || '',
        'FILE_CONTENT:',
      ].filter(Boolean).join('\n');
    }

    function buildEditFileContext(currentContent, toolEvents, path, priorAttempt = '') {
      const source = String(currentContent || '');
      const normalized = normalizeWorkspacePath(path || '');
      const evidence = [String(priorAttempt || ''), ...(toolEvents || []).slice(-8).map((event) => String(event && event.observation || ''))].join('\n');
      const lineMatch = evidence.match(new RegExp(`${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]{0,240}?line\\s+(\\d+)`, 'i')) || evidence.match(/line\s+(\d+)/i);
      const line = Number(lineMatch && lineMatch[1]) || 0;
      if (!line) return source.slice(0, 22000);
      const lines = source.split('\n');
      const start = Math.max(0, line - 121);
      const end = Math.min(lines.length, line + 120);
      return `Lines ${start + 1}-${end} (parser reported line ${line}):\n${lines.slice(start, end).join('\n')}`;
    }

    async function buildAgentEditFileContentPrompt(taskText, toolEvents, path, currentContent, priorAttempt = '', planSpec = null) {
      const toolLog = (toolEvents || []).slice(-6).map((event, index) => {
        const observation = String(event && event.observation ? event.observation : '').slice(0, agentMaxToolOutputChars);
        return `ToolResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')}\n${observation}`;
      }).join('\n\n');
      const normalizedPath = normalizeWorkspacePath(path || '');
      const projectState = buildAgentProjectStateContext(toolEvents, planSpec, normalizedPath);
      const planFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles.map((p) => String(p || '')) : [];
      const frameworkWeb = planFiles.some((p) => (
        /(?:^|\/)package\.json$/i.test(p)
        || /(?:^|\/)(?:vite|next|nuxt|astro|svelte|tsconfig|tailwind\.config|postcss\.config)[^/]*\.(?:js|mjs|cjs|ts|json)$/i.test(p)
        || /\/src\/.+\.(?:tsx|jsx)$/i.test(p)
      ));
      const baseEditHints = buildAgentFileGenerationHints(taskText, normalizedPath, { frameworkWeb });
      // When an HTML page links an external stylesheet, styling belongs in that .css
      // file. A weak model otherwise injects a fresh inline <style> block, inline
      // style="..." attributes, or !important overrides into the HTML — fighting the
      // stylesheet and creating conflicting sources of truth. Only steer this when an
      // external sheet exists (single-file HTML legitimately uses inline styles).
      const linksExternalStylesheet = /\.html?$/i.test(normalizedPath)
        && /<link[^>]+rel=["']stylesheet["']/i.test(String(currentContent || ''));
      const editHints = linksExternalStylesheet
        ? [...baseEditHints, 'This page links an external stylesheet. Make styling/layout changes by editing the linked CSS file — do NOT add a new inline <style> block, inline style="..." attributes, or !important overrides in this HTML; they fight the stylesheet and create conflicting styles.']
        : baseEditHints;
      const fileContext = buildEditFileContext(currentContent, toolEvents, normalizedPath, priorAttempt);
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
          CURRENT_FILE: fileContext,
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
        linksExternalStylesheet
          ? '- This page links an external stylesheet: make styling/layout changes in the linked CSS file, NOT by adding an inline <style> block, inline style="..." attributes, or !important overrides here.'
          : '',
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
        fileContext,
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
      const planFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles.map((p) => String(p || '')) : [];
      const frameworkWeb = planFiles.some((p) => (
        /(?:^|\/)package\.json$/i.test(p)
        || /(?:^|\/)(?:vite|next|nuxt|astro|svelte|tsconfig|tailwind\.config|postcss\.config)[^/]*\.(?:js|mjs|cjs|ts|json)$/i.test(p)
        || /\/src\/.+\.(?:tsx|jsx)$/i.test(p)
      ));
      const rewriteHints = buildAgentFileGenerationHints(taskText, normalizedPath, { frameworkWeb });
      const designFoundation = await loadDesignFoundationFor(normalizedPath);
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
        }) + designFoundation;
      }
      return [
        'Rewrite the complete final contents for one existing file after applying the requested edits.',
        'Return the complete file inside ONE fenced code block (```<language> first line, ``` last line, nothing outside it). No explanation.',
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
        designFoundation || '',
        'FILE_CONTENT:',
      ].filter(Boolean).join('\n');
    }

    async function buildAgentPlanPrompt(chatId, taskText) {
      const transcript = buildAgentHistoryTranscript(chatId, 10);
      const workspace = typeof getWorkspaceContext === 'function' ? getWorkspaceContext() : {};
      const template = await loadPromptTemplate('developer_agent_plan');
      let planWorkspaceRoot = workspace.workspaceRootName ? `/${workspace.workspaceRootName}` : '(none)';
      try {
        const tree = typeof getWorkspaceFileTreeSummary === 'function' ? await getWorkspaceFileTreeSummary() : '';
        if (tree) planWorkspaceRoot += `\nCurrent project file structure (live):\n${tree}`;
      } catch (_) { }
      return renderPromptTemplate(template, {
        AGENT_ENVIRONMENT: getAgentEnvironmentContext('plan'),
        CHAT_HISTORY: transcript || '(none)',
        CURRENT_WORKSPACE_ROOT: planWorkspaceRoot,
        CURRENT_SELECTION: normalizeWorkspacePath(workspace.currentPath || '/'),
        CURRENT_SELECTION_KIND: workspace.currentKind === 'file' ? 'file' : 'folder',
        TASK: String(taskText || '').trim(),
      });
    }

    // One decompose attempt: infer + parse. Returns { spec, res } — spec is the parsed
    // plan or null (so the caller can retry a transient failure before degrading).
    async function attemptAgentPlanSpec(prompt, planMaxTokens, taskText, chatId, forceProjectScope) {
      const res = await Promise.race([
        requestAgentPlannerInference(prompt, planMaxTokens, agentPlanGrammar),
        new Promise((resolve) => setTimeout(() => resolve({
          ok: false,
          timedOut: true,
          message: 'Agent plan step timed out.',
        }), agentStepTimeoutMs())),
      ]);
      if (!res || !res.ok) return { spec: null, res };
      let parsed = null;
      try {
        parsed = JSON.parse(String(res.output || '').trim());
      } catch (_) {
        const raw = String(res.output || '');
        // Balanced-brace scan from each '{' — robust to prose/fences around the JSON.
        const tryBalancedFrom = (s, from) => {
          let depth = 0; let inStr = false; let esc = false;
          for (let i = from; i < s.length; i += 1) {
            const c = s[i];
            if (inStr) {
              if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
              continue;
            }
            if (c === '"') inStr = true;
            else if (c === '{') depth += 1;
            else if (c === '}') { depth -= 1; if (depth === 0) return s.slice(from, i + 1); }
          }
          return '';
        };
        for (let idx = raw.indexOf('{'); idx >= 0 && !parsed; idx = raw.indexOf('{', idx + 1)) {
          const candidate = tryBalancedFrom(raw, idx);
          if (!candidate) break;
          try { parsed = JSON.parse(candidate); } catch (_) { parsed = null; }
        }
      }
      if (parsed) {
        const spec = deps.normalizeAgentPlanSpec(parsed, taskText, { chatId, forceProjectScope });
        if (spec && typeof spec === 'object') return { spec, res };
      }
      return { spec: null, res };
    }

    async function buildAgentPlanSpec(chatId, taskText, planOptions = {}) {
      const forceProjectScope = Boolean(planOptions && planOptions.forceProjectScope);
      const prompt = await buildAgentPlanPrompt(chatId, taskText);
      // Plan = one-shot JSON; needs room for a reasoning model's hidden tokens too,
      // else it truncates mid-criterion ("...and col"). 768 (decision budget) was far short.
      const planMaxTokens = Math.max(4096, Number(agentDecisionMaxTokens) || 0);
      let attempt = await attemptAgentPlanSpec(prompt, planMaxTokens, taskText, chatId, forceProjectScope);
      // A transient timeout/truncation on the decompose must NOT silently degrade a
      // real framework build into the generic single-file fallback. Retry once (unless
      // it's a hard provider failure — credits/key — which won't succeed on retry).
      const isHardFail = (r) => Boolean(r && (r.hardFail || [401, 402, 403].includes(Number(r.httpStatus))));
      if (!attempt.spec && !isHardFail(attempt.res)) {
        attempt = await attemptAgentPlanSpec(prompt, planMaxTokens, taskText, chatId, forceProjectScope);
      }
      if (attempt.spec) {
        attempt.spec._planSource = 'model';
        return attempt.spec;
      }
      const res = attempt.res;
      const fb = buildFallbackAgentPlanSpec(taskText, { chatId, forceProjectScope });
      if (fb && typeof fb === 'object') {
        fb._planSource = (!res || !res.ok)
          ? (res && res.timedOut ? 'fallback:timeout' : 'fallback:infer_fail')
          : 'fallback:parse';
        fb._planRaw = String((res && (res.output || res.message)) || '').slice(0, 300);
        if (isHardFail(res)) {
          fb._planHardError = String(res.message || '').trim() || 'The inference provider rejected the request.';
        }
      }
      return fb;
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
      let currentWorkspaceRoot = workspace.workspaceRootName ? `/${workspace.workspaceRootName}` : '(none)';
      // Always give the model the LIVE project structure (system files excluded) —
      // stops each phase burning steps on list_dir re-discovery and grounds paths.
      // Tag files this run created so the tree shows what was just built vs pre-existing.
      const createdThisRun = new Set();
      (Array.isArray(toolEvents) ? toolEvents : []).forEach((e) => {
        if (!e || !e.ok) return;
        if (e.createdNewFile && e.path) createdThisRun.add(normalizeWorkspacePath(e.path));
        if (Array.isArray(e.autoWrittenFiles)) {
          e.autoWrittenFiles.forEach((f) => {
            if (f && f.createdNewFile && f.path) createdThisRun.add(normalizeWorkspacePath(f.path));
          });
        }
      });
      let liveTreeText = '';
      try {
        const tree = typeof getWorkspaceFileTreeSummary === 'function'
          ? await getWorkspaceFileTreeSummary(createdThisRun) : '';
        if (tree) {
          liveTreeText = String(tree);
          const legend = createdThisRun.size ? ' (● = created this run)' : '';
          currentWorkspaceRoot += `\nCurrent project file structure (live)${legend}:\n${tree}`;
        }
      } catch (_) { }
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
      const relevantOlder = selectRelevantOlderEvents(olderEvents, taskText, planSpec, 3);
      const diagnosticsLog = buildAgentDiagnosticsLog(allEvents);
      const expandedReadCap = Math.max(0, Number(getAgentExpandedReadChars()) || 0);
      // Expanded content is MOST needed when diagnostics exist (fixing a broken
      // file requires its content); the old !diagnosticsLog gate starved exactly
      // that case and drove overlapping 1-20/1-30/1-50 re-reads.
      const expandedReadEvent = expandedReadCap > agentMaxToolOutputChars
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
            ? (() => {
              const headChars = Math.max(800, Math.floor(expandedReadCap * 0.7));
              const tailChars = Math.max(400, expandedReadCap - headChars);
              return [
                content.slice(0, headChars),
                `\n...[middle clipped: showing head and tail, NOT proof of truncation; full file is ${content.length} chars]...\n`,
                content.slice(-tailChars),
              ].join('');
            })()
            : content;
          return `EXPANDED CURRENT READ CONTENT (use this instead of re-reading ${path}):\nFile: ${path}\n${clipped}\n\n`;
        })()
        : '';
      const relevantOlderLog = relevantOlder.length
        ? `RELEVANT EARLIER RESULTS (carried forward because they match this task — prefer these over re-reading):\n${relevantOlder.map((event, index) => {
          // A batch-read pointer references a result that may no longer be in
          // this prompt — carry the real content instead of a dangling pointer.
          const body = event && event._fromBatchRead && String(event.content || '').trim()
            ? `Content of ${String(event.path || '')}:\n${String(event.content)}`
            : String(event && event.observation ? event.observation : '');
          return `EarlierResult ${index + 1}: ${String(event && event.tool ? event.tool : 'unknown')} ${String(event && event.path ? event.path : '')}\n${body.slice(0, agentMaxToolOutputChars)}`;
        }).join('\n\n')}\n\n`
        : '';
      // Only claim "use cached content" for paths whose content this prompt
      // actually still carries — a false claim makes the model hallucinate the
      // file when editing instead of re-reading it.
      const contentCarriedPaths = new Set();
      if (expandedReadEvent) contentCarriedPaths.add(normalizeWorkspacePath(expandedReadEvent.path || ''));
      relevantOlder.forEach((event) => {
        if (!event || String(event.tool || '').toLowerCase() !== 'read_file') return;
        const carried = (event._fromBatchRead && String(event.content || '').trim())
          || (!event._fromBatchRead && String(event.observation || '').trim());
        if (carried) contentCarriedPaths.add(normalizeWorkspacePath(event.path || ''));
      });
      const inspectedNote = olderInspected.length
        ? `Files already inspected this run:\n${olderInspected.map(([path, meta]) => {
          const flags = meta.wasTruncated
            ? '[TRUNCATED — re-read allowed]'
            : meta.modifiedAfter
            ? '[updated by your own edit — the edit result in TOOL_RESULTS is the current content; do not re-read]'
            : contentCarriedPaths.has(normalizeWorkspacePath(path))
            ? '[available — use cached content above/below; do not re-read]'
            : '[inspected earlier; its content is NOT in this prompt — if you must edit it and need exact lines, ONE search_files or read_file is allowed]';
          return `- ${path}  ${flags}`;
        }).join('\n')}\n\n`
        : '';
      // Keep only the last few tool results in full; compact older large read/list
      // dumps to a pointer (re-read on demand) so the prompt doesn't balloon with
      // stale file contents — the main driver of context bloat / degradation.
      const FULL_TOOL_TAIL = 3;
      // Pinned digest of every mutation applied this task (incl. earlier runs) —
      // survives context compaction and Continue, so the model never re-hunts
      // for a bug it already fixed or re-applies a change it already made.
      const priorRunDone = planSpec && planSpec._priorRunDone && typeof planSpec._priorRunDone === 'object'
        ? planSpec._priorRunDone
        : null;
      const appliedDigest = priorRunDone && priorRunDone.mutated && priorRunDone.mutated.size
        ? `CHANGES ALREADY APPLIED THIS TASK (including earlier runs — these are SAVED in the files; do NOT redo them or re-investigate the symptoms they fixed):\n${Array.from(priorRunDone.mutated.entries()).slice(-12).map(([p, note]) => `- ${note || `modified ${p}`}`).join('\n')}${priorRunDone.validatePassed ? '\n- validation passed after the latest change' : ''}\n\n`
        : '';
      // Only the LATEST app run reflects the current files — older ones misled the
      // model into "my fix didn't take effect" while reading a pre-edit snapshot.
      const lastRunAppIdx = (() => {
        let idx = -1;
        recentEvents.forEach((e, i) => { if (e && e.ok && String(e.tool || '').toLowerCase() === 'run_app') idx = i; });
        return idx;
      })();
      const toolLog = appliedDigest + diagnosticsLog + expandedReadLog + relevantOlderLog + inspectedNote + recentEvents.map((event, index) => {
        const tool = String(event && event.tool ? event.tool : 'unknown');
        const obs = String(event && event.observation ? event.observation : '');
        const isTail = index >= recentEvents.length - FULL_TOOL_TAIL;
        if (String(tool).toLowerCase() === 'run_app' && event && event.ok && index < lastRunAppIdx) {
          return `ToolResult ${index + 1}: run_app — SUPERSEDED: files changed after this run; the CURRENT app state is ToolResult ${lastRunAppIdx + 1} below. Ignore this older result and its snapshot.`;
        }
        // Aged batch-read pointers claim "full content is in that result" after
        // the batch result itself was compacted away — restate honestly.
        if (!isTail && event && event._fromBatchRead) {
          const p = String(event.path || '');
          return `ToolResult ${index + 1}: read_file ${p} — read earlier in a read_files batch; if that content is no longer shown in this prompt, re-reading it is allowed.`;
        }
        if (!isTail && obs.length > 1200 && ['read_file', 'list_dir', 'search_files'].includes(tool.toLowerCase())) {
          const p = String(event && event.path ? event.path : '');
          return `ToolResult ${index + 1}: ${tool} ${p} — ${obs.length} chars (omitted to save context; read_file again if you need it)`;
        }
        return `ToolResult ${index + 1}: ${tool}\n${obs.slice(0, agentMaxToolOutputChars)}`;
      }).join('\n\n');
      // Scope this run to the current phase only.
      const activePhase = planSpec && planSpec._activePhase;
      const phaseTasksText = activePhase && Array.isArray(activePhase.tasks) ? activePhase.tasks.join(' ') : '';
      const isFinalPhase = Boolean(activePhase && Number(activePhase.number) >= Number(activePhase.total));
      const readmeScheduledThisPhase = /(?:^|[\s/])readme\.md/i.test(phaseTasksText);
      // On the FINAL phase, plan entries no phase ever scheduled (and that don't
      // exist) are unbuildable contract noise — split them out so they can't
      // block the finish or pull the model out of scope.
      const partitionByContract = (paths) => {
        const kept = [];
        const dropped = [];
        (Array.isArray(paths) ? paths : []).forEach((p) => {
          const base = String(p || '').split('/').pop();
          if (!base) return;
          if ((phaseTasksText && phaseTasksText.includes(base)) || (liveTreeText && liveTreeText.includes(base))) kept.push(p);
          else dropped.push(p);
        });
        return { kept, dropped };
      };
      const expectedSplit = isFinalPhase ? partitionByContract(planSpec && planSpec.expectedFiles) : null;
      const affectedSplit = isFinalPhase ? partitionByContract(planSpec && planSpec.affectedFiles) : null;
      const renderFileList = (label, list, split) => {
        if (split) {
          const parts = [];
          if (split.kept.length) parts.push(`${label}: ${split.kept.join(', ')}`);
          if (split.dropped.length) parts.push(`Out-of-contract plan files (no phase ever scheduled these — do NOT create them and do NOT let them block finishing): ${split.dropped.join(', ')}`);
          return parts.join('\n');
        }
        return Array.isArray(list) && list.length ? `${label}: ${list.join(', ')}` : '';
      };
      const planSummary = planSpec
        ? [
          planSpec.summary ? `Goal: ${planSpec.summary}` : '',
          `Task kind: ${planSpec.taskKind || 'unknown'}`,
          `Primary stack: ${planSpec.primaryStack || 'generic'}`,
          planSpec.projectName ? `Project name: ${planSpec.projectName}` : '',
          renderFileList('Expected files', planSpec.expectedFiles, expectedSplit),
          renderFileList('Affected files', planSpec.affectedFiles, affectedSplit),
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
          // Keep the README flag consistent with the phase schedule — a "no"
          // next to a /README.md sub-task forces the model to pick a side.
          readmeScheduledThisPhase
            ? 'README required: yes (it is a sub-task of this phase)'
            : (planSpec.needsReadme
              ? (activePhase && !isFinalPhase ? 'README required: yes (written in the FINAL phase, not this one)' : 'README required: yes')
              : 'README required: no'),
        ].filter(Boolean).join('\n')
        : '(none)';
      // Component/bundler projects (React/Vite/Vue/...) get component-stack
      // guidance; the HTML shared-CSS/data-site-header wording only fits static
      // multi-page sites and reads as noise (or worse, misdirection) in a SPA.
      const componentStack = /\.(?:tsx|jsx|vue|svelte)\b|vite\.config|next\.config/i.test(
        `${liveTreeText} ${planSpec && Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles.join(' ') : ''}`
      );
      // Later phases already have the shared design as FOUNDATION VOCABULARY (cross-phase
      // memory) — re-reading index.html/the stylesheet just burns this run's steps.
      const laterPhaseReuseLine = (planSpec && planSpec._foundationVocab)
        ? (componentStack
          ? 'Do NOT re-read existing pages/components to "match the design" — the FOUNDATION VOCABULARY below already lists the shared tokens and components built in earlier phases (it is your memory of them). Import the shared components and write the new files directly; re-reading existing files just wastes this run\'s limited steps.'
          : 'Do NOT re-read index.html or the shared stylesheet to "match the design" — the FOUNDATION VOCABULARY below already lists the shared classes, tokens, and components built in earlier phases (it is your memory of them). Go straight to writing the new page(s): link the shared CSS/JS, reuse those exact names, and use <div data-site-header></div>/<div data-site-footer></div>. Re-reading existing files just wastes this run\'s limited steps.')
        : (componentStack
          ? 'You may read ONE existing page/component first to match conventions, but reading is not the work.'
          : 'You may read ONE existing page first to match its design/header/footer/source-of-truth files, but reading is not the work.');
      const laterPhaseBuildLine = componentStack
        ? 'Build only this phase\'s named deliverables. If a sub-task names a new file/component/page from Expected files, create it with write_file. IMPORT and reuse the existing shared pieces — layout components, ui components, stores, data modules, and the shared stylesheet/design tokens; do NOT re-implement page-local copies of the navbar/footer/buttons and do NOT paste a duplicate style system into each new file. If the shared components/stores/styles need additions for this phase, edit those existing shared files as support work in this same phase. Wire new pages into the existing router/layout (e.g. App routes) so nothing is orphaned. ' + laterPhaseReuseLine
        : 'Build only this phase\'s named deliverables. If a sub-task names a new file/page from Expected files, create it with write_file. If a new page needs styles, tokens, scripts, header/nav/footer markup, or repeated sections that are not already in the shared source-of-truth files, edit the existing shared CSS/JS/component files as support work in this same phase; do NOT solve it with inline CSS or a redesigned page-local shell. If a sub-task is shared styling, components, behavior, README, or design/brand/strategy guidance, update that existing source-of-truth file instead of inventing a new public HTML page. ' + laterPhaseReuseLine + ' Later HTML pages must link the existing shared CSS and shared components/scripts; do NOT paste a new inline theme, nav, logo, footer, or button system into each page. Public HTML pages must stay within the planned page count/scope unless the user explicitly asked for additional navigable documentation pages.';
      const phaseScope = activePhase && activePhase.title
        ? [
          '',
          '=== PHASED BUILD — THIS RUN BUILDS ONE PHASE ONLY ===',
          `You are on Phase ${activePhase.number} of ${activePhase.total}: ${activePhase.title}`,
          activePhase.tasks && activePhase.tasks.length
            // Trailing sentence periods on path sub-tasks break exact path
            // matching and teach the model to echo "file.tsx." — strip them.
            ? `Remaining sub-tasks for THIS phase:\n${activePhase.tasks.map((t) => `  - ${String(t).trim().replace(/(\.[A-Za-z0-9]{1,5})\.$/, '$1')}`).join('\n')}`
            : '',
          activePhase.number === 1
            ? 'Phase 1 must be a COMPLETE, RUNNABLE vertical slice with real user-visible behavior, not an empty shell. Keep it focused on the sub-tasks listed above; do NOT build later phases\' pages/screens/features now. The workspace was just created and is empty — start writing files immediately; do NOT read_file or list_dir the root or the project name.'
            : laterPhaseBuildLine,
          `STRICT SCOPE: build ONLY the files needed for the ${activePhase.tasks && activePhase.tasks.length ? activePhase.tasks.length : 'few'} sub-task(s) above (roughly that many files) — NOT the whole project. Do not create pages or screens that belong to later phases.`,
          'The sub-task list above is the authoritative contract for THIS run. Any PLAN Expected file or Done criterion that no phase sub-task covers is out of contract — do not build it now and do not let it block finalizing this phase.',
          activePhase.number < activePhase.total
            ? 'Do NOT write README.md or other documentation in this phase — docs come in the FINAL phase only. Build the actual app/page files for this phase first.'
            : '',
          'When this phase\'s sub-tasks are built and it runs, validate_files (and run_app if runnable) then return {"action":"final"} — do NOT continue into the next phase. The user presses Continue to advance; the next run picks up the next phase.',
          'In the final message, state only what was actually done and verified this phase (files built, checks passed). Do NOT claim the app "renders", "works", or "displays" anything unless a run actually happened this phase and succeeded.',
          '===',
        ].filter(Boolean).join('\n')
        : '';

      const template = await loadPromptTemplate('developer_agent_decision');
      const vars = {
        AGENT_ENVIRONMENT: getAgentEnvironmentContext('decision'),
        AGENT_STEP: Number(stepIndex),
        AGENT_MAX_STEPS: agentMaxSteps,
        CURRENT_WORKSPACE_ROOT: currentWorkspaceRoot,
        CURRENT_SELECTION: selectedPath,
        CURRENT_SELECTION_KIND: selectedKind,
        CHAT_HISTORY: transcript || '(none)',
        PENDING_REQUIREMENTS: summarizeAgentPendingRequirements(taskText, toolEvents, planSpec),
        TOOL_RESULTS: toolLog || '(none yet)',
        TASK: String(taskText || '').trim(),
        PLAN_SUMMARY: phaseScope ? `${planSummary}\n${phaseScope}` : planSummary,
        IMMEDIATE_NEXT_ACTION: buildImmediateNextAction(taskText, toolEvents, planSpec, stepIndex),
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
      buildImmediateNextAction,
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
