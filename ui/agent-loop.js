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
    // Preserve semantic numbers/model/package names. Normalize only volatile source
    // locations; deleting every digit used to conflate genuinely different failures.
    const normIssue = shortReason
      .replace(/`[^`]*`/g, '')
      .replace(/\b(line|column|offset|position)\s*[:#]?\s*\d+\b/gi, '$1 #')
      .replace(/:\d+(?::\d+)?\b/g, ':#')
      .replace(/\s+/g, ' ').trim().toLowerCase();
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

  function narrationWordSet(text) {
    return new Set(String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3));
  }

  function narrationOverlapRatio(aText, bText) {
    const a = narrationWordSet(aText);
    const b = narrationWordSet(bText);
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach((w) => { if (b.has(w)) inter += 1; });
    return inter / Math.min(a.size, b.size);
  }

  function phaseNarrationNumber(text) {
    const match = String(text || '').match(/\bphase\s+(\d+)\b/i);
    return match ? match[1] : '';
  }

  function looksLikePhaseIntroNarration(text) {
    const detail = String(text || '').trim();
    if (!/\bphase\s+\d+\b/i.test(detail)) return false;
    if (!/\b(?:continuing|continue|starting|start|beginning|begin|build|building|adding|adds|setting up)\b/i.test(detail)) return false;
    return /\b(?:reuse|reusing|shared|consistent|tokens|components|layout|tailwind|appcontext|types|pages?|interface|screen)\b/i.test(detail);
  }

  function shouldSuppressAgentNarration(text, lastNarrationDetail = '', toolEvents = []) {
    const detail = String(text || '').trim();
    if (!detail || detail.length < 8) return true;
    if (/<\s*(?:tool_call|function=agent_step|parameter\s*=)|<\/parameter>/i.test(detail)) return true;
    if (detail === String(lastNarrationDetail || '').trim()) return true;
    if (looksLikePhaseIntroNarration(detail) && looksLikePhaseIntroNarration(lastNarrationDetail)) {
      const curPhase = phaseNarrationNumber(detail);
      const prevPhase = phaseNarrationNumber(lastNarrationDetail);
      if (curPhase && curPhase === prevPhase) return true;
    }
    if (lastNarrationDetail && narrationOverlapRatio(detail, lastNarrationDetail) >= 0.78) return true;
    const hasFileMutation = (Array.isArray(toolEvents) ? toolEvents : []).some((event) => event && event.ok
      && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()));
    if (hasFileMutation && /^(?:i(?:'|’)ll|i will|i(?:'|’)m going to|i am going to|let me|i(?:'|’)m|i am)\s+(?:start|begin|create|build|set up|write|make|add|work on)\b/i.test(detail)) {
      return true;
    }
    return false;
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
      && !e._fromBatchRead
      && String(e.path || '') === readPath);
    if (priorReads.length === 0) return null;
    if (priorReads.some((e) => summarizeReadRange(e) === currentSig)) return 'exact-repeat';
    if (priorReads.length >= hardCap) return 'hard-cap';
    const last = priorReads[priorReads.length - 1];
    const sigParts = String(currentSig).split(':');
    const currentIsTargeted = (Number(sigParts[0]) || 0) > 0 || (Number(sigParts[2]) || 0) > 0;
    // A ranged read fully covered by a recent untruncated read adds nothing
    // (the 1-50 then 1-30 then 1-15 pattern).
    const reqStart = Number(sigParts[0]) || 0;
    const reqEnd = Number(sigParts[1]) || 0;
    if (reqStart > 0) {
      const covered = priorReads.slice(-3).some((event) => {
        if (readEventWasTruncated(event)) return false;
        const priorStart = Number(event.startLine) || 0;
        const priorEnd = Number(event.endLine) || 0;
        if (priorStart === 0 && (Number(event.offset) || 0) === 0) return true;
        return priorStart > 0 && priorStart <= reqStart && (priorEnd === 0 || (reqEnd > 0 && priorEnd >= reqEnd));
      });
      if (covered) return 'subset-of-recent-read';
    }
    if (priorReads.length >= 2 && !readEventWasTruncated(last) && !currentIsTargeted) return 'already-seen';
    // Otherwise the file is still partially unseen (last read truncated) — allow
    // the model to page forward to the part it has not read yet.
    return null;
  }

  function extractFileLikeTaskPaths(text, normalizeWorkspacePath) {
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const out = [];
    // Plan tasks read like sentences ("/src/pages/DashboardPage.tsx.") — a period
    // straight after the extension made the lookahead reject the whole path, so
    // live task ticking never matched. A dot before whitespace/end is punctuation,
    // never part of a filename.
    const raw = String(text || '').replace(/\.(?=\s|$)/g, ' ');
    const rx = /(^|[\s"'`(])((?:\/|\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:html?|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|py|php|java|c|cpp|h|hpp|cs|go|rs|rb|swift|kt|sql|xml|svg|csv|yml|yaml))(?![A-Za-z0-9_.-])/g;
    let m;
    while ((m = rx.exec(raw))) {
      const p = norm(String(m[2] || '').replace(/^\.\//, '/'));
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  // Directory-glob sub-tasks ("Src/components/ui/*.") name a folder of files, not
  // one path — extract the folder prefix so writes under it can tick the task.
  function extractDirGlobTaskPrefixes(text, normalizeWorkspacePath) {
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const out = [];
    const rx = /(^|[\s"'`(])((?:\/|\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)\/\*/g;
    let m;
    while ((m = rx.exec(String(text || '')))) {
      const p = norm(String(m[2] || '').replace(/^\.\//, '/'));
      if (p && p !== '/' && !out.includes(p)) out.push(p);
    }
    return out;
  }

  function markPhaseTaskLiveProgressForPath(phaseState, rawPath, normalizeWorkspacePath) {
    if (!phaseState || !Array.isArray(phaseState.phases)) return 0;
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const path = norm(rawPath || '');
    if (!path) return 0;
    const comparablePath = path.toLowerCase();
    const activeIndex = Math.max(0, Math.min(phaseState.phases.length - 1, Number(phaseState.activeIndex) || 0));
    const phase = phaseState.phases[activeIndex];
    const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
    let changed = 0;
    tasks.forEach((task) => {
      if (!task || task.done || task.liveDone) return;
      const matches = extractFileLikeTaskPaths(task.text || task, norm);
      const globPrefixes = extractDirGlobTaskPrefixes(task.text || task, norm);
      if (matches.some((candidate) => String(candidate || '').toLowerCase() === comparablePath)
        || globPrefixes.some((prefix) => comparablePath.startsWith(`${String(prefix).toLowerCase()}/`))) {
        task.liveDone = true;
        changed += 1;
      }
    });
    return changed;
  }

  function getActivePhaseFileTaskGaps(phaseState, normalizeWorkspacePath, pathKnownPresent = null) {
    if (!phaseState || !Array.isArray(phaseState.phases)) return [];
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const activeIndex = Math.max(0, Math.min(phaseState.phases.length - 1, Number(phaseState.activeIndex) || 0));
    const phase = phaseState.phases[activeIndex];
    const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
    const gaps = [];
    tasks.forEach((task) => {
      if (!task || task.done || task.liveDone) return;
      const paths = extractFileLikeTaskPaths(task.text || task, norm);
      if (paths.length && typeof pathKnownPresent === 'function' && paths.every((p) => pathKnownPresent(p))) {
        task.liveDone = true;
        return;
      }
      if (paths.length) gaps.push({ text: String(task.text || task || '').trim(), path: paths[0], paths });
    });
    return gaps;
  }

  function activePhaseFilePaths(phaseState, normalizeWorkspacePath) {
    if (!phaseState || !Array.isArray(phaseState.phases)) return [];
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const activeIndex = Math.max(0, Math.min(phaseState.phases.length - 1, Number(phaseState.activeIndex) || 0));
    const phase = phaseState.phases[activeIndex];
    const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
    const paths = [];
    tasks.forEach((task) => {
      extractFileLikeTaskPaths(task && (task.text || task), norm).forEach((p) => {
        if (p && !paths.some((known) => known.toLowerCase() === p.toLowerCase())) paths.push(p);
      });
    });
    return paths;
  }

  // Durable whole-project file list (every phase's files) from plan.md-backed phases.
  // The re-planner shrinks planSpec.expectedFiles on a Continue, so the foundation
  // css/js drops out of validation scope — use this instead so cross-page checks fire.
  function allPhaseFilePaths(phaseState, normalizeWorkspacePath) {
    if (!phaseState || !Array.isArray(phaseState.phases)) return [];
    const norm = typeof normalizeWorkspacePath === 'function' ? normalizeWorkspacePath : (p) => String(p || '');
    const paths = [];
    phaseState.phases.forEach((phase) => {
      const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
      tasks.forEach((task) => {
        extractFileLikeTaskPaths(task && (task.text || task), norm).forEach((p) => {
          if (p && !paths.some((known) => known.toLowerCase() === p.toLowerCase())) paths.push(p);
        });
      });
    });
    return paths;
  }

  // Natural phase-handoff line: rotate phrasings by phase index so back-to-back
  // handoffs don't read like the same canned template, while keeping the phase
  // names and the literal "Continue" cue.
  function buildPhaseHandoffMessage(doneIdx, doneTitle, nextIdx, nextTitle, options = {}) {
    // Belt-and-braces: titles are stripped at parse time, but legacy plan.md
    // entries may still carry the "Phase N —" prefix.
    const clean = (t) => String(t || '').replace(/^(?:\s*phase\s*\d+\s*[—–·:.\-]*\s*)+/i, '').trim();
    const doneName = `Phase ${doneIdx + 1}`;
    const nextName = `Phase ${nextIdx + 1}${clean(nextTitle) ? ` — ${clean(nextTitle)}` : ''}`;
    // When appended under the model's own "Phase N complete — ..." line, don't
    // restate completion; just give the forward cue.
    const variants = options && options.forwardOnly
      ? [
        `Whenever you're ready, press Continue and I'll get started on ${nextName}.`,
        `Continue takes us into ${nextName} next.`,
        `Hit Continue and I'll dig into ${nextName}.`,
        `Next up: ${nextName} — just press Continue.`,
        `Press Continue when you want me to move on to ${nextName}.`,
      ]
      : [
        `That's ${doneName} finished. Whenever you're ready, press Continue and I'll get started on ${nextName}.`,
        `${doneName} is all built. Continue takes us into ${nextName} next.`,
        `Just wrapped up ${doneName} — hit Continue and I'll dig into ${nextName}.`,
        `${doneName} is done and in place. Next comes ${nextName}; just press Continue.`,
        `Finished with ${doneName}. Press Continue when you want me to move on to ${nextName}.`,
      ];
    return variants[Math.abs(Number(doneIdx) || 0) % variants.length];
  }

  function shouldForcePhaseValidation(decision, phaseState, missingFiles, validationFailure, validationPassed) {
    const finishing = !decision || decision.action !== 'tool' || decision.tool === 'none';
    return Boolean(finishing
      && phaseState
      && Array.isArray(missingFiles) && missingFiles.length === 0
      && !validationFailure
      && !validationPassed);
  }

  // Cross-run done-work memory per chat: survives Continue/stream crashes so
  // final_check and PENDING_REQUIREMENTS never re-demand work an earlier run
  // of the same task already did (the "inspect /style.css again" churn loop).
  const agentChatDoneWork = new Map(); // chatId -> { task, read:Set, mutated:Map(path->note), validatePassed:bool }
  function getAgentChatDoneWork(chatId, taskText) {
    const key = String(chatId || '');
    const task = String(taskText || '').trim();
    // Short nudges ("continue", "try again") inherit the prior task's memory;
    // a genuinely new task starts fresh.
    const continueNudge = task.length <= 48;
    let entry = agentChatDoneWork.get(key);
    if (!entry || (entry.task !== task && !continueNudge)) {
      entry = { task, read: new Set(), mutated: new Map(), validatePassed: false };
      agentChatDoneWork.set(key, entry);
    }
    return entry;
  }
  function recordAgentDoneWork(done, ev, norm) {
    if (!done || !ev || !ev.ok) return;
    const tool = String(ev.tool || '').toLowerCase();
    const path = typeof norm === 'function' ? norm(ev.path || '') : String(ev.path || '');
    if (tool === 'new_project') {
      // fresh workspace: prior accomplishments no longer apply
      done.read.clear();
      done.mutated.clear();
      done.validatePassed = false;
      return;
    }
    if (tool === 'read_file' && path && path !== '/') done.read.add(path);
    if (['write_file', 'edit_file'].includes(tool) && path && path !== '/') {
      const note = String(ev.observation || '').split('\n')[0].trim().slice(0, 160);
      done.mutated.set(path, note || `${tool} ok: ${path}`);
      done.validatePassed = false; // new mutation needs a fresh validate pass
    }
    if (tool === 'validate_files' && ev.validationPassed === true) done.validatePassed = true;
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
      // Durable run lifecycle log (agent-events.js). toolEvents.push is the one
      // choke point every tool result flows through — intercept it so each event
      // lands in the durable log without touching any push site. Observe-only.
      const runLog = typeof deps.createRunEventLog === 'function'
        ? deps.createRunEventLog({ threadId: String(chatId || ''), task: taskText })
        : null;
      if (runLog) {
        const arrayPush = Array.prototype.push;
        toolEvents.push = function pushWithRunLog(...items) {
          items.forEach((ev) => { try { runLog.emitToolEvent(ev); } catch (_) { /* observe-only */ } });
          return arrayPush.apply(this, items);
        };
      }
      // Cross-run done-work memory: record every ok event (chains over runLog wrapper).
      const doneWork = getAgentChatDoneWork(chatId, taskText);
      {
        const basePush = toolEvents.push.bind(toolEvents);
        toolEvents.push = (...items) => {
          items.forEach((ev) => { try { recordAgentDoneWork(doneWork, ev, deps.normalizeWorkspacePath); } catch (_) { /* observe-only */ } });
          return basePush(...items);
        };
      }
      // Oscillation guard: if an edit returns a file to a prior content state, the
      // agent is flip-flopping — block further edits to it and finalize.
      const fileStateHistory = new Map(); // path -> Set(contentHash)
      const oscillatingEditPaths = new Set();
      let oscillationBlocks = 0;   // repeated re-edits of an already-correct file → force finalize
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
      // Decision replies that inlined a whole file and blew the structured-output
      // cap: recover by steering (content belongs to the dedicated content step).
      let outputLimitNudges = 0;
      let incompleteJsonNudges = 0;
      let runAppFinishNudges = 0;
      let autoFinalSummaryNudgeUsed = false;
      // Block completing a phase when the model wrote nothing that run.
      let phaseEmptyFinalNudges = 0;
      // The latest run_app since the last write, IF it still reports errors — used to
      // refuse a clean finish over an unrepaired runtime failure (ok:true+runErrorCount
      // >0 is a failure; ok:false = page wouldn't load).
      const unresolvedRunAppError = () => {
        let lastWrite = -1;
        let lastRun = null;
        let lastRunIdx = -1;
        for (let i = 0; i < toolEvents.length; i += 1) {
          const ev = toolEvents[i];
          if (!ev) continue;
          const t = String(ev.tool || '').toLowerCase();
          if (ev.ok && ['write_file', 'edit_file'].includes(t)) lastWrite = i;
          if (t === 'run_app') { lastRun = ev; lastRunIdx = i; }
        }
        if (lastRunIdx > lastWrite && lastRun && (!lastRun.ok || Number(lastRun.runErrorCount) > 0)) return lastRun;
        return null;
      };
      // One evidence-based finish audit per run (diffs vs done criteria); advisory.
      let criteriaNudgeUsed = false;
      // Latest dev server this run started (from run_command); stale = source
      // mutated after it started, so a non-hot-reload server serves old code.
      let runDevServer = null;
      const devServerHotReloads = (command) => /\b(?:vite|next dev|nuxt|astro|webpack serve|react-scripts|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev|nodemon|--reload|--watch|http\.server|flask)\b/i.test(String(command || ''));
      const startedAt = Date.now();
      const deadlineAt = startedAt + deps.agentTotalTimeoutMs;
      let planSpec = null;
      // Total-deadline hit: the wrap-up must not make more slow model calls.
      let totalTimedOut = false;
      // Phased state (out here so the finally can keep the tracker pinned).
      let phaseState = null;
      let keepPhaseTrackerPinned = false;
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

      const fileRoleLabel = (path) => {
        const p = String(path || '').toLowerCase();
        if (/\.html?$/.test(p)) return 'page';
        if (/\.(css|scss|sass|less)$/.test(p)) return 'styles';
        if (/\.(js|mjs|cjs|ts|jsx|tsx)$/.test(p)) return 'script';
        if (/\.json$/.test(p)) return 'data';
        if (/\.md$/.test(p)) return 'docs';
        return 'file';
      };
      const baseName = (path) => String(path || '').split('/').filter(Boolean).pop() || 'file';
      let plannedParentDirsCreated = false;
      const plannedParentDirs = () => {
        const dirs = new Set();
        const addParents = (rawPath) => {
          const normalized = deps.normalizeWorkspacePath(rawPath || '');
          if (!normalized || normalized === '/' || !normalized.includes('/')) return;
          const parts = normalized.split('/').filter(Boolean);
          parts.pop();
          let acc = '';
          parts.forEach((part) => {
            acc += `/${part}`;
            if (acc && acc !== '/' && acc !== '/.aiexe') dirs.add(acc);
          });
        };
        const files = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
        files.forEach(addParents);
        return Array.from(dirs);
      };
      const precreatePlannedParentDirs = async (reason) => {
        if (plannedParentDirsCreated) return;
        plannedParentDirsCreated = true;
        const dirs = plannedParentDirs();
        if (!dirs.length) return;
        recordDebugTrace('agent_parallel_mkdir_start', {
          chatId: String(chatId || ''),
          reason: String(reason || ''),
          dirs: dirs.join(' | '),
        }, { chatId: String(chatId || ''), reason, dirs });
        const results = await Promise.all(dirs.map(async (dir) => {
          try {
            const response = await deps.invokeWorkspaceAction('workspaceMkdir', { path: dir });
            return { dir, ok: Boolean(response && response.ok), message: String(response && response.message ? response.message : '') };
          } catch (err) {
            return { dir, ok: false, message: String(err && err.message ? err.message : err) };
          }
        }));
        results.forEach((result) => {
          if (!result || !result.ok) return;
          const dir = deps.normalizeWorkspacePath(result.dir || '');
          if (!dir || dir === '/') return;
          const event = {
            tool: 'mkdir',
            ok: true,
            path: dir,
            srcPath: '',
            dstPath: '',
            validationPassed: false,
            validationIssues: [],
            content: '',
            originalContent: undefined,
            createdNewFile: false,
            runErrorCount: 0,
            startLine: 0,
            endLine: 0,
            offset: 0,
            searchQuery: '',
            observation: `mkdir ok: ${dir}`,
          };
          toolEvents.push(event);
          appendAgentActivity(deps.buildAgentActivityFromToolResult(
            { action: 'tool', tool: 'mkdir', path: dir, content: '', srcPath: '', dstPath: '' },
            { ok: true, mutated: true, observation: event.observation },
            toolEvents
          ));
        });
        recordDebugTrace('agent_parallel_mkdir_done', {
          chatId: String(chatId || ''),
          ok: String(results.filter((r) => r && r.ok).length),
          failed: String(results.filter((r) => r && !r.ok).length),
        }, { chatId: String(chatId || ''), results });
        if (results.some((r) => r && r.ok) && typeof deps.scheduleWorkspaceExplorerBackgroundRefresh === 'function') {
          deps.scheduleWorkspaceExplorerBackgroundRefresh();
        }
      };
      const synthesizeToolNarration = (decision) => {
        const tool = String(decision && decision.tool || '').toLowerCase();
        const path = String(decision && decision.path || '').trim();
        if (tool === 'read_file') return path ? `Reading ${baseName(path)} before deciding the next change.` : 'Reading the file before deciding the next change.';
        if (tool === 'search_files') return 'Searching for relevant code patterns before choosing files to edit.';
        if (tool === 'edit_file') return path ? `Editing the ${fileRoleLabel(path)} ${baseName(path)}.` : 'Applying the targeted file edit.';
        if (tool === 'write_file') return path ? `Writing the ${fileRoleLabel(path)} ${baseName(path)}.` : 'Writing the file.';
        if (tool === 'validate_files') return 'Checking the changed files before finishing.';
        if (tool === 'list_dir') return 'Checking the workspace structure.';
        if (tool === 'mkdir') return path ? `Creating directory ${path}.` : 'Creating the directory.';
        if (tool === 'move') return 'Moving the file to its final location.';
        if (tool === 'delete') return path ? `Removing ${path}.` : 'Removing the file.';
        return '';
      };

      // One evidence-based audit (diffs vs done criteria) before accepting a finish
      // on edit runs; catches no-op fixes.
      const getUnmetCriteriaNudge = async () => {
        if (criteriaNudgeUsed || typeof deps.verifyAgentDoneCriteria !== 'function') return null;
        const editedExisting = toolEvents.some((event) => event && event.ok
          && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())
          && typeof event.originalContent === 'string'
          && event.originalContent.trim());
        if (!editedExisting) return null;
        criteriaNudgeUsed = true;
        // This is a slow model call — never leave the user staring at dead air.
        setAgentProgress('Reviewing the result...');
        const check = await deps.verifyAgentDoneCriteria(taskText, toolEvents, planSpec);
        if (!check || check.ok || !Array.isArray(check.unmet) || !check.unmet.length) return null;
        return check.unmet;
      };

      const pushCriteriaNudgeObservation = (unmet) => {
        const lines = unmet.map((item) => `- "${item.criterion}"${item.why ? ` — ${item.why}` : ''}`);
        toolEvents.push({
          tool: 'criteria_check',
          ok: false,
          observation: `Before finishing: reviewing your actual diffs against the done criteria suggests these are NOT satisfied yet:\n${lines.join('\n')}\nRe-inspect the relevant code — the change you made may target an element that cannot produce the required outcome — and make the missing change. If you are certain a criterion is already satisfied, finish again and it will be accepted.`,
        });
        recordDebugTrace('agent_criteria_nudge', {
          chatId: String(chatId || ''),
          count: String(unmet.length),
        }, { chatId: String(chatId || ''), unmet, toolEvents });
        setAgentProgress('Reviewing...');
      };

      // LCS line-diff counts (mirrors the renderer's activity stats) so the
      // edit card can show per-file +added/-removed for the whole run.
      const countRunLineDiffStats = (beforeText, afterText) => {
        const beforeLines = String(beforeText || '') ? String(beforeText || '').split('\n') : [];
        const afterLines = String(afterText || '') ? String(afterText || '').split('\n') : [];
        if (!beforeLines.length) return { added: afterLines.length, removed: 0 };
        if (!afterLines.length) return { added: 0, removed: beforeLines.length };
        const width = afterLines.length + 1;
        let prev = new Uint16Array(width);
        let curr = new Uint16Array(width);
        for (let i = 1; i <= beforeLines.length; i += 1) {
          for (let j = 1; j <= afterLines.length; j += 1) {
            curr[j] = beforeLines[i - 1] === afterLines[j - 1]
              ? prev[j - 1] + 1
              : Math.max(prev[j], curr[j - 1]);
          }
          const swap = prev;
          prev = curr;
          curr = swap;
        }
        const common = prev[afterLines.length];
        return { added: afterLines.length - common, removed: beforeLines.length - common };
      };

      // Per-response revert: snapshot each touched file's pre-run state (first
      // touch wins; the latest content is the post-run state for diff stats).
      // Created files revert by deletion. Oversized files are skipped.
      const buildRunRevertSnapshot = () => {
        const seen = new Map();
        for (const event of toolEvents) {
          if (!event || !event.ok) continue;
          if (!['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase())) continue;
          const path = deps.normalizeWorkspacePath(event.path || '');
          if (!path) continue;
          const existing = seen.get(path);
          if (existing) {
            if (typeof event.content === 'string' && event.content) existing.post = event.content;
            continue;
          }
          if (typeof event.originalContent !== 'string') continue;
          const createdNew = event.createdNewFile === true;
          seen.set(path, {
            path,
            existedBefore: !createdNew,
            content: createdNew ? '' : event.originalContent,
            post: typeof event.content === 'string' ? event.content : '',
          });
        }
        let totalChars = 0;
        const files = [];
        for (const file of seen.values()) {
          if (file.content.length > 200000) continue;
          totalChars += file.content.length;
          if (totalChars > 800000) break;
          const stats = countRunLineDiffStats(file.content, file.post);
          recordDebugTrace('agent_file_diff', {
            path: String(file.path || ''),
            existedBefore: String(file.existedBefore),
            beforeLines: String(file.content ? file.content.split('\n').length : 0),
            afterLines: String(file.post ? file.post.split('\n').length : 0),
            added: String(stats.added),
            removed: String(stats.removed),
          });
          files.push({
            path: file.path,
            existedBefore: file.existedBefore,
            content: file.content,
            added: stats.added,
            removed: stats.removed,
          });
        }
        return files.length ? { files } : null;
      };
      const agentMetaWithRevert = (meta) => {
        const revert = buildRunRevertSnapshot();
        return revert ? { ...meta, revert } : meta;
      };

      const getWorkspaceLabel = () => {
        try {
          return deps.getWorkspaceRootName() || deps.deriveProjectNameFromTask(taskText) || 'project';
        } catch (_) {
          return 'project';
        }
      };

      // When a guard stops the run after real work landed, the final message must
      // report that work (grounded in the diffs), not just the blocker.
      const buildStoppedWithWorkText = async (blockerNote) => {
        const hasMutations = toolEvents.some((event) => event && event.ok && isMutationTool(event.tool));
        if (!hasMutations) return blockerNote;
        if (phaseState) {
          const changed = [...new Set(toolEvents
            .filter((event) => event && event.ok && ['write_file', 'edit_file'].includes(String(event.tool || '').toLowerCase()))
            .map((event) => deps.normalizeWorkspacePath(event.path || ''))
            .filter(Boolean))];
          const gaps = getKnownActivePhaseFileTaskGaps();
          const activeP = phaseState.phases[phaseState.activeIndex] || {};
          const changedText = changed.length ? `Changed: ${changed.slice(0, 6).join(', ')}.` : 'No phase files were changed.';
          const remainingText = gaps.length ? `Still to do in Phase ${phaseState.activeIndex + 1}: ${gaps.map((g) => g.text || g.path).join('; ')}.` : `Phase ${phaseState.activeIndex + 1} still needs validation or review.`;
          return `Phase ${phaseState.activeIndex + 1}${activeP.title ? ` (${activeP.title})` : ''} is not complete yet. ${changedText} ${remainingText}\n\n${blockerNote}`;
        }
        const base = String(await deps.generateAgentCompletionText(taskText, toolEvents, getWorkspaceLabel(), planSpec) || '').trim();
        return base ? `${base}\n\n${blockerNote}` : blockerNote;
      };

      let lastNarrationDetail = '';
      let deterministicBatchNarrated = false;
      const appendAgentNarration = (text) => {
        const cleaned = deps.sanitizeAssistantText ? deps.sanitizeAssistantText(text) : text;
        const detail = String(cleaned || '').trim();
        if (shouldSuppressAgentNarration(detail, lastNarrationDetail, toolEvents)) return;
        // Skip a near-duplicate of the previous line (models often restate the same
        // thought on consecutive steps): drop it if it shares most significant words.
        if (lastNarrationDetail) {
          const a = narrationWordSet(detail); const b = narrationWordSet(lastNarrationDetail);
          if (a.size >= 4) {
            let inter = 0; a.forEach((w) => { if (b.has(w)) inter += 1; });
            if (inter / a.size >= 0.65) return;
          }
        }
        appendAgentActivity({
          kind: 'thought',
          title: '',
          detail: detail.slice(0, 900),
          status: 'done',
        });
        lastNarrationDetail = detail;
      };

      const buildDeterministicStartupNarration = (decision) => {
        const tool = String(decision && decision.tool || '').toLowerCase();
        const projectName = String((planSpec && planSpec.projectName) || deps.deriveProjectNameFromTask(taskText) || 'project').trim();
        const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles)
          ? planSpec.expectedFiles.map((p) => deps.normalizeWorkspacePath(p || '')).filter(Boolean)
          : [];
        const fileCount = expectedFiles.length;
        if (tool === 'new_project') {
          if (fileCount > 1) {
            return `I'll create the ${projectName} workspace, scaffold the planned files, then validate and run it.`;
          }
          return `I'll create the ${projectName} workspace and start writing the project files.`;
        }
        if (tool === 'write_file' && fileCount > 0) {
          const path = deps.normalizeWorkspacePath(decision && decision.path || '');
          return path
            ? `I'll start writing the planned project files, beginning with ${path}.`
            : "I'll start writing the planned project files now.";
        }
        return '';
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

      const agentHasUsefulInspectionEvidence = () => toolEvents.some((event) => (
        event
        && event.ok
        && ['read_file', 'read_files', 'search_files', 'validate_files', 'check_code', 'run_app', 'run_command']
          .includes(String(event.tool || '').toLowerCase())
      ));

      // Finish-time run surfacing: verify (and if stale, restart) the run's dev
      // server, auto-open fresh builds, else offer a Run button in the final
      // bubble — the user should always know WHERE to check the result.
      const buildFinishRunSurface = async ({ autoOpen = true } = {}) => {
        if (runDevServer && runDevServer.id > 0) {
          let statusMsg = '';
          try {
            const st = await deps.invokeWorkspaceAction('devServerStatus', { serverId: runDevServer.id });
            statusMsg = String((st && st.ok && st.message) || '');
          } catch (_) { }
          if (/^running/.test(statusMsg)) {
            let restarted = false;
            if (runDevServer.stale && runDevServer.command && !devServerHotReloads(runDevServer.command)) {
              // No hot reload + edits after start = serving pre-edit code.
              // Restart the same (already-approved) command so the user's check
              // sees the latest changes.
              try { await deps.invokeWorkspaceAction('devServerStop', { serverId: runDevServer.id }); } catch (_) { }
              agentActivities.forEach((activity) => {
                if (activity && activity.devServer && Number(activity.devServer.id) === runDevServer.id) activity.devServer.running = false;
              });
              const restartDecision = { action: 'tool', tool: 'run_command', command: runDevServer.command };
              let res = null;
              try {
                res = await deps.executeDeveloperToolCall(chatId, restartDecision, taskText, toolEvents, planSpec, {
                  approvedCommand: runDevServer.command,
                  forceCurrentWorkspace: true,
                  skipNewProjectConfirmation: true,
                });
              } catch (_) { }
              if (res && res.devServer && res.devServer.running) {
                appendAgentActivity(deps.buildAgentActivityFromToolResult(restartDecision, res, toolEvents));
                runDevServer = {
                  id: Number(res.devServer.id) || 0,
                  url: String(res.devServer.url || runDevServer.url || '').trim(),
                  command: runDevServer.command,
                  stale: false,
                };
                restarted = true;
              } else {
                runDevServer = null;
                return {
                  note: ' The dev server was still serving the pre-edit code, so I stopped it — click Run below to relaunch it with the latest changes.',
                  runHint: { kind: 'run' },
                };
              }
            }
            const url = runDevServer.url;
            if (url && autoOpen) {
              try {
                if (typeof window.openExternalUrl === 'function') window.openExternalUrl(url);
                else window.open(url, '_blank');
              } catch (_) { }
            }
            const restartNote = restarted ? ' I restarted the dev server so it serves your latest changes.' : '';
            if (url) {
              return {
                note: `${restartNote} The app is running at ${url} — I opened it in your browser (the dev-server card above also has Open and Stop buttons).`,
                runHint: { kind: 'devserver', url },
              };
            }
            return {
              note: `${restartNote} The dev server is running — its card above has the startup log and a Stop button.`,
              runHint: { kind: 'run' },
            };
          }
          runDevServer = null;
        }
        const runnableMutation = toolEvents.some((e) => e && e.ok
          && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase())
          && /\.(html?|js|mjs|cjs|ts|tsx|jsx|css|py)$/i.test(String(e.path || '')));
        if (!runnableMutation) return { note: '', runHint: null };
        // Fresh build (new entry page written this run) → launch it now; native
        // Smart Run serves web projects over http:// and opens the browser.
        const webPlan = String(planSpec && planSpec.primaryStack || '').toLowerCase() === 'web';
        const wroteEntryHtml = webPlan && toolEvents.some((e) => e && e.ok && e.createdNewFile
          && String(e.tool || '').toLowerCase() === 'write_file'
          && /(?:^|\/)index\.html?$/i.test(String(e.path || '')));
        if (wroteEntryHtml && autoOpen) {
          let res = null;
          try { res = await deps.invokeWorkspaceAction('runWorkspaceApp', {}); } catch (_) { }
          if (res && res.ok) {
            const url = String(res.output || '').trim();
            const where = /^https?:/i.test(url) ? `at ${url} in your browser` : (String(res.message || '').trim() || 'now');
            return {
              note: ` I opened the app for you — it's running ${where}. Use the Run button below (or ▶ above the file explorer) to open it again anytime.`,
              runHint: { kind: 'run', url: /^https?:/i.test(url) ? url : '' },
            };
          }
        }
        return {
          note: ' Click Run below (or the ▶ button above the file explorer) to open the app and check it.',
          runHint: { kind: 'run' },
        };
      };

      const isVerificationOnlyTask = () => /\b(?:are\s+you\s+sure|confirm|confirmed|verify|verified|check\s+(?:if|whether)|make\s+sure)\b/i
        .test(String(taskText || ''));

      const shouldSummarizeReadOnlyRun = () => agentHasUsefulInspectionEvidence()
        && isVerificationOnlyTask();

      const getLastUsefulAgentNarration = () => {
        for (let i = agentActivities.length - 1; i >= 0; i -= 1) {
          const activity = agentActivities[i];
          if (!activity) continue;
          const kind = String(activity.kind || '').toLowerCase();
          if (!['thought', 'message', 'summary'].includes(kind)) continue;
          const raw = activity.detail || activity.message || activity.title || '';
          const detail = deps.sanitizeAssistantText ? deps.sanitizeAssistantText(raw) : String(raw || '');
          const clean = String(detail || '').trim();
          if (!clean) continue;
          if (/^(?:thinking|still thinking|still working|preparing|reviewing|done|completed|finished)\.?$/i.test(clean)) continue;
          return clean;
        }
        return '';
      };

      const isWeakEditPlan = () => {
        if (String(planSpec && planSpec.taskKind || '').toLowerCase() !== 'edit') return false;
        const affectedFiles = Array.isArray(planSpec && planSpec.affectedFiles) ? planSpec.affectedFiles.filter(Boolean) : [];
        const doneCriteria = Array.isArray(planSpec && planSpec.doneCriteria) ? planSpec.doneCriteria.filter(Boolean) : [];
        return affectedFiles.length === 0 && doneCriteria.length === 0;
      };

      const planTextContainsRunRequirement = () => {
        const parts = [
          taskText,
          planSpec && planSpec.summary,
          planSpec && planSpec.validation,
          ...(Array.isArray(planSpec && planSpec.doneCriteria) ? planSpec.doneCriteria : []),
        ];
        return parts.some((part) => /\b(?:run|launch|start|test|open|verify)\b[\s\S]{0,80}\b(?:app|project|site|dev\s+server|browser|localhost|npm\s+run\s+dev)\b|\bnpm\s+run\s+dev\b/i.test(String(part || '')));
      };

      const isExplicitRunAppTask = () => planTextContainsRunRequirement();

      const hasRunAttempt = () => toolEvents.some((event) => (
        event
        && ['run_app', 'run_command'].includes(String(event.tool || '').toLowerCase())
      ));

      const isMutationTool = (tool) => ['new_project', 'write_file', 'edit_file', 'mkdir', 'move', 'delete'].includes(String(tool || '').toLowerCase());
      const normalizeDecisionPath = (value) => deps.normalizeWorkspacePath ? deps.normalizeWorkspacePath(value || '') : String(value || '');
      // read_files carries no `path`, so without a paths signature every call
      // shares one guard bucket — one malformed call blocked all later (valid,
      // different-target) batch reads and force-stopped a live run.
      const decisionPathsSignature = (decision) => {
        if (String(decision && decision.tool ? decision.tool : '').toLowerCase() !== 'read_files') return '';
        const raw = Array.isArray(decision && decision.paths)
          ? decision.paths.join(',')
          : String((decision && (decision.paths || decision.path || decision.content)) || '');
        return raw.toLowerCase().replace(/\s+/g, '').slice(0, 500);
      };
      const buildDecisionSignature = (decision) => ({
        tool: String(decision && decision.tool ? decision.tool : '').toLowerCase(),
        path: normalizeDecisionPath(decision && decision.path),
        srcPath: normalizeDecisionPath(decision && decision.srcPath),
        dstPath: normalizeDecisionPath(decision && decision.dstPath),
        offset: Number(decision && decision.offset || 0),
        startLine: Number(decision && decision.start_line || 0),
        endLine: Number(decision && decision.end_line || 0),
        pathsSig: decisionPathsSignature(decision),
        // run_command's identity is its command, not a path — every run_command
        // shares path '/'. Without this, a second, DIFFERENT command (e.g. `npx
        // prisma generate` after a blocked `node -e ...`) was flagged a duplicate
        // and the run dead-ended.
        command: String(decision && decision.command ? decision.command : '').trim(),
      });
      const hasWorkspaceMutationSince = (index) => {
        const start = Math.max(-1, Number(index));
        for (let i = start + 1; i < toolEvents.length; i += 1) {
          const event = toolEvents[i];
          if (!event || !event.ok) continue;
          if (isMutationTool(event.tool)) return true;
          // A successful terminal command changes the environment (npm install
          // creates node_modules/lockfile) — a run_app retry after it is NOT a
          // no-change duplicate (this exact case force-finalized a healthy run).
          if (String(event.tool || '').toLowerCase() === 'run_command') return true;
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
            && Number(event.endLine || 0) === signature.endLine
            && String(event.pathsSig || '') === signature.pathsSig
            && String(event.command || '').trim() === signature.command;
        });
        if (lastIndex < 0) return '';
        const lastEvent = toolEvents[lastIndex];
        if (!lastEvent) return '';
        if (signature.tool === 'read_file' && lastEvent.ok
          && lastEvent._fromBatchRead && lastEvent._batchPreviewClipped) {
          return '';
        }
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
        if (signature.tool === 'search_files' && lastEvent.ok && !hasWorkspaceMutationSince(lastIndex)
          && String(lastEvent.searchQuery || '') === String(decision && decision.content ? decision.content : '')) {
          return `search_files blocked: you already ran this exact search and nothing changed since — its result above stands (no matches MEANS the text is not in any file; stop looking for it). Act on what you know: make the edit or finalize.`;
        }
        if (['check_code', 'run_app'].includes(signature.tool) && lastEvent.ok && !hasWorkspaceMutationSince(lastIndex)) {
          return `${signature.tool} blocked: nothing changed since the last run — its results above still hold. Fix the reported errors (or finalize if everything was clean).`;
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
          // The overwrite guard explicitly permits the same complete write_file
          // once more as confirmation that a corrupted existing file genuinely
          // needs regeneration. Let that documented escape hatch reach the
          // executor instead of treating it as an ordinary no-progress duplicate.
          if (signature.tool === 'write_file'
            && /same complete write_file again|accepted as a deliberate full regeneration/i.test(String(lastEvent.observation || ''))) {
            return '';
          }
          if (signature.tool === 'edit_file') {
            const hasRefreshedRead = toolEvents.slice(lastIndex + 1).some((e) => (
              e && e.ok
              && String(e.tool || '').toLowerCase() === 'read_file'
              && normalizeDecisionPath(e.path || '') === signature.path
            ));
            if (hasRefreshedRead) return '';
          }
          // A retry with genuinely different payload is a new attempt, not a
          // duplicate — blocking it forced wrong-file redirects during recovery.
          if (['write_file', 'edit_file'].includes(signature.tool)) {
            const newContent = String(decision && decision.content ? decision.content : '').trim();
            const lastContent = String(lastEvent.content || '').trim();
            if (newContent && newContent !== lastContent) return '';
          }
          if (signature.tool === 'read_file' && /file not found/i.test(String(lastEvent.observation || ''))) {
            return `read_file blocked for ${signature.path || 'this file'}: it does not exist — re-reading cannot help. If it is a planned file, CREATE it now with write_file; otherwise take the next planned step.`;
          }
          return `${signature.tool} blocked for ${signature.path || signature.dstPath || signature.srcPath || 'this target'}: the same tool/target already failed and nothing changed since then. Follow the latest observation and choose a different corrective step.`;
        }
        return '';
      };
      // Redirects may be non-mutating, or same-file mutation→mutation only; never
      // escalate a blocked read into an edit (synthesized edits invent changes).
      const isSafeDuplicateRedirect = (fromDecision, fallbackDecision) => {
        const fallbackTool = String(fallbackDecision && fallbackDecision.tool ? fallbackDecision.tool : '').toLowerCase();
        if (!isMutationTool(fallbackTool)) return true;
        const fromTool = String(fromDecision && fromDecision.tool ? fromDecision.tool : '').toLowerCase();
        if (!isMutationTool(fromTool)) return false;
        const fromPath = normalizeDecisionPath(fromDecision && fromDecision.path);
        const fallbackPath = normalizeDecisionPath(fallbackDecision && fallbackDecision.path);
        return Boolean(fallbackPath) && fallbackPath === fromPath;
      };
      const hasSuccessfulNewProject = () => toolEvents.some((event) => (
        event && event.ok && String(event.tool || '').toLowerCase() === 'new_project'
      ));
      // (Removed: keyword-based "coordinated frontend edit" helpers — only the
      // deleted read-before-edit hijack used them.)
      const repairDecisionBeforeExecution = (decision, step) => {
        if (!decision || decision.action !== 'tool') return decision;
        // read_files deliberately previews large files to keep one batch inside the
        // context budget. Never let a model convert "preview ended" into a destructive
        // whole-file rewrite: ground that decision with one dedicated read_file first.
        if (String(decision.tool || '').toLowerCase() === 'write_file') {
          const targetPath = deps.normalizeWorkspacePath(decision.path || '');
          const batchReadIndex = findLastToolEventIndex((event) => (
            event && event.ok && event._fromBatchRead && event._batchPreviewClipped
            && deps.normalizeWorkspacePath(event.path || '') === targetPath
          ));
          const fullReadAfterBatch = batchReadIndex >= 0 && toolEvents.slice(batchReadIndex + 1).some((event) => (
            event && event.ok && String(event.tool || '').toLowerCase() === 'read_file'
            && !event._fromBatchRead && deps.normalizeWorkspacePath(event.path || '') === targetPath
          ));
          if (targetPath && batchReadIndex >= 0 && !fullReadAfterBatch) {
            recordDebugTrace('agent_batch_preview_rewrite_redirected', {
              chatId: String(chatId || ''), step: String(step), path: targetPath,
            }, { chatId: String(chatId || ''), step, originalDecision: decision });
            return {
              action: 'tool',
              tool: 'read_file',
              path: targetPath,
              content: '',
              srcPath: '',
              dstPath: '',
              message: `Read the complete ${targetPath} before deciding whether it needs replacement; the earlier batched output was only a clipped display preview.`,
              thought: `The batched view of ${targetPath} ended at its preview limit, not at end-of-file. Reading the complete file before any rewrite.`,
              raw: '[redirect-batch-preview-rewrite-to-full-read]',
              _deterministic: true,
            };
          }
        }
        // Coerce raw edit_file payloads only while creating planned project files.
        if (String(decision.tool || '').toLowerCase() === 'edit_file') {
          const rawContent = String(decision.content || '').trim();
          const looksLikeEditProgram = rawContent.startsWith('[') || rawContent.startsWith('{');
          const looksLikeInstruction = /^(?:fix|repair|update|change|replace|remove|add|make)\b/i.test(rawContent)
            || /validation issues|project contract|without adding placeholder/i.test(rawContent);
          const looksLikeRawCode = rawContent.length > 40 && !looksLikeEditProgram && !looksLikeInstruction;
          const isProjectCreation = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'project';
          const expectedFiles = Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : [];
          const targetPath = deps.normalizeWorkspacePath(decision.path || '');
          const isExpectedFile = expectedFiles.map((path) => deps.normalizeWorkspacePath(path || '')).includes(targetPath);
          // (Removed: two hijack doors lived here — "read all planned files before
          // any edit" and "repeat edit -> next planned file". Both discarded the
          // model's edit; the executor already requires the edit TARGET read.)
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

      setAgentProgress('Planning the approach...');
      if (typeof deps.syncWorkspaceStateFromNative === 'function') {
        await deps.syncWorkspaceStateFromNative('agent_start', { render: false });
      }
      // When the user explicitly approved creating a new project at preflight,
      // force project scope INSIDE the planner so expectedFiles/finalRequiresRealFiles
      // are derived coherently. (Just relabelling taskKind afterward produced an
      // "empty project is done" plan that finalized after new_project with no files.)
      const approvedNewProject = Boolean(requestToken && requestToken.approvedNewProject);
      planSpec = await deps.buildAgentPlanSpec(chatId, taskText, { forceProjectScope: approvedNewProject });
      // Hard provider failure while planning (credits/key) — stop, tell the user.
      if (planSpec && planSpec._planHardError) {
        deps.setThinkingStatus('');
        setAgentProgress('Stopped.');
        appendAgentActivity({
          kind: 'error',
          title: 'Inference unavailable',
          detail: String(planSpec._planHardError),
          status: 'error',
        });
        deps.consumeLiveAssistantText();
        const msg = `I couldn't plan this build — ${String(planSpec._planHardError)}`;
        deps.commitAssistantMessage(chatId, msg, msg, {
          agentActivities,
          agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: false }),
          forceNeedsContinue: true,
          inferenceFailure: true,
        });
        recordDebugTrace('agent_plan_hard_error', {
          chatId: String(chatId || ''),
          reason: deps.debugPreview(String(planSpec._planHardError), 240),
        }, { chatId: String(chatId || ''), planSpec });
        if (runLog) runLog.end({ errored: true, message: String(planSpec._planHardError) });
        return true;
      }
      // Safety net: if a planner ever returns a non-project plan despite the flag,
      // rebuild a coherent project plan rather than leaving derived fields stale.
      if (approvedNewProject && planSpec && String(planSpec.taskKind || '').toLowerCase() !== 'project'
        && typeof deps.buildFallbackAgentPlanSpec === 'function') {
        planSpec = deps.buildFallbackAgentPlanSpec(taskText, { chatId, forceProjectScope: true });
      }
      if (runLog && planSpec) runLog.emitPlan(planSpec);
      // Ride cross-run done-work on the plan so requirement checks and the
      // decision prompt see earlier runs' accomplishments (attach after emitPlan
      // so the plan log stays clean of the live Set/Map).
      if (planSpec) planSpec._priorRunDone = doneWork;
      // The chat's manual context rides in the contract so every prompt sees it.
      const chatManualContext = typeof deps.getChatManualContext === 'function'
        ? String(deps.getChatManualContext(chatId) || '').trim()
        : '';
      if (chatManualContext && planSpec) {
        planSpec.projectContract = [
          String(planSpec.projectContract || '').trim(),
          `USER CUSTOM INSTRUCTIONS (set in the app UI — follow for all files and decisions):\n${chatManualContext}`,
        ].filter(Boolean).join('\n\n');
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
        planSource: String(planSpec && planSpec._planSource || 'model'),
        planRaw: deps.debugPreview(String(planSpec && planSpec._planRaw || ''), 300),
        planPhases: String(planSpec && Array.isArray(planSpec.phases) ? planSpec.phases.length : 0),
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
      // .aiexe/plan.md is the cross-run source of truth; resume at first unfinished phase.
      let projectDisplayName = String(planSpec && planSpec.projectName || '');
      let planFileParsed = null;
      const readAgentPlanFilePhases = async () => {
        if (typeof deps.parseAgentPlanMarkdown !== 'function') return null;
        try {
          const res = await deps.invokeWorkspaceAction('workspaceReadFile', { path: '/.aiexe/plan.md' });
          if (!res || !res.ok) return null;
          const parsed = deps.parseAgentPlanMarkdown(String(res.output || ''));
          if (parsed && Array.isArray(parsed.phases) && parsed.phases.length) {
            planFileParsed = parsed;
            return parsed.phases;
          }
          return null;
        } catch (_) { return null; }
      };
      // Decide phased from plan.md (authoritative on a Continue/resume, even if the
      // re-planner dropped phases this turn) OR from the fresh plan (first run). On a
      // fresh non-resume request we ignore plan.md so an unrelated edit doesn't
      // resurrect the phase tracker.
      let planPhases = Array.isArray(planSpec && planSpec.phases)
        ? planSpec.phases.filter((p) => p && p.title) : [];
      // Phasing a <=3-file build is pure overhead (a landing page got a phased plan for
      // index.html + style.css); fresh plans only — a resume keeps plan.md's phases.
      // Also clear planSpec.phases: agent-core keys phasedProject off it independently.
      const plannedFileCount = Array.isArray(planSpec && planSpec.expectedFiles)
        ? planSpec.expectedFiles.filter(Boolean).length : 0;
      if (planPhases.length >= 2 && plannedFileCount > 0 && plannedFileCount <= 3) {
        planPhases = [];
        if (planSpec) planSpec.phases = [];
      }
      const isResume = Boolean(requestToken && requestToken.isAgentResume);
      const filePhases = await readAgentPlanFilePhases();
      const fileHasUnfinished = filePhases && filePhases.length >= 2
        && typeof deps.firstUnfinishedPhaseIndex === 'function'
        && deps.firstUnfinishedPhaseIndex(filePhases) >= 0;
      // Plan inference failed outright (provider unreachable/timed out). Without a
      // phased plan.md to resume, running on the heuristic fallback plan silently
      // builds the wrong thing — stop and tell the user instead. With a resumable
      // plan.md the run proceeds on it (fields restored below).
      const planInferFailed = /^fallback:(?:infer_fail|timeout)$/.test(String(planSpec && planSpec._planSource || ''));
      if (planInferFailed && !fileHasUnfinished) {
        const reason = String(planSpec && planSpec._planRaw || '').trim() || 'the inference provider did not respond';
        deps.setThinkingStatus('');
        setAgentProgress('Stopped.');
        appendAgentActivity({
          kind: 'error',
          title: 'Inference unavailable',
          detail: reason,
          status: 'error',
        });
        deps.consumeLiveAssistantText();
        const msg = `I couldn't plan this build — ${reason} Once the provider is reachable, send the request again.`;
        deps.commitAssistantMessage(chatId, msg, msg, {
          agentActivities,
          agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: false }),
          forceNeedsContinue: true,
          inferenceFailure: true,
        });
        recordDebugTrace('agent_plan_infer_failed_stop', {
          chatId: String(chatId || ''),
          reason: deps.debugPreview(reason, 240),
        }, { chatId: String(chatId || ''), planSpec });
        return true;
      }
      // plan.md wins when it has unfinished phases and we're still phased (resume OR the
      // fresh decompose is phased) — stops each Continue re-partitioning the plan.
      const preferPlanFile = Boolean(fileHasUnfinished && (isResume || planPhases.length >= 2));
      const phasesSource = preferPlanFile ? filePhases : planPhases;
      const phasedProjectRun = phasesSource.length >= 2;
      if (!phasedProjectRun) {
        // A non-phased run (e.g. a follow-up edit) must not show a stale phase tracker.
        if (typeof deps.clearAgentPhaseTracker === 'function') deps.clearAgentPhaseTracker(chatId);
        const planActivity = deps.buildAgentPlanActivity(planSpec);
        appendAgentActivity(planActivity);
        if (!planActivity && planSpec && planSpec.summary) {
          appendAgentNarration(planSpec.summary);
        }
      }
      if (phasedProjectRun) {
        const phases = preferPlanFile ? filePhases : (planPhases.length ? planPhases : filePhases);
        planSpec.phases = phases;
        // Every expected file must belong to SOME phase: files outside all phases
        // (index.html, src/main.tsx, src/App.tsx on a live run) silently never got
        // built and the "finished" project couldn't run. Entry/foundation files go
        // to the first phase, everything else to the last. Fresh plans only —
        // plan.md resumes keep their persisted contract.
        if (!preferPlanFile) {
          const covered = new Set(allPhaseFilePaths({ phases }, deps.normalizeWorkspacePath).map((p) => p.toLowerCase()));
          const missing = (Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles : [])
            .map((p) => deps.normalizeWorkspacePath(p || ''))
            .filter((p) => p && p !== '/' && /\.[A-Za-z0-9]+$/.test(p) && !covered.has(p.toLowerCase()));
          if (missing.length) {
            const foundationRe = /(?:^\/index\.html$|^\/src\/(?:main|app|index)\.[a-z]+$|^\/package\.json$|config\.[a-z]+$)/i;
            missing.forEach((p) => {
              const target = foundationRe.test(p) ? phases[0] : phases[phases.length - 1];
              if (!target) return;
              if (!Array.isArray(target.tasks)) target.tasks = [];
              target.tasks.push({ text: p, done: false });
            });
            recordDebugTrace('agent_phase_plan_completeness_fill', {
              chatId: String(chatId || ''),
              missing: deps.debugPreview(missing.join(' | '), 240),
            }, { chatId: String(chatId || ''), missing });
          }
        }
        // Resuming over plan.md: the Continue re-planner routinely produces a
        // degenerate file list (one random root file like /next-env.d.ts), which
        // starves prompts of the planned-file context (frameworkWeb detection,
        // sibling hints, planned-import advisories). plan.md is the source of
        // truth on resume — always restore the union of its phase files.
        if (preferPlanFile) {
          const phaseFiles = allPhaseFilePaths({ phases }, deps.normalizeWorkspacePath);
          if (phaseFiles.length) {
            // Case-insensitive union, plan.md casing first: a re-plan that
            // Sentence-cases paths (/Src/app/...) used to duplicate the whole list.
            const seenLower = new Set();
            const merged = [];
            [
              ...phaseFiles,
              ...(Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles : [])
                .map((p) => deps.normalizeWorkspacePath(p || '')).filter((p) => p && p !== '/'),
            ].forEach((p) => {
              const key = p.toLowerCase();
              if (!seenLower.has(key)) { seenLower.add(key); merged.push(p); }
            });
            planSpec.expectedFiles = merged;
            planSpec.affectedFiles = merged.slice();
          }
          // A fallback plan's heuristic name would also get force-rewritten into
          // plan.md's title — restore the persisted name for that case only.
          if (/^fallback/.test(String(planSpec._planSource || ''))) {
            const fileProjectName = String((planFileParsed && planFileParsed.projectName) || '').trim();
            if (fileProjectName) {
              planSpec.projectName = fileProjectName;
              projectDisplayName = fileProjectName;
            }
          }
        }
        // Repair legacy/model-authored phase casing against the authoritative
        // expected-file list. On Windows `/Src/app/layout.tsx` and
        // `/src/app/layout.tsx` are one file, but case-sensitive UI comparisons
        // treated them as separate deliverables and wrote the layout twice.
        const expectedCaseMap = new Map((Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles : [])
          .map((path) => deps.normalizeWorkspacePath(path || ''))
          .filter(Boolean)
          .map((path) => [path.toLowerCase(), path]));
        phases.forEach((phase) => {
          (Array.isArray(phase && phase.tasks) ? phase.tasks : []).forEach((task) => {
            if (!task) return;
            let text = String(task.text || task || '');
            extractFileLikeTaskPaths(text, deps.normalizeWorkspacePath).forEach((candidate) => {
              const canonical = expectedCaseMap.get(String(candidate || '').toLowerCase());
              if (!canonical || canonical === candidate) return;
              const from = String(candidate).replace(/^\//, '');
              const to = String(canonical).replace(/^\//, '');
              text = text.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), to);
            });
            if (typeof task === 'object') task.text = text;
          });
        });
        let activeIndex = typeof deps.firstUnfinishedPhaseIndex === 'function'
          ? deps.firstUnfinishedPhaseIndex(phases) : 0;
        if (activeIndex < 0) activeIndex = phases.length - 1;
        phaseState = { phases, activeIndex, diskPresent: new Set() };
        keepPhaseTrackerPinned = true;
        planSpec.taskKind = 'project'; // re-planner reclassifies Continue as 'edit'; force back
        const active = phases[activeIndex] || {};
        // Seed checklist from disk: earlier runs' files count without a re-touch.
        try {
          const seedTasks = (Array.isArray(active.tasks) ? active.tasks : [])
            .filter((t) => t && !t.done)
            .map((t) => ({
              task: t,
              paths: extractFileLikeTaskPaths(t.text || t, deps.normalizeWorkspacePath),
              globs: extractDirGlobTaskPrefixes(t.text || t, deps.normalizeWorkspacePath),
            }));
          const seedPaths = Array.from(new Set(seedTasks.flatMap((entry) => entry.paths))).slice(0, 24);
          for (const seedPath of seedPaths) {
            const res = await deps.invokeWorkspaceAction('workspaceReadFile', { path: seedPath });
            if (res && res.ok && String(res.output || '').trim()) phaseState.diskPresent.add(seedPath.toLowerCase());
          }
          // Glob tasks ("ui/*") tick when their folder already holds files on disk.
          const globDirsWithFiles = new Set();
          for (const globDir of Array.from(new Set(seedTasks.flatMap((entry) => entry.globs))).slice(0, 8)) {
            const res = await deps.invokeWorkspaceAction('workspaceList', { path: globDir });
            if (res && res.ok && /\[file\]/.test(String(res.output || ''))) globDirsWithFiles.add(globDir.toLowerCase());
          }
          seedTasks.forEach(({ task, paths, globs }) => {
            const filesPresent = paths.length && paths.every((p) => phaseState.diskPresent.has(p.toLowerCase()));
            const globsPresent = globs.length && globs.every((g) => globDirsWithFiles.has(g.toLowerCase()));
            if ((paths.length || globs.length) && (paths.length ? filesPresent : true) && (globs.length ? globsPresent : true)) {
              task.liveDone = true;
            }
          });
        } catch (_) { /* seeding is best-effort; live events still tick tasks */ }
        planSpec._activePhase = {
          number: activeIndex + 1,
          total: phases.length,
          title: String(active.title || ''),
          tasks: (Array.isArray(active.tasks) ? active.tasks : []).filter((t) => t && !t.done).map((t) => (
            t.liveDone
              ? `${t.text} — ALREADY BUILT by an earlier run (file exists). Do not recreate it; edit only if something in it needs fixing.`
              : t.text
          )),
        };
        // Harvest foundation vocab from earlier phases so this phase's pages reuse real
        // tokens/classes/components. Empty on phase 1 (nothing built yet). Best-effort.
        if (typeof deps.harvestFoundationVocabulary === 'function' && activeIndex > 0) {
          try {
            const allFiles = Array.isArray(planSpec.expectedFiles)
              ? planSpec.expectedFiles.map((p) => deps.normalizeWorkspacePath(p || '')).filter(Boolean) : [];
            const foundationPaths = allFiles.filter((p) => /\.(css|scss|sass|less)$/i.test(p)
              || /(?:^|\/)(?:components?|layout|shared|shell)\.[cm]?js$/i.test(p));
            const firstHtml = allFiles.find((p) => /\.html?$/i.test(p));
            if (firstHtml) foundationPaths.push(firstHtml);
            const foundationFiles = {};
            for (const fp of Array.from(new Set(foundationPaths)).slice(0, 8)) {
              const res = await deps.invokeWorkspaceAction('workspaceReadFile', { path: fp });
              if (res && res.ok && String(res.output || '').trim()) foundationFiles[fp] = String(res.output || '');
            }
            const vocab = deps.harvestFoundationVocabulary(foundationFiles);
            if (vocab) planSpec._foundationVocab = vocab;
          } catch (_) { /* best-effort; v5.2.0 prompt rules still steer reuse */ }
        }
        // No narration — the phase tracker UI shows the plan.
        if (typeof deps.setAgentPhaseTracker === 'function') {
          deps.setAgentPhaseTracker({
            chatId,
            projectName: projectDisplayName,
            phases,
            activeIndex,
            allDone: false,
          });
        }
        // Model-generated, phase-aware opening line (not hardcoded). Replaces the
        // generic summary so the user hears what THIS phase will do.
        try {
          const pendingTasks = (Array.isArray(active.tasks) ? active.tasks : [])
            .filter((t) => t && !t.done).map((t) => t.text);
          setAgentProgress(`${isResume ? 'Continuing' : 'Starting'} Phase ${activeIndex + 1}${active.title ? `: ${String(active.title).trim()}` : ''}...`);
          const ackPrompt = [
            'Write ONE short, natural, first-person sentence telling the user what you will do in this build phase.',
            'Output ONLY the sentence — no preamble, no quotes, no markdown, no labels.',
            activeIndex === 0 && !isResume
              ? 'This is the FIRST of several phases — say you are starting with this phase and will build the rest in later phases the user continues.'
              : `This is phase ${activeIndex + 1} of ${phases.length} — say you are continuing the build and what this phase adds.`,
            activeIndex > 0
              ? 'Reassure the user that you will REUSE the shared CSS and components already built (link them, no new per-page styles) so the design stays consistent.'
              : '',
            `Overall goal: ${String((planSpec && planSpec.summary) || taskText || '').trim()}`,
            `Phase ${activeIndex + 1} of ${phases.length}: ${String(active.title || '').trim()}`,
            pendingTasks.length ? `This phase covers: ${pendingTasks.join('; ')}` : '',
            'Sentence:',
          ].filter(Boolean).join('\n');
          const ackRes = await deps.requestAgentPlannerInference(ackPrompt, 160, '', '', { prose: true });
          if (ackRes && ackRes.ok) {
            let ack = String(deps.sanitizeAssistantText(String(ackRes.output || '')) || '')
              .split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
            ack = ack.replace(/^["'`]+|["'`]+$/g, '').trim();
            if (ack && !/^[{<[]/.test(ack)) {
              appendAgentNarration(ack);
              // The kickoff sentence IS the intro — don't let the deterministic
              // startup batch (new_project) add a second, blander one.
              deterministicBatchNarrated = true;
            }
          }
        } catch (_) { /* best-effort; the tracker still shows the phases */ }
      }

      // Harness-driven checklist from planSpec.doneCriteria (marked done mechanically).
      const checklistItems = Array.isArray(planSpec && planSpec.doneCriteria)
        ? planSpec.doneCriteria.filter(Boolean)
        : [];
      let lastChecklistSignature = '';
      let reviewNarrated = false;
      let planUpdatePending = false;
      let lastPlanUpdateSignature = '';
      const refreshChecklist = (finalizing = false, acceptedFinal = false) => {
        if (!checklistItems.length || typeof deps.computeAgentChecklistProgress !== 'function') return null;
        let progress = deps.computeAgentChecklistProgress(checklistItems, toolEvents, planSpec);
        // On a successful finish where work shipped AND at least one criterion already matched
        // (proving the change is on-topic), tick the rest — descriptive criteria for a single
        // change often share no keyword with the diff, so keyword matching leaves them stuck.
        // acceptedFinal is passed ONLY by the accepted-model-FINAL path; the out-of-steps /
        // timeout fallback must never force-tick items that were not actually done.
        if (finalizing) {
          const shipped = toolEvents.some((e) => e && e.ok
            && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase()));
          if ((shipped && progress.some((p) => p && p.done)) || acceptedFinal) {
            progress = progress.map((p) => ({ ...p, done: true }));
          }
        }
        const doneCount = progress.filter((p) => p && p.done).length;
        const allDone = doneCount >= progress.length && progress.length > 0;
        const signature = progress.map((p) => `${p.done ? '1' : '0'}:${p.text}`).join('|');
        // Narrate a review beat the moment everything's built, before ticking.
        if (allDone && !reviewNarrated) {
          reviewNarrated = true;
          appendAgentNarration('All files are in place — reviewing the plan to confirm every item is met.');
        }
        // Phased: tracker is the plan view; skip the duplicate flat "Plan N/N" card.
        if (phaseState) return { progress, doneCount, total: progress.length, remaining: progress.filter((p) => p && !p.done).map((p) => p.text), allDone };
        if (signature !== lastChecklistSignature) {
          lastChecklistSignature = signature;
          appendAgentActivity({
            kind: 'checklist',
            title: planUpdatePending ? 'Plan updated' : 'Plan',
            meta: `${doneCount}/${progress.length}`,
            items: progress.map((p) => ({ text: p.text, done: p.done })),
            status: 'done',
          });
          planUpdatePending = false;
        }
        return {
          progress,
          doneCount,
          total: progress.length,
          remaining: progress.filter((p) => p && !p.done).map((p) => p.text),
          allDone,
        };
      };
      refreshChecklist();

      const applyDecisionPlanUpdate = (decision, step) => {
        const items = String(decision && decision.planUpdate || '')
          .split('|')
          .map((item) => String(item || '').replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 5);
        if (items.length < 3) return false;
        const signature = items.join('\n');
        if (signature === lastPlanUpdateSignature) return false;
        lastPlanUpdateSignature = signature;
        checklistItems.splice(0, checklistItems.length, ...items);
        planSpec.doneCriteria = items.slice();
        planUpdatePending = true;
        lastChecklistSignature = '';
        refreshChecklist();
        recordDebugTrace('agent_plan_updated', {
          chatId: String(chatId || ''),
          step: String(step),
          items: String(items.length),
        }, { chatId: String(chatId || ''), step, items });
        return true;
      };
      // This is the agent run's activity label, not the adapter lifecycle.
      // Do not reset a useful phase label, and do not imply that an already
      // serving adapter is being started again for every user message.
      if (!phaseState) setAgentProgress(isResume ? 'Continuing...' : 'Working...');

      // .aiexe/plan.md = the phased build's source of truth (checkboxes are state).
      // Write it once the project workspace exists; opportunistic because the
      // workspace is created mid-run by the first create step.
      let planFileWritten = false;
      const ensureAgentPlanFile = async () => {
        if (planFileWritten || !phaseState) return;
        if (typeof deps.buildAgentPlanMarkdown !== 'function') return;
        const ws = typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() || {} : {};
        const rootReady = Boolean(ws.rootLoaded || String(ws.workspaceRootName || '').trim() || Number(ws.rootEntryCount) > 0);
        if (!rootReady) return;
        planFileWritten = true;
        try {
          await deps.invokeWorkspaceAction('workspaceMkdir', { path: '/.aiexe' });
          await deps.invokeWorkspaceAction('workspaceWriteFile', {
            path: '/.aiexe/plan.md',
            content: deps.buildAgentPlanMarkdown(planSpec),
          });
        } catch (_) {
          planFileWritten = false; // retry next step
        }
      };
      // Force-rewrite plan.md from planSpec.phases (tick boxes on phase completion).
      const persistAgentPlanFile = async () => {
        if (typeof deps.buildAgentPlanMarkdown !== 'function') return;
        try {
          await deps.invokeWorkspaceAction('workspaceMkdir', { path: '/.aiexe' });
          await deps.invokeWorkspaceAction('workspaceWriteFile', {
            path: '/.aiexe/plan.md',
            content: deps.buildAgentPlanMarkdown(planSpec),
          });
          planFileWritten = true;
        } catch (_) { /* best-effort */ }
      };
      // Tick the active phase done in plan.md, advance; returns next index (-1 = done).
      const completeActivePhase = async () => {
        if (!phaseState) return null;
        const idx = phaseState.activeIndex;
        const donePhase = phaseState.phases[idx] || { tasks: [] };
        const doneTasks = Array.isArray(donePhase.tasks) ? donePhase.tasks : [];
        doneTasks.forEach((t) => { if (t) t.done = true; });
        if (!doneTasks.length) donePhase.done = true;
        planSpec.phases = phaseState.phases;
        await persistAgentPlanFile();
        const nextIdx = deps.firstUnfinishedPhaseIndex(phaseState.phases);
        if (typeof deps.setAgentPhaseTracker === 'function') {
          deps.setAgentPhaseTracker({
            chatId,
            projectName: projectDisplayName,
            phases: phaseState.phases,
            activeIndex: nextIdx >= 0 ? nextIdx : phaseState.phases.length - 1,
            allDone: nextIdx < 0,
          });
        }
        if (nextIdx < 0) keepPhaseTrackerPinned = false;
        return { idx, donePhase, nextIdx };
      };
      const refreshPhaseLiveProgress = (rawPath) => {
        if (!phaseState || typeof deps.setAgentPhaseTracker !== 'function') return 0;
        const changed = markPhaseTaskLiveProgressForPath(phaseState, rawPath, deps.normalizeWorkspacePath);
        if (!changed) return 0;
        deps.setAgentPhaseTracker({
          chatId,
          projectName: projectDisplayName,
          phases: phaseState.phases,
          activeIndex: phaseState.activeIndex,
          allDone: false,
        });
        return changed;
      };
      const phasePathKnownPresent = (rawPath) => {
        const target = deps.normalizeWorkspacePath(rawPath || '');
        if (!target) return false;
        const comparableTarget = target.toLowerCase();
        // Files proven on disk at phase start count as present — without this, a
        // Continue run forced pointless re-reads (or rebuilds) of finished files
        // just to satisfy the phase gap check.
        if (phaseState && phaseState.diskPresent && phaseState.diskPresent.has(comparableTarget)) return true;
        return toolEvents.some((event) => {
          if (!event || event.ok === false) return false;
          const tool = String(event.tool || '').toLowerCase();
          if (!['read_file', 'write_file', 'edit_file'].includes(tool)) return false;
          if (String(event.structuralIssue || '').trim()) return false;
          return deps.normalizeWorkspacePath(event.path || '').toLowerCase() === comparableTarget;
        });
      };
      const getKnownActivePhaseFileTaskGaps = () => {
        if (!phaseState) return [];
        const tasks = Array.isArray(phaseState.phases[phaseState.activeIndex] && phaseState.phases[phaseState.activeIndex].tasks)
          ? phaseState.phases[phaseState.activeIndex].tasks
          : [];
        const before = tasks.map((task) => Boolean(task && task.liveDone)).join('|');
        const gaps = getActivePhaseFileTaskGaps(phaseState, deps.normalizeWorkspacePath, phasePathKnownPresent);
        const after = tasks.map((task) => Boolean(task && task.liveDone)).join('|');
        if (before !== after && typeof deps.setAgentPhaseTracker === 'function') {
          deps.setAgentPhaseTracker({
            chatId,
            projectName: projectDisplayName,
            phases: phaseState.phases,
            activeIndex: phaseState.activeIndex,
            allDone: false,
          });
        }
        return gaps;
      };
      const hasValidationPassedSinceLatestMutation = () => {
        let latestMutation = -1;
        let latestValidation = null;
        let latestValidationIndex = -1;
        for (let i = 0; i < toolEvents.length; i += 1) {
          const event = toolEvents[i];
          if (!event) continue;
          const tool = String(event.tool || '').toLowerCase();
          if (event.ok && ['write_file', 'edit_file'].includes(tool)) latestMutation = i;
          if (tool === 'validate_files') {
            latestValidation = event;
            latestValidationIndex = i;
          }
        }
        return Boolean(latestValidation && latestValidationIndex > latestMutation && latestValidation.validationPassed === true);
      };
      const latestValidationFailureSinceLatestMutation = () => {
        let latestMutation = -1;
        let latestValidation = null;
        let latestValidationIndex = -1;
        for (let i = 0; i < toolEvents.length; i += 1) {
          const event = toolEvents[i];
          if (!event) continue;
          const tool = String(event.tool || '').toLowerCase();
          if (event.ok && ['write_file', 'edit_file'].includes(tool)) latestMutation = i;
          if (tool === 'validate_files') {
            latestValidation = event;
            latestValidationIndex = i;
          }
        }
        if (latestValidation && latestValidationIndex > latestMutation && latestValidation.validationPassed === false) return latestValidation;
        return null;
      };
      // Per-run mutation budget (sized to the phase's sub-tasks) so one run can't
      // build everything and time out.
      const phaseMutationBudget = () => {
        if (!phaseState) return Infinity;
        const tasks = Array.isArray(phaseState.phases[phaseState.activeIndex] && phaseState.phases[phaseState.activeIndex].tasks)
          ? phaseState.phases[phaseState.activeIndex].tasks : [];
        return Math.max(3, tasks.length);
      };
      const countRunMutations = () => toolEvents.filter((e) => e && e.ok
        && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase())).length;

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
        await ensureAgentPlanFile();
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
          totalTimedOut = true;
          if (runLog) runLog.emit('note', 'completed', { kind: 'total_timeout', elapsedMs: Date.now() - startedAt });
          // Keep a live status through the wrap-up — "Stopped." with a hidden
          // 2-minute completion call behind it reads as a frozen app.
          setAgentProgress('Out of time — writing the wrap-up...');
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
          if (runLog) runLog.emitDecision(step, 'deterministic', decision);
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
          // Contextual decide label: the user should see WHERE the run is, not a
          // generic "Thinking..." between every tool.
          setAgentProgress('Working...');
          let plannerHeartbeatTimer = 0;
          const startPlannerHeartbeat = () => {
            if (plannerHeartbeatTimer) return;
            const started = Date.now();
            plannerHeartbeatTimer = setInterval(() => {
              const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000));
              if (elapsed >= 20) {
                // Ticking elapsed time: a 40s+ slow-provider wait reads as alive,
                // not frozen (a static label looked like a hang).
                setAgentProgress(`Still working — ${elapsed}s...`);
              }
            }, 5000);
          };
          const stopPlannerHeartbeat = () => {
            if (!plannerHeartbeatTimer) return;
            clearInterval(plannerHeartbeatTimer);
            plannerHeartbeatTimer = 0;
          };
          const decisionPrompt = await deps.buildAgentDecisionPrompt(chatId, taskText, toolEvents, step, planSpec);
          agentPrompt = decisionPrompt && decisionPrompt.prompt ? decisionPrompt.prompt : decisionPrompt;
          const decisionSystemPrompt = (decisionPrompt && decisionPrompt.systemPrompt) || '';
          // A single transient inference failure (e.g. "API unavailable — check
          // your connection") used to kill the whole run. Retry a couple of times
          // with short backoff so a momentary network/provider blip is survived.
          // We do NOT retry timeouts (the model was simply too slow — retrying
          // burns another full timeout) or user cancellations.
          let res = null;
          startPlannerHeartbeat();
          try {
          // Cap; rate-limits (429) use the full budget with exponential backoff,
          // other transient blips bail after a couple of quick retries.
          const maxInferenceRetries = 4;
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
            const retriable = Boolean(res && !res.ok && !res.timedOut && !res.hardFail && !res.nonRetriable);
            if (!retriable) break;
            // A 429 means the provider is throttling, not broken — it clears on its
            // own. Each retry is itself a request, and Venice blocks for 30s after
            // 20 failed requests in 30s, so we retry FEW times with LONG waits:
            // honor the provider's retry-after header when present, else 10s/20s/40s.
            const isRateLimit = Boolean(res && (res.httpStatus === 429
              || /rate.?limit|too many requests/i.test(String(res.message || ''))));
            const attemptCap = isRateLimit ? 3 : 2;
            if (attempt >= attemptCap) break;
            const headerMs = Number(res && res.retryAfterMs) || 0;
            const delayMs = isRateLimit
              ? (headerMs > 0 ? headerMs + 500 : Math.min(10000 * Math.pow(2, attempt), 45000))
              : 1200 * (attempt + 1);
            recordDebugTrace('agent_infer_retry', {
              chatId: String(chatId || ''), step: String(step), attempt: String(attempt + 1),
              reason: deps.debugPreview((res && res.message) || 'inference failed', 160),
            }, { chatId: String(chatId || ''), step, attempt: attempt + 1, rateLimited: isRateLimit, delayMs, reason: String((res && res.message) || 'inference failed') });
            setAgentProgress(isRateLimit
              ? `Provider is rate-limiting — waiting ${Math.round(delayMs / 1000)}s (retry ${attempt + 1})...`
              : `Reconnecting (retry ${attempt + 1})...`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (!deps.isInferenceActive(requestToken)) return true;
          }

          } finally {
            stopPlannerHeartbeat();
          }

          if (!deps.isInferenceActive(requestToken)) return true;
          if (!res || !res.ok) {
            if (runLog) runLog.emitDecisionFailure(step, (res && res.message) || 'agent infer failed', Boolean(res && res.timedOut));
            // Cut-off inline-file decision: salvage tool+path from the truncated
            // head; the content step regenerates the file.
            if (res && res.outputLimitExceeded) {
              const head = String(res.output || '').slice(0, 3000);
              const toolMatch = head.match(/"tool"\s*:\s*"(write_file|edit_file)"/);
              const pathMatch = head.match(/"path"\s*:\s*"(\/[^"\\]+)"/);
              if (toolMatch && pathMatch) {
                const msgMatch = head.match(/"message"\s*:\s*"([^"\\]{1,180})/);
                recordDebugTrace('agent_decision_output_limit_salvaged', {
                  chatId: String(chatId || ''), step: String(step), tool: toolMatch[1], path: pathMatch[1],
                }, { chatId: String(chatId || ''), step, tool: toolMatch[1], path: pathMatch[1], rawPreview: deps.debugPreview(head, 300) });
                res = {
                  ok: true,
                  output: JSON.stringify({ action: 'tool', tool: toolMatch[1], path: pathMatch[1], message: (msgMatch && msgMatch[1]) || '' }),
                  provider: res.provider,
                  model: res.model,
                };
              }
            }
            // A cut-off FINAL decision needs no retry: its only payload is the prose
            // summary, and a summary missing its last few words is still a fine
            // summary. Salvage it instead of re-asking — a re-ask just rewords the
            // final and burns 2-3 more Venice requests (the DOM scrape snapshots
            // before Venice renders the closing brace). Tool decisions still retry:
            // a truncated path/content is genuinely unusable.
            if (res && !res.ok && !res.timedOut && !res.hardFail
                && /structured stream ended (?:with incomplete JSON|without a complete JSON object)/i.test(String(res.message || ''))) {
              const raw = String(res.output || '');
              const actionMatch = raw.match(/"action"\s*:\s*"(\w+)"/);
              if (actionMatch && actionMatch[1] === 'final') {
                const msgMatch = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
                let salvaged = msgMatch ? msgMatch[1].replace(/\\+$/, '') : '';
                try { salvaged = JSON.parse('"' + salvaged + '"'); } catch (_) { /* keep the literal partial */ }
                salvaged = String(salvaged || '').trim();
                if (salvaged) {
                  recordDebugTrace('agent_incomplete_final_salvaged', {
                    chatId: String(chatId || ''), step: String(step),
                  }, { chatId: String(chatId || ''), step, rawPreview: deps.debugPreview(raw, 300) });
                  res = {
                    ok: true,
                    output: JSON.stringify({ action: 'final', message: salvaged }),
                    provider: res.provider,
                    model: res.model,
                  };
                }
              }
            }
          }
          if (!res || !res.ok) {
            // The model inlined a whole file into the decision JSON and blew the
            // structured-output cap. Retrying the same prompt would overflow again —
            // steer it to the correct shape instead of killing the run.
            if (res && res.outputLimitExceeded && outputLimitNudges < 2) {
              outputLimitNudges += 1;
              toolEvents.push({
                tool: '_invalid_output',
                ok: false,
                path: '',
                observation: 'Your reply was cut off: it exceeded the per-step output limit because it inlined an entire file into the decision JSON. NEVER put whole-file content in a decision. Reply with ONLY the small decision object — e.g. {"action":"tool","tool":"edit_file","path":"/style.css"} with NO content field — and the harness will collect the actual file changes in a separate dedicated step that has a much larger budget.',
              });
              recordDebugTrace('agent_decision_output_limit_recovered', {
                chatId: String(chatId || ''),
                step: String(step),
                nudge: String(outputLimitNudges),
              }, { chatId: String(chatId || ''), step, nudge: outputLimitNudges, rawPreview: deps.debugPreview(String(res.output || ''), 240) });
              setAgentProgress('Continuing...');
              continue;
            }
            // Venice occasionally ends a structured planner stream mid-object even
            // after its transport retries. This is not a workspace blocker: retain
            // every completed tool result and ask for one tiny decision again instead
            // of terminating a long repair run and making the user press Continue.
            const incompleteStructuredJson = Boolean(res && !res.timedOut && !res.hardFail
              && /structured stream ended (?:with incomplete JSON|without a complete JSON object)/i.test(String(res.message || '')));
            if (incompleteStructuredJson && incompleteJsonNudges < 2) {
              incompleteJsonNudges += 1;
              toolEvents.push({
                tool: '_invalid_output',
                ok: false,
                path: '',
                observation: 'The provider cut off your previous structured decision. Continue from the saved tool results. Return ONLY one short decision JSON object with action/tool/path; do not include file content or repeat a file that was already written successfully.',
              });
              recordDebugTrace('agent_incomplete_json_recovered', {
                chatId: String(chatId || ''),
                step: String(step),
                nudge: String(incompleteJsonNudges),
              }, { chatId: String(chatId || ''), step, nudge: incompleteJsonNudges, reason: String(res.message || '') });
              setAgentProgress('Structured reply was cut off — continuing from saved work...');
              continue;
            }
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
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: false }),
              forceNeedsContinue: true,
              inferenceFailure: true,
            });
            if (runLog) runLog.end({ errored: !(res && res.timedOut), timedOut: Boolean(res && res.timedOut), message: (res && res.message) || 'agent step failed' });
            return true;
          }

          // Consecutive-failure caps: reset on every good decision.
          outputLimitNudges = 0;
          incompleteJsonNudges = 0;
          rawPlannerOutput = String(res.output || '');
          decision = deps.parseAgentDecision(rawPlannerOutput);
          if (runLog && decision) runLog.emitDecision(step, 'model', decision);
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
              if (runLog && decision) runLog.emitDecision(step, 'repair', decision);
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
            if (runLog) runLog.emitDecision(step, 'fallback', decision);
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
            agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: false }),
            forceNeedsContinue: true,
            inferenceFailure: true,
          });
          return true;
        }

        decision = repairDecisionBeforeExecution(decision, step);
        decision.path = normalizeDecisionPath(decision.path || '');
        decision.srcPath = normalizeDecisionPath(decision.srcPath || '');
        decision.dstPath = normalizeDecisionPath(decision.dstPath || '');
        applyDecisionPlanUpdate(decision, step);

        if (phaseState && decision.action === 'tool' && String(decision.tool || '').toLowerCase() === 'validate_files') {
          const missingPhaseFiles = getKnownActivePhaseFileTaskGaps();
          if (missingPhaseFiles.length) {
            const missing = missingPhaseFiles[0];
            decision = {
              action: 'tool',
              tool: 'write_file',
              path: missing.path,
              content: '',
              command: '',
              srcPath: '',
              dstPath: '',
              message: `Create ${missing.path} before validating Phase ${phaseState.activeIndex + 1}.`,
              thought: `Phase ${phaseState.activeIndex + 1} is missing ${missing.path}; write it before validation.`,
              raw: '[phase-missing-file-before-validate]',
              _deterministic: true,
            };
            recordDebugTrace('agent_phase_validate_redirected_to_missing_file', {
              chatId: String(chatId || ''),
              step: String(step),
              path: missing.path,
            }, { chatId: String(chatId || ''), step, missingPhaseFiles });
          }
        }

        // Drop the transient live-stream copy of the planner output before committing
        // decision.thought — otherwise the same sentence renders twice (once sanitized).
        deps.consumeLiveAssistantText();
        if (!decision._deterministic) {
          const isFinal = decision.action === 'final' || String(decision.tool || '').toLowerCase() === 'none';
          // Narrate only the model's own thought; synthesized "Writing X" leaked on blocked writes.
          const finalThought = isFinal && /(?:validation passed|validat(?:e|ion)|finaliz|mark(?:ing)? .*complete|complete and verified|all .*deliverables)/i.test(String(decision.thought || ''))
            ? decision.thought
            : '';
          const narration = isFinal ? finalThought : (decision.thought || decision.message || '');
          if (narration) appendAgentNarration(narration);
        } else if (!deterministicBatchNarrated) {
          const batchThought = decision.thought || decision.message || buildDeterministicStartupNarration(decision);
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
            _guardBlock: true,
            _guardKind: 'duplicate_no_progress',
            _guardSignature: JSON.stringify(buildDecisionSignature(decision)),
            path: normalizeDecisionPath(decision.path || ''),
            srcPath: normalizeDecisionPath(decision.srcPath || ''),
            dstPath: normalizeDecisionPath(decision.dstPath || ''),
            content: '',
            offset: Number(decision.offset || 0),
            startLine: Number(decision.start_line || 0),
            endLine: Number(decision.end_line || 0),
            pathsSig: decisionPathsSignature(decision),
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
            if (((finalCheck && finalCheck.ok) || onlyValidationMissing) && !isWeakEditPlan()
              && agentHasWorkspaceMutations()) {
              const unmetCriteria = await getUnmetCriteriaNudge();
              if (unmetCriteria) {
                pushCriteriaNudgeObservation(unmetCriteria);
                continue;
              }
              setAgentProgress('Preparing the summary...');
              const finalText = await deps.generateAgentCompletionText(taskText, toolEvents, getWorkspaceLabel(), planSpec);
              if (agentHasWorkspaceMutations()) {
                await deps.refreshWorkspaceTree(true);
              }
              deps.consumeLiveAssistantText();
              deps.commitAssistantMessage(chatId, finalText, finalText, {
                agentActivities,
                agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
          if (duplicateTool !== 'edit_file') {
            const duplicatePath = normalizeDecisionPath(decision.path || '');
            const duplicateBlockedCount = toolEvents.filter((event) => (
              event
              && !event.ok
              && event._guardKind === 'duplicate_no_progress'
              && event._guardSignature === JSON.stringify(buildDecisionSignature(decision))
            )).length;
            if (duplicateBlockedCount >= 2) {
              const targetLabel = (duplicatePath && duplicatePath !== '/')
                ? ` for ${duplicatePath}`
                : (normalizeDecisionPath(decision.dstPath || '') || normalizeDecisionPath(decision.srcPath || '')
                  ? ` for ${normalizeDecisionPath(decision.dstPath || '') || normalizeDecisionPath(decision.srcPath || '')}` : '');
              const stepLabel = duplicateTool === 'run_app' ? 'running the app'
                : duplicateTool === 'run_command' ? 'the terminal command'
                : duplicateTool === 'validate_files' ? 'validation'
                : 'that step';
              const blockerNote = `Note: I stopped because ${stepLabel}${targetLabel} kept hitting the same blocker, and repeating it without a change would not help.`;
              const blockedText = await buildStoppedWithWorkText(blockerNote);
              setAgentProgress('Stopped.');
              deps.consumeLiveAssistantText();
              deps.commitAssistantMessage(chatId, blockedText, blockedText, {
                agentActivities,
                agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: false }),
                forceNeedsContinue: true,
              });
              recordDebugTrace('agent_done', {
                chatId: String(chatId || ''),
                step: String(step),
                fallback: 'true',
                reason: 'duplicate_non_edit_target_blocker',
              }, {
                chatId: String(chatId || ''),
                step,
                fallback: true,
                reason: 'duplicate_non_edit_target_blocker',
                duplicateTool,
                duplicatePath,
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
              if (!sameTarget && isSafeDuplicateRedirect(decision, fallbackDecision)) {
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
                // The model's narration already rendered for the OLD target.
                appendAgentNarration(`That's already handled — moving to ${deps.normalizeWorkspacePath(fallbackDecision.path || '') || 'the next step'}.`);
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
                && event._guardKind === 'duplicate_no_progress'
                && event._guardSignature === JSON.stringify(buildDecisionSignature(decision))
              )).length;
              if (duplicateBlockedCount >= 2) {
                const blockerNote = duplicateTool === 'edit_file'
                  ? `Note: I stopped before fully wrapping up because editing ${duplicatePath || 'the target file'} kept hitting the same blocker. If anything still looks off there, press Continue or tell me what to change.`
                  : `Note: I stopped because ${duplicatePath || 'that file'} was already read and no workspace changes happened after it. Press Continue if something is still missing.`;
                const blockedText = await buildStoppedWithWorkText(blockerNote);
                setAgentProgress('Stopped.');
                deps.consumeLiveAssistantText();
                deps.commitAssistantMessage(chatId, blockedText, blockedText, {
                  agentActivities,
                  agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: false }),
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
            if (!sameTarget && isSafeDuplicateRedirect(decision, fallbackDecision)) {
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
              appendAgentNarration(`That's already handled — moving to ${deps.normalizeWorkspacePath(fallbackDecision.path || '') || 'the next step'}.`);
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

        // Validation is a deterministic harness responsibility. If a phased
        // project has all files and the model tries to finish, run the check now
        // instead of asking the model the same question again every step.
        if (shouldForcePhaseValidation(
          decision,
          phaseState,
          getKnownActivePhaseFileTaskGaps(),
          latestValidationFailureSinceLatestMutation(),
          hasValidationPassedSinceLatestMutation(),
        )) {
          decision = {
            action: 'tool',
            tool: 'validate_files',
            path: '/',
            message: 'Checking the phase files before finishing.',
            _deterministic: true,
          };
          recordDebugTrace('agent_phase_validation_forced', {
            chatId: String(chatId || ''), step: String(step),
            phase: String(phaseState.activeIndex + 1),
          }, { chatId: String(chatId || ''), step, phaseState, toolEvents });
        }

        if (decision.action !== 'tool' || decision.tool === 'none') {
          // Don't accept a finish (incl. a no-op tool:none) over an unrepaired run_app
          // failure — push the errors back and force a real repair attempt. (This is
          // exactly where the agent used to bail with a dangling "Inspecting…" note.)
          const runErr = unresolvedRunAppError();
          if (runErr && runAppFinishNudges < 2) {
            runAppFinishNudges += 1;
            const obs = String(runErr.observation || '').slice(0, 600);
            toolEvents.push({
              tool: 'final_check',
              ok: false,
              observation: `Don't finish yet — run_app reported startup/build error(s) that are not fixed:\n${obs}\nRead the failing file(s), apply a real fix, then run_app again to verify. For Vite/React projects, keep the module setup and fix the reported build/runtime error instead of converting scripts to classic browser scripts.`,
            });
            recordDebugTrace('agent_run_app_finish_blocked', {
              chatId: String(chatId || ''), step: String(step), attempt: String(runAppFinishNudges),
            }, { chatId: String(chatId || ''), step, runErr });
            setAgentProgress('Reviewing...');
            continue;
          }
          // Whole-project completion advisories are scoped to the FULL build — they
          // wrongly flag a phased run's early phase as "incomplete" and push the
          // model to build everything at once. Skip them for phased builds (the
          // phase scope governs completion); the runtime-error nudge above still runs.
          const finalCheck = phaseState ? { ok: true, missing: [] } : deps.validateAgentFinalDecision(taskText, toolEvents, planSpec);
          // Advisory gate (not a veto): on the first finish attempt with planned
          // items still unmet, surface them as a tool observation and let the
          // model decide. We never override its decision or hard-stop on this.
          const skipStaleFinalAdvisory = Boolean(
            agentHasWorkspaceMutations()
            && hasValidationPassedSinceLatestMutation()
            && isWeakEditPlan()
          );
          if (!finalCheck.ok && finalNudges < 1 && !skipStaleFinalAdvisory) {
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
          const unmetCriteria = phaseState ? null : await getUnmetCriteriaNudge();
          if (unmetCriteria) {
            pushCriteriaNudgeObservation(unmetCriteria);
            continue;
          }
          // Phased: a model FINAL ends the current phase, not the project.
          if (phaseState && typeof deps.firstUnfinishedPhaseIndex === 'function') {
            const missingPhaseFiles = getKnownActivePhaseFileTaskGaps();
            if (missingPhaseFiles.length) {
              const missing = missingPhaseFiles[0];
              toolEvents.push({
                tool: 'final_check',
                ok: false,
                observation: `Do not finish Phase ${phaseState.activeIndex + 1} yet. This phase still needs ${missingPhaseFiles.map((g) => g.text || g.path).join('; ')}. Create the next missing file now with write_file: ${missing.path}.`,
              });
              recordDebugTrace('agent_phase_final_missing_files_blocked', {
                chatId: String(chatId || ''), step: String(step),
                phase: String(phaseState.activeIndex + 1),
                nextPath: missing.path,
              }, { chatId: String(chatId || ''), step, missingPhaseFiles, phaseState });
              setAgentProgress('Building this phase...');
              continue;
            }
            const validationFailure = latestValidationFailureSinceLatestMutation();
            if (validationFailure) {
              const issue = Array.isArray(validationFailure.validationIssues) && validationFailure.validationIssues.length
                ? String(validationFailure.validationIssues[0] || '')
                : String(validationFailure.observation || '').slice(0, 240);
              toolEvents.push({
                tool: 'final_check',
                ok: false,
                observation: `Do not finish Phase ${phaseState.activeIndex + 1} yet. The latest validate_files check still failed${issue ? `: ${issue}` : ''}. Fix the specific issue with edit_file, then validate again.`,
              });
              recordDebugTrace('agent_phase_final_failed_validation_blocked', {
                chatId: String(chatId || ''), step: String(step),
                phase: String(phaseState.activeIndex + 1),
                issue: deps.debugPreview(issue, 260),
              }, { chatId: String(chatId || ''), step, validationFailure, phaseState });
              setAgentProgress('Repairing...');
              continue;
            }
            if (!hasValidationPassedSinceLatestMutation()) {
              toolEvents.push({
                tool: 'final_check',
                ok: false,
                observation: `Do not finish Phase ${phaseState.activeIndex + 1} yet. Run validate_files once after the phase files are written, then finish only if it passes.`,
              });
              recordDebugTrace('agent_phase_final_needs_validation', {
                chatId: String(chatId || ''), step: String(step),
                phase: String(phaseState.activeIndex + 1),
              }, { chatId: String(chatId || ''), step, phaseState, toolEvents });
              setAgentProgress('Checking files...');
              continue;
            }
            // No files written this run → don't complete the phase; push to build.
            if (countRunMutations() === 0 && phaseEmptyFinalNudges < 2) {
              phaseEmptyFinalNudges += 1;
              const activeP = phaseState.phases[phaseState.activeIndex] || {};
              const pendingTasks = (Array.isArray(activeP.tasks) ? activeP.tasks : [])
                .filter((t) => t && !t.done).map((t) => t.text);
              toolEvents.push({
                tool: 'final_check',
                ok: false,
                observation: `You are on Phase ${phaseState.activeIndex + 1} (${activeP.title}) but have NOT created any files this run — reading existing pages is not enough. This phase's deliverables are NEW pages/files that DO NOT EXIST yet: ${pendingTasks.join('; ') || activeP.title}. Create each one now with write_file (build the real page, matching the existing site's design/header/footer), then finish. Do NOT respond that the project is already complete or offer a written plan — earlier phases only built part of the site.`,
              });
              recordDebugTrace('agent_phase_empty_final_nudge', {
                chatId: String(chatId || ''), step: String(step),
                phase: String(phaseState.activeIndex + 1), attempt: String(phaseEmptyFinalNudges),
              }, { chatId: String(chatId || ''), step, pendingTasks });
              setAgentProgress('Building this phase...');
              continue;
            }
            // Still nothing after nudges — stop for Continue-retry, don't false-complete.
            if (countRunMutations() === 0) {
              const activeP = phaseState.phases[phaseState.activeIndex] || {};
              setAgentProgress('Stopped.');
              deps.consumeLiveAssistantText();
              const msg = `This phase didn't get built — Phase ${phaseState.activeIndex + 1}${activeP.title ? ` (${activeP.title})` : ''} still needs its pages. Press **Continue** to build Phase ${phaseState.activeIndex + 1} again.`;
              deps.commitAssistantMessage(chatId, msg, msg, {
                agentActivities,
                agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
                forceNeedsContinue: true,
              });
              recordDebugTrace('agent_phase_no_work', {
                chatId: String(chatId || ''), step: String(step), phase: String(phaseState.activeIndex + 1),
              }, { chatId: String(chatId || ''), step, phaseState });
              return true;
            }
            const res = await completeActivePhase();
            if (res && res.nextIdx >= 0) {
              const nextPhase = phaseState.phases[res.nextIdx] || {};
              setAgentProgress('Phase complete.');
              let phaseMsg = deps.sanitizeAssistantText(decision.message || '') || '';
              const handoff = buildPhaseHandoffMessage(res.idx, res.donePhase.title, res.nextIdx, nextPhase.title, { forwardOnly: Boolean(phaseMsg) });
              phaseMsg = phaseMsg ? `${phaseMsg}\n\n${handoff}` : handoff;
              if (agentHasWorkspaceMutations()) {
                await deps.refreshWorkspaceTree(true);
              }
              deps.consumeLiveAssistantText();
              deps.commitAssistantMessage(chatId, phaseMsg, phaseMsg, {
                agentActivities,
                agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
                forceNeedsContinue: true,
              });
              recordDebugTrace('agent_phase_complete', {
                chatId: String(chatId || ''),
                step: String(step),
                phase: String(res.idx + 1),
                next: String(res.nextIdx + 1),
              }, { chatId: String(chatId || ''), step, phaseState, toolEvents });
              return true;
            }
            // Last phase done — tracker faded by completeActivePhase; fall through.
          }
          // Honor the model's final decision: requirements met, or it reaffirmed
          // finishing after the single advisory nudge.
          setAgentProgress('Preparing the summary...');
          const rawFinalText = deps.sanitizeAssistantText(decision.message || '').trim();
          const isWeakFinalText = !rawFinalText || /^(?:done|completed|fixed|finished)\.?$/i.test(rawFinalText);
          let finalText = rawFinalText;
          if (isWeakFinalText && (agentHasWorkspaceMutations() || shouldSummarizeReadOnlyRun())) {
            finalText = String(await deps.generateAgentCompletionText(taskText, toolEvents, getWorkspaceLabel(), planSpec) || '').trim();
          }
          finalText = finalText || getLastUsefulAgentNarration() || (agentHasWorkspaceMutations()
            ? 'Updated the project files.'
            : 'I checked the workspace and summarized what I found.');
          // If run_app still reports errors after the repair attempts, never end on a
          // clean message — disclose it and force Continue.
          const stillBrokenRun = unresolvedRunAppError();
          if (stillBrokenRun) {
            finalText += ' Note: the app still shows a startup error — press Continue and I\'ll keep working on it.';
          }
          // Tell the user WHERE to check the result (auto-open / Run button);
          // never auto-open an app that still crashes on startup.
          let finishRunHint = null;
          if (!stillBrokenRun) {
            const surface = await buildFinishRunSurface({ autoOpen: true });
            if (surface.note) finalText += surface.note;
            finishRunHint = surface.runHint;
          }
          refreshChecklist(true, !stillBrokenRun);
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.consumeLiveAssistantText();
          deps.commitAssistantMessage(chatId, finalText, finalText, {
            agentActivities,
            agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true, runHint: finishRunHint }),
            forceNeedsContinue: Boolean(stillBrokenRun),
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

        // Route through appendAgentNarration (sanitize + dedupe). A raw append here
        // leaked "edit_file" etc.: humanization changed the copy narrated earlier,
        // so the exact-duplicate merge no longer dropped this one.
        if (decision.thought) appendAgentNarration(decision.thought);

        // Polish-loop breakers: after a clean write, reading it back or rewriting
        // it whole is churn unless something actually failed since.
        const lastWriteWithoutFailureSince = (path) => {
          let sawCleanWrite = false;
          for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
            const event = toolEvents[i];
            if (!event || event._guardBlock) continue;
            const sinceTool = String(event.tool || '').toLowerCase();
            // Validation/run failures carry no matching path but ARE failures
            // since the write — without this the guard deadlocks every repair.
            if (sinceTool === 'validate_files' && event.validationPassed === false) {
              const issues = Array.isArray(event.validationIssues) ? event.validationIssues : [];
              if (!issues.length || issues.some((issue) => String(issue || '').includes(path))) return false;
            }
            if (sinceTool === 'run_app' && (!event.ok || Number(event.runErrorCount) > 0)) return false;
            if (deps.normalizeWorkspacePath(event.path || '') !== path) continue;
            if (!event.ok) return false;
            const eventTool = String(event.tool || '').toLowerCase();
            if (eventTool === 'write_file') { sawCleanWrite = true; break; }
            if (eventTool === 'edit_file') return false;
            // successful reads/validates after the write change nothing; keep looking
          }
          return sawCleanWrite;
        };
        if (decision.action === 'tool' && String(decision.tool || '').toLowerCase() === 'read_file') {
          const readPath = deps.normalizeWorkspacePath(decision.path || '');
          if (readPath && lastWriteWithoutFailureSince(readPath)) {
            // Serve the content we already have instead of dead-ending: blocking the
            // read AND the rewrite AND (content-less) edit deadlocked stub recovery —
            // final_check says the file is incomplete but no tool could touch it.
            const writtenEvent = [...toolEvents].reverse().find((event) => (
              event && event.ok && String(event.tool || '').toLowerCase() === 'write_file'
              && deps.normalizeWorkspacePath(event.path || '') === readPath
              && typeof event.writtenContent === 'string' && event.writtenContent
            ));
            recordDebugTrace('agent_read_after_own_write_blocked', {
              chatId: String(chatId || ''), step: String(step), path: readPath, served: String(Boolean(writtenEvent)),
            }, { chatId: String(chatId || ''), step, path: readPath });
            const guardEvent = writtenEvent ? {
              tool: 'read_file',
              ok: true,
              _guardBlock: true,
              path: readPath,
              observation: `read_file ${readPath} (served from this run — you wrote this content yourself and nothing changed it since):\n${String(writtenEvent.writtenContent).slice(0, deps.agentMaxToolOutputChars - 400)}\nIf this content is incomplete, replace it with ONE edit_file (or write_file if it is only a stub); otherwise run validate_files once and finalize.`,
            } : {
              tool: 'read_file',
              ok: false,
              _guardBlock: true,
              path: readPath,
              observation: `read_file blocked for ${readPath}: you just wrote this file's complete content yourself — the saved file IS that content, nothing changed it since. Do not read it back. If something specific is wrong, change it with ONE targeted edit_file; otherwise run validate_files once and finalize.`,
            };
            toolEvents.push(guardEvent);
            // Show a card: the narration promised a read, so a silent skip reads as a stall.
            appendAgentActivity(deps.buildAgentActivityFromToolResult(decision, guardEvent, toolEvents));
            continue;
          }
        }
        // Size of the last successful write for a path (from writtenContent or the
        // "(N chars)" observation), so we can tell a stub from a complete file.
        const lastWriteCharsFor = (p) => {
          if (!Array.isArray(toolEvents)) return -1;
          for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
            const e = toolEvents[i];
            if (e && e.ok && String(e.tool || '').toLowerCase() === 'write_file' && deps.normalizeWorkspacePath(e.path || '') === p) {
              if (typeof e.writtenContent === 'string') return e.writtenContent.length;
              const m = String(e.observation || '').match(/\((\d+)\s*chars\)/);
              return m ? Number(m[1]) : -1;
            }
          }
          return -1;
        };
        if (decision.action === 'tool' && String(decision.tool || '').toLowerCase() === 'write_file') {
          const writePath = deps.normalizeWorkspacePath(decision.path || '');
          // Allow rewriting a tiny STUB with substantially more content — that's a
          // legitimate expansion (e.g. a 1-line README), not a polish loop. In the
          // two-phase write flow the decision carries NO content (newLen 0) — the
          // harness collects it in a separate step — so a stub must be expandable on
          // newLen 0 too, else the model deadlocks: inlining content to prove the
          // expansion trips the output-limit guard, and omitting it (the CORRECT
          // shape) trips this one.
          const savedLen = lastWriteCharsFor(writePath);
          const newLen = String(decision.content || '').length;
          const expandingStub = savedLen >= 0 && savedLen < 200
            && (newLen === 0 || newLen > Math.max(200, savedLen * 2));
          if (writePath && !expandingStub && lastWriteWithoutFailureSince(writePath)) {
            recordDebugTrace('agent_repeat_rewrite_blocked', {
              chatId: String(chatId || ''), step: String(step), path: writePath,
            }, { chatId: String(chatId || ''), step, path: writePath });
            toolEvents.push({
              tool: 'write_file',
              ok: false,
              _guardBlock: true,
              path: writePath,
              observation: `write_file blocked for ${writePath}: you already generated this file's complete content this run and nothing failed since. Do NOT polish by rewriting the whole file — each rewrite regenerates everything and loops. If one specific rule or section is wrong, change it with ONE targeted edit_file; otherwise run validate_files once and finalize.`,
            });
            continue;
          }
        }

        // Read-loop guard (see evaluateRepeatedRead).
        if (decision.action === 'tool' && String(decision.tool || '').toLowerCase() === 'read_file') {
          const readPath = deps.normalizeWorkspacePath(decision.path || '');
          const currentSig = `${Number(decision.start_line) || 0}:${Number(decision.end_line) || 0}:${Number(decision.offset) || 0}`;
          const blockReason = readPath ? evaluateRepeatedRead(toolEvents, readPath, currentSig) : null;
          if (blockReason === 'subset-of-recent-read') {
            // Serve from cache instead of dead-ending: the model wants these
            // lines in front of it again — give them to it for free.
            const reqStart = Number(decision.start_line) || 1;
            const reqEnd = Number(decision.end_line) || 0;
            const cached = [...toolEvents].reverse().find((event) => (
              event && event.ok && String(event.tool || '').toLowerCase() === 'read_file'
              && deps.normalizeWorkspacePath(event.path || '') === readPath
              && typeof event.content === 'string' && event.content
            ));
            if (cached) {
              const allLines = String(cached.content).split('\n');
              const slice = allLines.slice(Math.max(0, reqStart - 1), reqEnd > 0 ? reqEnd : allLines.length).join('\n');
              toolEvents.push({
                tool: 'read_file',
                ok: true,
                _guardBlock: true,
                path: readPath,
                startLine: reqStart,
                endLine: reqEnd,
                observation: `read_file ${readPath} (lines ${reqStart}–${reqEnd || allLines.length} of ${allLines.length}, served from this run's cache — the file has not changed):\n${slice.slice(0, deps.agentMaxToolOutputChars - 400)}`,
              });
              // Cache hits skip the executor, so give the feed its Read chip here —
              // otherwise the model's "Reading..." note renders with nothing under it.
              const cacheRangeLabel = reqEnd > reqStart
                ? `lines ${reqStart}–${reqEnd}`
                : (reqStart > 1 ? `from line ${reqStart}` : '');
              appendAgentActivity({
                kind: 'read',
                inlineMode: true,
                title: 'Read',
                detail: readPath.split('/').filter(Boolean).pop() || readPath,
                openPath: readPath,
                openKind: 'file',
                openStartLine: reqStart,
                openEndLine: reqEnd,
                meta: cacheRangeLabel ? `${cacheRangeLabel} · cached` : 'cached',
                status: 'done',
              });
              recordDebugTrace('agent_read_served_from_cache', {
                chatId: String(chatId || ''), step: String(step), path: readPath,
              }, { chatId: String(chatId || ''), step, path: readPath });
              continue;
            }
          }
          if (blockReason) {
            recordDebugTrace('agent_read_loop_blocked', {
              chatId: String(chatId || ''), step: String(step), path: readPath, reason: blockReason,
            }, { chatId: String(chatId || ''), step, path: readPath, reason: blockReason });
            toolEvents.push({
              tool: 'read_file',
              ok: false,
              _guardBlock: true,
              path: readPath,
              observation: `You have already read the relevant parts of ${readPath} (${blockReason}) — stop re-reading; you have enough context. To find a specific selector/class/id/function, use ONE search_files query on ${readPath}. Otherwise MAKE THE EDIT now (edit_file) or finalize. Do NOT call read_file on ${readPath} again.`,
            });
            continue;
          }
        }

        // Inspection-budget guard: too many reads/searches with no edit -> steer to
        // act. Searches get a higher cap — the guard's own steer recommends "ONE
        // search_files query", so it must not block that query at the read cap.
        if (decision.action === 'tool'
          && (String(decision.tool || '').toLowerCase() === 'read_file'
            || String(decision.tool || '').toLowerCase() === 'search_files')) {
          const inspections = countInspectionsSinceMutation(toolEvents);
          const inspectionCap = String(decision.tool || '').toLowerCase() === 'search_files' ? 12 : 8;
          // Never budget-block a read the edit gate itself demanded (guard deadlock)
          const readTarget = deps.normalizeWorkspacePath(decision.path || '');
          const editGateDemandedRead = Boolean(readTarget) && toolEvents.slice(-4).some((event) => (
            event
            && !event.ok
            && String(event.tool || '').toLowerCase() === 'edit_file'
            && deps.normalizeWorkspacePath(event.path || '') === readTarget
            && /read the file first|not known yet/i.test(String(event.observation || ''))
          ));
          if (inspections >= inspectionCap && !editGateDemandedRead) {
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
              _guardBlock: true,
              path: deps.normalizeWorkspacePath(decision.path || ''),
              observation: `You have inspected the workspace ${inspections} times without making a single change — you already have enough context. STOP inspecting: no more read_file or search_files. Make the change now with edit_file using the lines you have already located, CREATE any missing planned file with write_file (creation is not inspection), or finalize if the task is done. Anchors do NOT need to be byte-exact — close matches (whitespace/indent differences) are accepted, so edit from what you have.${checklistSteer}`,
            });
            continue;
          }
        }

        // Oscillation guard: file cycled back to a prior state -> block re-edit, finalize.
        if (decision.action === 'tool'
          && ['write_file', 'edit_file'].includes(String(decision.tool || '').toLowerCase())) {
          const editPath = deps.normalizeWorkspacePath(decision.path || '');
          if (editPath && oscillatingEditPaths.has(editPath)) {
            oscillationBlocks += 1;
            recordDebugTrace('agent_edit_oscillation_blocked', {
              chatId: String(chatId || ''), step: String(step), path: editPath,
              blockCount: String(oscillationBlocks),
            }, { chatId: String(chatId || ''), step, path: editPath });
            // A weak model can loop re-editing an already-correct file for the rest of its step
            // budget. After a couple of blocks, stop giving it more rope — break to finalize.
            if (oscillationBlocks >= 2) {
              recordDebugTrace('agent_oscillation_force_finalize', {
                chatId: String(chatId || ''), step: String(step), path: editPath,
              }, { chatId: String(chatId || ''), step, path: editPath });
              break;
            }
            toolEvents.push({
              tool: String(decision.tool || ''),
              ok: false,
              _guardBlock: true,
              path: editPath,
              observation: `Stop editing ${editPath}: your edits have cycled it back to a state it was already in this run — you are going in circles, removing the same code you just added. It is correct as-is. Do NOT edit ${editPath} again. Finalize now (or move to a different file if one genuinely still needs changes).`,
            });
            continue;
          }
        }

        // Don't recreate an existing file from scratch. If write_file targets a file that
        // already exists in the workspace and the agent hasn't read it this run, block and
        // steer to read_file -> edit_file, so "make changes" EDITS the file instead of
        // overwriting (destroying) the work already there.
        if (decision.action === 'tool' && String(decision.tool || '').toLowerCase() === 'write_file') {
          const wPath = deps.normalizeWorkspacePath(decision.path || '');
          if (wPath) {
            const ws = (typeof deps.getWorkspaceContext === 'function' ? deps.getWorkspaceContext() : null) || {};
            const existsInWorkspace = Array.isArray(ws.rootEntries)
              && ws.rootEntries.some((e) => e && e.kind === 'file' && deps.normalizeWorkspacePath(e.path || '') === wPath);
            const createdThisRun = toolEvents.some((e) => e
              && String(e.tool || '').toLowerCase() === 'write_file'
              && deps.normalizeWorkspacePath(e.path || '') === wPath
              && e.ok !== false);
            const readSuccessfullyThisRun = toolEvents.some((e) => e
              && String(e.tool || '').toLowerCase() === 'read_file'
              && deps.normalizeWorkspacePath(e.path || '') === wPath
              && e.ok !== false);
            const touchedThisRun = toolEvents.some((e) => e
              && ['read_file', 'write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase())
              && deps.normalizeWorkspacePath(e.path || '') === wPath
              && e.ok !== false);
            const priorRejectedFreshWrite = toolEvents.some((e) => e
              && String(e.tool || '').toLowerCase() === 'write_file'
              && deps.normalizeWorkspacePath(e.path || '') === wPath
              && e.ok === false
              && /mangled dependency versions/i.test(String(e.observation || ''))
              && /Nothing was saved/i.test(String(e.observation || '')));
            const existedBeforeRun = (existsInWorkspace || readSuccessfullyThisRun) && !createdThisRun;
            // Escape hatch: a file that demonstrably broke since its last good
            // write (failed check/run/validate, or an edit that damaged it), or
            // a model that read the file and INSISTS after one block, is doing
            // a deliberate full regeneration — blocking it forever burned 3
            // identical 2-minute steps in a live run. Revert snapshots cover it.
            const priorWriteBlocks = toolEvents.filter((e) => e
              && e._guardBlock
              && String(e.tool || '').toLowerCase() === 'write_file'
              && deps.normalizeWorkspacePath(e.path || '') === wPath).length;
            const brokenSinceLastWrite = (() => {
              for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
                const e = toolEvents[i];
                if (!e || deps.normalizeWorkspacePath(e.path || '') !== wPath) continue;
                const t = String(e.tool || '').toLowerCase();
                if (t === 'write_file' && e.ok && !e._guardBlock) return false;
                if ((t === 'check_code' || t === 'run_app' || t === 'validate_files')
                  && (e.ok === false || Number(e.runErrorCount) > 0 || Number(e.checkErrorCount) > 0 || e.validationPassed === false)) return true;
              }
              return false;
            })();
            const allowDeliberateRewrite = readSuccessfullyThisRun && (priorWriteBlocks >= 1 || brokenSinceLastWrite);
            if (existedBeforeRun && !priorRejectedFreshWrite && !allowDeliberateRewrite) {
              recordDebugTrace('agent_write_over_existing_blocked', {
                chatId: String(chatId || ''), step: String(step), path: wPath,
                afterRead: String(Boolean(touchedThisRun)),
              }, { chatId: String(chatId || ''), step, path: wPath });
              toolEvents.push({
                tool: 'write_file',
                ok: false,
                _guardBlock: true,
                path: wPath,
                observation: readSuccessfullyThisRun
                  ? `${wPath} already exists and was read successfully — do NOT overwrite it from scratch. Use edit_file with a targeted find/replace edit for ONLY the requested change. ONLY if the file is genuinely broken/corrupted and targeted edits cannot fix it: send the same complete write_file again and it will be accepted as a deliberate full regeneration.`
                  : `${wPath} already exists in this project — do NOT overwrite it from scratch (write_file would erase the existing work). First read_file ${wPath}, then make ONLY the requested changes with edit_file. Do the same for every other existing file you need to change: read it, then edit it — never rebuild files that are already here.`,
              });
              continue;
            }
            if (existedBeforeRun && allowDeliberateRewrite) {
              recordDebugTrace('agent_write_over_existing_allowed', {
                chatId: String(chatId || ''), step: String(step), path: wPath,
                reason: brokenSinceLastWrite ? 'broken_since_last_write' : 'insisted_after_block',
              }, { chatId: String(chatId || ''), step, path: wPath });
            }
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
          const toolPlanSpec = phaseState && String(decision.tool || '').toLowerCase() === 'validate_files'
            ? {
              ...planSpec,
              _allExpectedFiles: Array.from(new Set([
                ...allPhaseFilePaths(phaseState, deps.normalizeWorkspacePath),
                ...(Array.isArray(planSpec && planSpec.expectedFiles) ? planSpec.expectedFiles : []),
              ])),
              expectedFiles: activePhaseFilePaths(phaseState, deps.normalizeWorkspacePath),
            }
            : planSpec;
          // Capture + swallow so a late abort of an abandoned tool can't throw unhandled.
          const toolPromise = deps.executeDeveloperToolCall(chatId, decision, taskText, toolEvents, toolPlanSpec, {
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
              if (!deps.isInferenceActive(requestToken)) {
                clearInterval(iv);
                resolve({
                  ok: false,
                  _toolCancelled: true,
                  observation: `${decision.tool} was cancelled.`,
                });
                return;
              }
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
        if (toolResult && toolResult._toolCancelled) {
          if (typeof deps.abortInFlightInference === 'function') {
            deps.abortInFlightInference('tool_cancelled');
          }
          recordDebugTrace('agent_tool_cancelled', {
            chatId: String(chatId || ''),
            step: String(step),
            tool: String(decision.tool || ''),
            path: deps.normalizeWorkspacePath(decision.path || decision.srcPath || '/'),
          }, { chatId: String(chatId || ''), step, decision });
          return true;
        }
        if (toolResult && toolResult.permissionRequired) {
          // Ask-first commands are a hard human-in-the-loop boundary — but the run
          // HOLDS on the shared confirmation card (like project-scope and delete)
          // and continues seamlessly after the choice, instead of ending the run.
          setAgentProgress('Waiting for approval.');
          appendAgentActivity(deps.buildAgentActivityFromToolResult(decision, toolResult, toolEvents));
          const permissionCommand = String(
            (toolResult && toolResult.terminalCommand)
            || (toolResult && toolResult.terminalProof && toolResult.terminalProof.command)
            || decision.command
            || ''
          ).trim();
          const userFacingMessage = `Permission needed to run \`${permissionCommand || 'this command'}\`. Approve once, always allow it, or cancel.`;
          if (permissionCommand && typeof deps.requestProjectScopeConfirmation === 'function') {
            recordDebugTrace('agent_command_permission_requested', {
              chatId: String(chatId || ''),
              step: String(step),
              tool: String(decision.tool || ''),
              command: permissionCommand,
              mode: 'hold',
            }, { chatId: String(chatId || ''), step, decision, command: permissionCommand });
            const choice = await deps.requestProjectScopeConfirmation(chatId, {
              kind: 'command_approval',
              userMessage: userFacingMessage,
              command: permissionCommand,
            });
            recordDebugTrace('agent_command_approval_choice', {
              chatId: String(chatId || ''),
              step: String(step),
              command: permissionCommand,
              choice: String(choice || 'dismissed'),
            }, { chatId: String(chatId || ''), step, choice: String(choice || '') });
            if (choice === 'approve_command' || choice === 'approve_always') {
              if (choice === 'approve_always' && typeof deps.rememberAlwaysAllowedAgentCommand === 'function') {
                deps.rememberAlwaysAllowedAgentCommand(permissionCommand);
              }
              setAgentProgress('Running approved command...');
              // planSpec, not toolPlanSpec — that const lives inside the tool-call try
              // block (the validate_files-only shape is irrelevant for commands).
              toolResult = await deps.executeDeveloperToolCall(chatId, decision, taskText, toolEvents, planSpec, {
                approvedNewProject: Boolean(requestToken && requestToken.approvedNewProject),
                skipNewProjectConfirmation: Boolean(requestToken && requestToken.skipNewProjectConfirmation),
                forceCurrentWorkspace: Boolean(requestToken && requestToken.forceCurrentWorkspace),
                approvedCommand: permissionCommand,
              });
            } else {
              toolResult = {
                ok: false,
                mutated: Boolean(toolResult && toolResult.mutated),
                observation: `User declined to run \`${permissionCommand}\`. Do NOT request this command again; continue without it or finalize honestly with what could be verified.`,
              };
            }
          } else {
            // Fallback (no mid-flight confirm available): paused-state card + stop.
            if (typeof deps.requestAgentCommandApproval === 'function') {
              deps.requestAgentCommandApproval(chatId, {
                command: permissionCommand,
                userMessage: userFacingMessage,
              });
            }
            if (agentHasWorkspaceMutations()) {
              await deps.refreshWorkspaceTree(true);
            }
            deps.consumeLiveAssistantText();
            deps.commitAssistantMessage(chatId, userFacingMessage, userFacingMessage, {
              agentActivities,
              // Human approval is a paused state, not a final/completed response.
              agentMeta: agentMetaWithRevert({
                startedAt,
                completedAt: 0,
                collapsed: false,
                waitingForApproval: true,
              }),
              forceNeedsContinue: false,
            });
            recordDebugTrace('agent_command_permission_requested', {
              chatId: String(chatId || ''),
              step: String(step),
              tool: String(decision.tool || ''),
              command: permissionCommand,
              mode: 'stop',
            }, {
              chatId: String(chatId || ''),
              step,
              decision,
              toolResult,
              command: permissionCommand,
            });
            return true;
          }
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
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
          // Pre-change content — lets the change-summary/diff builders ground the
          // completion message and the finish audit in what actually changed.
          originalContent: ['write_file', 'edit_file'].includes(String(decision.tool || '').toLowerCase())
            && toolResult && typeof toolResult.originalContent === 'string'
            ? toolResult.originalContent
            : undefined,
          createdNewFile: Boolean(toolResult && toolResult.createdNewFile),
          mutated: Boolean(toolResult && toolResult.mutated),
          // Preserve structural validation state so phased requirements do not
          // count a saved-but-incomplete file as a completed deliverable.
          structuralIssue: String((toolResult && toolResult.structuralIssue) || ''),
          // Approval/blocked policy — drives awaiting_approval/blocked run-log states.
          commandPolicy: String((toolResult && toolResult.commandPolicy) || ''),
          terminalCommand: String((toolResult && toolResult.terminalCommand) || ''),
          // The decision's command — the duplicate-guard signature for run_command
          // (a blocked command must not shadow a DIFFERENT next command).
          command: String((decision && decision.command) || ''),
          // run_app reports startup crashes as ok:true + runErrorCount>0 (not !ok).
          runErrorCount: Number(toolResult && toolResult.runErrorCount) || 0,
          // Read range — for the range-aware read-loop guard.
          startLine: Number(decision.start_line) || 0,
          endLine: Number(decision.end_line) || 0,
          offset: Number(decision.offset) || 0,
          searchQuery: String(decision.tool || '').toLowerCase() === 'search_files' ? String(decision.content || '') : '',
          pathsSig: decisionPathsSignature(decision),
          observation: clippedObservation,
        });
        // validate_files may deterministically synchronize support files (currently
        // requirements.txt from real Python imports). Register those writes as normal
        // mutations so summaries, revert, phase progress, and later guards see them.
        if (Array.isArray(toolResult && toolResult.autoWrittenFiles)) {
          for (const autoFile of toolResult.autoWrittenFiles) {
            const autoPath = deps.normalizeWorkspacePath(autoFile && autoFile.path || '');
            if (!autoPath) continue;
            toolEvents.push({
              tool: 'write_file', ok: true, path: autoPath, srcPath: '', dstPath: '',
              content: String(autoFile.content || ''),
              originalContent: String(autoFile.originalContent || ''),
              createdNewFile: Boolean(autoFile.createdNewFile), mutated: true,
              validationPassed: false, validationIssues: [], runErrorCount: 0,
              startLine: 0, endLine: 0, offset: 0, searchQuery: '', pathsSig: '',
              observation: `write_file ok: ${autoPath} ${String(autoFile.note || '(synchronized automatically from project imports).')}`,
              _automaticSupportFile: true,
            });
            refreshPhaseLiveProgress(autoPath);
          }
        }
        // Track the run's dev server + staleness (source mutated after start).
        if (toolResult && toolResult.devServer && toolResult.devServer.running && Number(toolResult.devServer.id) > 0) {
          runDevServer = {
            id: Number(toolResult.devServer.id),
            url: String(toolResult.devServer.url || '').trim(),
            command: String(toolResult.devServer.command || toolResult.terminalCommand || '').trim(),
            stale: false,
          };
        } else if (runDevServer && toolResult && toolResult.ok && toolResult.mutated
          && ['write_file', 'edit_file', 'delete', 'move'].includes(String(decision.tool || '').toLowerCase())) {
          runDevServer.stale = true;
        }
        // read_files batched several files in one step — register each as an individual
        // read_file event so the read/write guards treat every path as already read.
        if (String(decision.tool || '').toLowerCase() === 'read_files' && Array.isArray(toolResult && toolResult.readFilesResult)) {
          for (const rf of toolResult.readFilesResult) {
            const rp = deps.normalizeWorkspacePath(rf && rf.path || '');
            if (!rp) continue;
            toolEvents.push({
              tool: 'read_file',
              ok: true,
              path: rp,
              content: String(rf && rf.content || ''),
              readContent: String(rf && rf.content || ''),
              startLine: 0,
              endLine: 0,
              offset: 0,
              observation: rf && rf.previewClipped
                ? `read_file ${rp} metadata: ${String(rf.content || '').length} chars exist on disk. The read_files display was only a ${Number(rf.previewChars) || 0}-char preview; the source file itself is complete. Use a dedicated read_file before judging its ending or replacing it.`
                : `read_file ${rp} (read completely in this step's read_files batch).`,
              _fromBatchRead: true,
              _batchPreviewClipped: Boolean(rf && rf.previewClipped),
              _batchPreviewChars: Number(rf && rf.previewChars) || 0,
            });
          }
        }
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
        if (toolResult && toolResult.ok && String(decision.tool || '').toLowerCase() === 'new_project') {
          await precreatePlannedParentDirs('after_new_project');
        }
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
          if (toolResult.mutated) {
            refreshPhaseLiveProgress(toolResult.writtenPath || decision.path || '');
          }
          if (cl && cl.total) {
            setAgentProgress(cl.allDone
              ? `All ${cl.total} planned items addressed — preparing the summary...`
              : `Progress ${cl.doneCount}/${cl.total} — continuing...`);
          }
        }
        // Backstop: bound the run at the phase's mutation budget so it can't time out.
        if (phaseState && toolResult && toolResult.ok && toolResult.mutated
          && countRunMutations() >= phaseMutationBudget()) {
          const isLastPhase = phaseState.activeIndex >= phaseState.phases.length - 1;
          const phaseHasAllFileTasks = !getKnownActivePhaseFileTaskGaps().length;
          if (phaseHasAllFileTasks && !hasValidationPassedSinceLatestMutation()) {
            toolEvents.push({
              tool: 'phase_check',
              ok: true,
              observation: `All file deliverables for Phase ${phaseState.activeIndex + 1} are present. Do not rewrite existing phase files just to satisfy the checklist; run validate_files now, then finish if it passes.`,
            });
            setAgentProgress('Checking files...');
            recordDebugTrace('agent_phase_budget_continue_for_validation', {
              chatId: String(chatId || ''), step: String(step),
              phase: String(phaseState.activeIndex + 1),
              mutations: String(countRunMutations()),
            }, { chatId: String(chatId || ''), step, phaseState, toolEvents });
            continue;
          }
          if (agentHasWorkspaceMutations()) {
            await deps.refreshWorkspaceTree(true);
          }
          deps.consumeLiveAssistantText();
          if (!isLastPhase) {
            // Earlier phase: tick it and hand off to the next.
            const res = await completeActivePhase();
            const nextPhase = phaseState.phases[res.nextIdx] || {};
            setAgentProgress('Phase complete.');
            const phaseMsg = buildPhaseHandoffMessage(res.idx, res.donePhase.title, res.nextIdx, nextPhase.title);
            deps.commitAssistantMessage(chatId, phaseMsg, phaseMsg, {
              agentActivities,
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
              forceNeedsContinue: true,
            });
          } else {
            // Last phase: don't falsely mark it done — bound the run and resume it.
            setAgentProgress('Paused.');
            const cur = phaseState.phases[phaseState.activeIndex] || {};
            const pausedMsg = `I've built a chunk of the final phase. Press **Continue** to build Phase ${phaseState.activeIndex + 1}${cur.title ? ` — ${cur.title}` : ''}'s remaining files.`;
            deps.commitAssistantMessage(chatId, pausedMsg, pausedMsg, {
              agentActivities,
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
              forceNeedsContinue: true,
            });
          }
          recordDebugTrace('agent_phase_budget_stop', {
            chatId: String(chatId || ''), step: String(step),
            phase: String(phaseState.activeIndex + 1), lastPhase: String(isLastPhase),
            mutations: String(countRunMutations()),
          }, { chatId: String(chatId || ''), step, phaseState, toolEvents });
          return true;
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
          // Humanize the internal tool name for user-facing text (edit_file -> "the file edit").
          const timedOutToolLabel = (deps.sanitizeAssistantText
            ? String(deps.sanitizeAssistantText(String(decision.tool || '')) || '').trim()
            : String(decision.tool || '')) || 'the step';
          const timedOutToolSentence = timedOutToolLabel.charAt(0).toUpperCase() + timedOutToolLabel.slice(1);
          const stoppedText = `${timedOutToolSentence} for ${timedOutPath} took too long, so I stopped instead of retrying for several minutes.${keptSummary} Tell me the exact change you want for ${timedOutPath} and I'll continue from here.`;
          appendAgentActivity({
            kind: 'error',
            title: 'Stopped (timed out)',
            detail: `${timedOutToolSentence} for ${timedOutPath} exceeded the time limit`,
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
            agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
              const stoppedText = await buildStoppedWithWorkText(`Note: I tried ${streakPath} ${failureStreak.count} times and it kept failing the same way (${shortReason}), so I stopped instead of looping.${keptSummary} Tell me how you want to handle ${streakPath} and I'll pick it back up.`);
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
                agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
              // count is per distinct issue (a NEW issue restarts at 1) — label it as
              // fix attempts so the first retry of each issue doesn't read "2 of 3".
              detail: `${streakPath} didn't pass: ${shortReason}. Fixing it (fix attempt ${failureStreak.count} of ${Math.max(1, sameFailureLimit - 1)}).`,
              hasIssues: true,
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
            setAgentProgress('Preparing the summary...');
            const baseText = String(await deps.generateAgentCompletionText(taskText, toolEvents, getWorkspaceLabel(), planSpec) || '').trim();
            // Short summary only — gap details are in the steps above.
            const gapCount = issues.length;
            const gapNote = `\n\nIt runs, but ${gapCount} cross-file reference${gapCount === 1 ? '' : 's'} still need wiring (details in the steps above). Press Continue and I'll finish them.`;
            const finalText = `${baseText}${gapNote}`;
            if (agentHasWorkspaceMutations()) await deps.refreshWorkspaceTree(true);
            deps.consumeLiveAssistantText();
            deps.commitAssistantMessage(chatId, finalText, finalText, {
              agentActivities,
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
          // Never auto-finalize a build/edit task that changed nothing — an
          // inspect-only plan once "completed" after one read and the completion
          // model invented a file it never created. The model may still decide
          // its own final (which states honestly that nothing was changed).
          const isAnalysisRun = String(planSpec && planSpec.taskKind || '').toLowerCase() === 'analysis';
          if (finalCheck.ok && !isWeakEditPlan() && (agentHasWorkspaceMutations() || isAnalysisRun || shouldSummarizeReadOnlyRun())) {
            // Don't finish a browser-runnable project until a CLEAN run_app has run
            // since the last write — static validation can't see a crash-on-load.
            // Not-yet-run -> deriveFallbackAgentDecision sequences run_app next step;
            // ran-with-errors -> the model repairs from the run_app observation.
            const browserRunnableProject = !isAnalysisRun && toolEvents.some((e) => e && e.ok
              && ['write_file', 'edit_file'].includes(String(e.tool || '').toLowerCase())
              && /\.(html?|js|mjs|cjs)$/i.test(deps.normalizeWorkspacePath(e.path || '')));
            if (browserRunnableProject) {
              let lastWriteIdx = -1;
              let lastCleanRunIdx = -1;
              for (let i = 0; i < toolEvents.length; i += 1) {
                const ev = toolEvents[i];
                if (!ev) continue;
                const t = String(ev.tool || '').toLowerCase();
                if (ev.ok && ['write_file', 'edit_file'].includes(t)) lastWriteIdx = i;
                if (t === 'run_app' && ev.ok && Number(ev.runErrorCount) === 0) lastCleanRunIdx = i;
              }
              if (lastCleanRunIdx <= lastWriteIdx) continue;
            }
            const unmetCriteria = await getUnmetCriteriaNudge();
            if (unmetCriteria) {
              pushCriteriaNudgeObservation(unmetCriteria);
              continue;
            }
            if (!autoFinalSummaryNudgeUsed) {
              autoFinalSummaryNudgeUsed = true;
              toolEvents.push({
                tool: 'final_check',
                ok: true,
                observation: 'Validation passed and the requested changes are written. Return action:"final" now with a concise, grounded user summary. Do not run another tool.',
              });
              setAgentProgress('Preparing your summary...');
              continue;
            }
            setAgentProgress('Preparing the summary...');
            // Auto-finalizing while on the LAST phase must tick plan.md + fade the
            // tracker — it used to leave Phase N's boxes open under a "complete" final.
            if (phaseState && phaseState.activeIndex >= phaseState.phases.length - 1) {
              try { await completeActivePhase(); } catch (_) { }
            }
            let finalText = String(await deps.generateAgentCompletionText(taskText, toolEvents, getWorkspaceLabel(), planSpec) || '');
            const surface = await buildFinishRunSurface({ autoOpen: true });
            if (surface.note) finalText += surface.note;
            if (agentHasWorkspaceMutations()) {
              await deps.refreshWorkspaceTree(true);
            }
            deps.consumeLiveAssistantText();
            deps.commitAssistantMessage(chatId, finalText, finalText, {
              agentActivities,
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true, runHint: surface.runHint }),
              forceNeedsContinue: false,
            });
            recordDebugTrace('agent_done', {
              chatId: String(chatId || ''),
              step: String(step),
              autoFinalized: 'true',
              planSource: String(planSpec && planSpec._planSource || 'model'),
              planRaw: deps.debugPreview(String(planSpec && planSpec._planRaw || ''), 280),
              planFiles: deps.debugPreview((planSpec && Array.isArray(planSpec.expectedFiles) ? planSpec.expectedFiles.join(' | ') : ''), 160),
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
      const cl = refreshChecklist(true);
      const changedClause = fallbackChanged.length
        ? ` Changed: ${fallbackChanged.slice(0, 6).join(', ')}.`
        : '';
      const remainingClause = cl && cl.remaining && cl.remaining.length
        ? ` Still to do: ${cl.remaining.join('; ')}.`
        : '';
      // A validation failure with no repair landed after it must be disclosed —
      // never end on a clean success message over a known-failed check.
      let unresolvedValidationClause = '';
      for (let i = toolEvents.length - 1; i >= 0; i -= 1) {
        const event = toolEvents[i];
        if (!event) continue;
        const evTool = String(event.tool || '').toLowerCase();
        if (event.ok && ['write_file', 'edit_file'].includes(evTool)) {
          // The run ended on a write with no validate/run_app after it. For a
          // browser-runnable file that means the final state was never verified —
          // say so instead of implying it works.
          if (/\.(html?|css|scss|sass|less|js|mjs|cjs|ts|jsx|tsx|json|py|php|java|c|cc|cpp|h|hpp|cs|go|rs)$/i.test(String(event.path || ''))) {
            unresolvedValidationClause = ' Note: I made the change but ran out of steps before verifying it runs — press Continue and I\'ll run it and fix anything that breaks.';
          }
          break;
        }
        if (evTool === 'run_app') {
          if (!event.ok || Number(event.runErrorCount) > 0) {
            // Skip the harness preamble lines (they name internal tools and talk
            // to the model, not the user) — quote the real error underneath.
            const errLine = String(event.observation || '')
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !/^run_app\b/i.test(l) && !/^(build )?output:/i.test(l))
              .find((l) => /^-\s/.test(l) || /error|uncaught|cannot read|is not (defined|a function)/i.test(l)) || '';
            unresolvedValidationClause = ` Note: the app still throws an error when it runs that I couldn't fix${errLine ? ` (${errLine.replace(/^-\s*/, '').slice(0, 160)})` : ''}. Press Continue and I'll keep working on it.`;
          }
          break;
        }
        if (evTool === 'validate_files') {
          if (event.validationPassed === false) {
            const firstIssue = Array.isArray(event.validationIssues) ? String(event.validationIssues[0] || '') : '';
            unresolvedValidationClause = ` Note: the last check still flagged something I couldn't repair${firstIssue ? ` (${firstIssue})` : ''}. Press Continue and I'll address it.`;
          }
          break;
        }
      }
      let fallback = '';
      // Let the model write the wrap-up naturally (grounded in the real diffs)
      // whenever there was progress — done OR out-of-steps — instead of a robotic
      // "N of M planned items / Still to do: ..." dump.
      if ((cl && cl.allDone) || fallbackChanged.length || (cl && cl.doneCount > 0)) {
        if (phaseState) {
          const gaps = getKnownActivePhaseFileTaskGaps();
          const activeP = phaseState.phases[phaseState.activeIndex] || {};
          fallback = `Phase ${phaseState.activeIndex + 1}${activeP.title ? ` (${activeP.title})` : ''} is not complete yet.`;
          if (fallbackChanged.length) fallback += ` Changed: ${fallbackChanged.slice(0, 6).join(', ')}.`;
          if (gaps.length) fallback += ` Still to do: ${gaps.map((g) => g.text || g.path).join('; ')}.`;
          fallback += " Press Continue and I'll keep going from this phase.";
        } else if (totalTimedOut) {
          // After a total timeout, another slow completion call just extends the
          // hang — report deterministically and hand the user Continue.
          fallback = `I ran out of time before finishing.${changedClause} Press Continue and I'll pick up where I left off.`;
        } else {
          fallback = String(await deps.generateAgentCompletionText(taskText, toolEvents, getWorkspaceLabel(), planSpec) || '').trim();
        }
      }
      if (fallback && !phaseState && !(cl && cl.allDone)) {
        fallback += " I didn't get to finish everything — press Continue and I'll keep going.";
      }
      if (!fallback) {
        fallback = fallbackChanged.length
          ? "I made some changes but didn't fully wrap up — press Continue to keep going, or tell me what to adjust."
          : "I couldn't finish in time — press Continue to keep going, or tell me the exact change you want.";
      }
      if (unresolvedValidationClause) fallback += unresolvedValidationClause;
      // Self-aware exit: if we bailed because the model kept re-editing an already-correct file,
      // don't pretend it's finished (it tends to confabulate what it "changed"). Be honest that
      // it was circling and ask the user to pin down what they actually want.
      if (oscillationBlocks >= 2 && !phaseState) {
        const changed = fallbackChanged.length
          ? ` I did apply changes to ${fallbackChanged.slice(0, 4).join(', ')}.`
          : '';
        fallback = `I caught myself editing the same file back and forth, so I stopped instead of going in circles.${changed} I might be misreading exactly what you want — tell me the specific part or the exact result you're after and I'll make just that change.`;
      }
      // Out-of-steps end: only offer the Run surface when the work actually
      // completed cleanly, and never auto-open here.
      let fallbackRunHint = null;
      if (cl && cl.allDone && !unresolvedValidationClause && oscillationBlocks < 2) {
        const surface = await buildFinishRunSurface({ autoOpen: false });
        if (surface.note) fallback += surface.note;
        fallbackRunHint = surface.runHint;
      }
      deps.setThinkingStatus('');
      setAgentProgress('Stopped.');
      deps.consumeLiveAssistantText();
      if (agentHasWorkspaceMutations()) {
        await deps.refreshWorkspaceTree(true);
      }
      deps.commitAssistantMessage(chatId, fallback, fallback, {
        agentActivities,
        agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true, runHint: fallbackRunHint }),
        forceNeedsContinue: !(cl && cl.allDone) || Boolean(unresolvedValidationClause) || oscillationBlocks >= 2,
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
        if (runLog) { try { runLog.end({ errored: true, message: String(err && err.message ? err.message : err) }); } catch (_) { /* observe-only */ } }
        throw err;
      } finally {
        // Exactly one terminal lifecycle event per run, whatever the exit path
        // (end() is idempotent — explicit failure ends above win).
        try {
          if (runLog) runLog.end({ cancelled: !deps.isInferenceActive(requestToken), timedOut: totalTimedOut });
        } catch (_) { /* observe-only */ }
        // Keep the tracker pinned between phases (a phased run that ended with more
        // phases to go); only clear it when no phased run is in flight.
        try {
          if (!keepPhaseTrackerPinned && typeof deps.clearAgentPhaseTracker === 'function') {
            deps.clearAgentPhaseTracker(chatId);
          }
        } catch (_) { /* best-effort */ }
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
              agentMeta: agentMetaWithRevert({ startedAt, completedAt: Date.now(), collapsed: true }),
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
    shouldSuppressAgentNarration,
    evaluateRepeatedRead,
    extractFileLikeTaskPaths,
    markPhaseTaskLiveProgressForPath,
    getActivePhaseFileTaskGaps,
    activePhaseFilePaths,
    shouldForcePhaseValidation,
  };
})(window);
