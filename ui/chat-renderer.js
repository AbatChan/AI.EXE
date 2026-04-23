(function () {
  function createChatRenderer(deps) {
    const d = deps || {};
    const normalizeWorkspacePath = d.normalizeWorkspacePath || ((value) => String(value || ''));
    const nowTs = d.nowTs || (() => Date.now());
    const pushDebugTrace = typeof d.pushDebugTrace === 'function' ? d.pushDebugTrace : null;

    function buildThinkingState(text) {
      const source = normalizeImplicitThinkingTrace(text);
      const regex = /<(thinking|think)>([\s\S]*?)(<\/\1>|$)/gi;
      const blocks = [];
      let inProgress = false;
      let match = null;
      while ((match = regex.exec(source))) {
        const body = String(match[2] || '').trim();
        if (body) blocks.push(body);
        if (!match[3]) {
          inProgress = true;
          break;
        }
      }
      return {
        text: blocks.join('\n\n').trim(),
        inProgress,
      };
    }

    function normalizeImplicitThinkingTrace(text) {
      const source = String(text || '');
      if (/<(thinking|think)>/i.test(source)) return source;
      const closeMatch = source.match(/<\/think>/i);
      if (!closeMatch || typeof closeMatch.index !== 'number') return source;
      const reasoning = source.slice(0, closeMatch.index).trim();
      const rest = source.slice(closeMatch.index + closeMatch[0].length);
      if (!reasoning) return rest;
      return `<think>${reasoning}</think>${rest}`;
    }

    function normalizeStandaloneFinalAnswer(text) {
      return String(text || '')
        .replace(/^(?:therefore|thus|hence|so|accordingly|as a result|in conclusion)[,:\-\s]+/i, '')
        .replace(/^(?:based on (?:that|this)|from (?:that|this)|to answer directly)[,:\-\s]+/i, '')
        .trim();
    }

    function buildThinkingLoader() {
      const loader = document.createElement('div');
      loader.className = 'msg-thinking-loader';
      const label = document.createElement('span');
      label.className = 'msg-thinking-loader-label';
      label.textContent = 'Thinking...';
      loader.appendChild(label);
      return loader;
    }

    const agentProgressPrefix = '__AGENT_PROGRESS__:';

    function buildAgentProgressMarker(text) {
      return `${agentProgressPrefix}${String(text || '').trim()}`;
    }

    function parseAgentProgressMarker(text) {
      const source = String(text || '');
      if (!source.startsWith(agentProgressPrefix)) return '';
      return source.slice(agentProgressPrefix.length).trim();
    }

    function buildAgentProgressLoader(text) {
      const loader = document.createElement('div');
      loader.className = 'msg-thinking-loader msg-agent-progress-loader';
      const label = document.createElement('span');
      label.className = 'msg-thinking-loader-label';
      label.textContent = String(text || '').trim() || 'Working...';
      loader.appendChild(label);
      return loader;
    }

    function formatAgentWorkedDuration(startedAtMs, completedAtMs = Date.now()) {
      const start = Number(startedAtMs) || 0;
      const end = Math.max(start, Number(completedAtMs) || Date.now());
      let totalSec = Math.max(0, Math.round((end - start) / 1000));
      const hours = Math.floor(totalSec / 3600);
      totalSec -= hours * 3600;
      const minutes = Math.floor(totalSec / 60);
      const seconds = totalSec - (minutes * 60);
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    }

    function normalizeAgentActivities(list) {
      return Array.from(list || [])
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          let title = String(item.title || '').trim();
          title = title
            .replace(/^Writing$/i, 'Writing')
            .replace(/^Wrote$/i, 'Wrote')
            .replace(/^Editing$/i, 'Editing')
            .replace(/^Edited$/i, 'Edited')
            .replace(/^Reading$/i, 'Reading')
            .replace(/^Read$/i, 'Read');
          const detail = String(item.detail || '').trim().slice(0, 420);
          const meta = String(item.meta || '').trim().slice(0, 120);
          if (!title && !detail && !meta) return null;
          const status = String(item.status || '').trim().toLowerCase();
          const openPath = normalizeWorkspacePath(item.openPath || item.path || '');
          const rawDiff = item.diff && typeof item.diff === 'object' ? item.diff : null;
          const added = Math.max(0, Number(rawDiff && rawDiff.added) || 0);
          const removed = Math.max(0, Number(rawDiff && rawDiff.removed) || 0);
          const diffPreview = Array.isArray(item.diffPreview)
            ? item.diffPreview
                .slice(0, 280)
                .map((row) => {
                  if (!row || typeof row !== 'object') return null;
                  const type = String(row.type || '').toLowerCase();
                  if (type === 'spacer') return { type: 'spacer' };
                  if (!['context', 'add', 'remove'].includes(type)) return null;
                  return {
                    type,
                    oldLine: Number(row.oldLine) > 0 ? Number(row.oldLine) : 0,
                    newLine: Number(row.newLine) > 0 ? Number(row.newLine) : 0,
                    text: String(row.text || '').slice(0, 400),
                  };
                })
                .filter(Boolean)
            : null;
          return {
            kind: String(item.kind || '').trim().toLowerCase(),
            title: title.slice(0, 160),
            detail,
            meta,
            inlineMode: item.inlineMode === true,
            diff: added > 0 || removed > 0 ? { added, removed } : null,
            diffPreview: diffPreview && diffPreview.length ? diffPreview : null,
            openPath: openPath && openPath !== '/' ? openPath : '',
            openKind: String(item.openKind || '').trim().toLowerCase() === 'folder' ? 'folder' : 'file',
            status: status === 'error' ? 'error' : (status === 'pending' ? 'pending' : 'done'),
            ts: Number(item.ts) || nowTs(),
          };
        })
        .filter(Boolean)
        .slice(-24);
    }

    function normalizeAgentMeta(meta) {
      if (!meta || typeof meta !== 'object') return null;
      const startedAt = Number(meta.startedAt) || 0;
      const completedAt = Number(meta.completedAt) || 0;
      const collapsed = meta.collapsed !== false;
      if (!startedAt && !completedAt) return null;
      return { startedAt, completedAt, collapsed };
    }

    function cloneAgentActivities(list) {
      return normalizeAgentActivities(list).map((item) => ({ ...item }));
    }

    function cloneAgentMeta(meta) {
      const normalized = normalizeAgentMeta(meta);
      return normalized ? { ...normalized } : null;
    }

    function mergeAgentActivityIntoList(list, activity) {
      const normalized = normalizeAgentActivities([activity])[0];
      if (!normalized) return list;
      const target = Array.isArray(list) ? list : [];
      const previous = target.length > 0 ? target[target.length - 1] : null;
      const sameTarget = previous && (
        (previous.openPath && normalized.openPath && previous.openPath === normalized.openPath)
        || (previous.kind === 'project' && normalized.kind === 'project')
        || (previous.kind === 'scan' && normalized.kind === 'scan' && previous.detail === normalized.detail)
      );
      if (
        previous
        && previous.kind === normalized.kind
        && previous.title === normalized.title
        && previous.detail === normalized.detail
        && previous.meta === normalized.meta
        && previous.inlineMode === normalized.inlineMode
        && previous.status === normalized.status
      ) {
        return target;
      }
      let pendingMatchIndex = -1;
      for (let index = target.length - 1; index >= 0; index -= 1) {
        const candidate = target[index];
        if (!candidate || candidate.status !== 'pending') continue;
        const candidateSameTarget = (
          (candidate.openPath && normalized.openPath && candidate.openPath === normalized.openPath)
          || (candidate.kind === 'project' && normalized.kind === 'project')
          || (candidate.kind === 'scan' && normalized.kind === 'scan' && candidate.detail === normalized.detail)
        );
        if (candidate.kind === normalized.kind && (candidateSameTarget || candidate.detail === normalized.detail)) {
          pendingMatchIndex = index;
          break;
        }
      }
      if (pendingMatchIndex >= 0) {
        const candidate = target[pendingMatchIndex];
        target[pendingMatchIndex] = {
          ...normalized,
          inlineMode: normalized.inlineMode || candidate.inlineMode || false,
          diff: normalized.diff || candidate.diff || null,
          diffPreview: normalized.diffPreview || candidate.diffPreview || null,
          openPath: normalized.openPath || candidate.openPath || '',
          openKind: normalized.openKind || candidate.openKind || 'file',
        };
        return target;
      }
      if (
        previous
        && previous.status === 'error'
        && normalized.status === 'error'
        && previous.title === normalized.title
      ) {
        target[target.length - 1] = normalized;
        return target;
      }
      // Deduplicate mkdir/new_project activities by path across the full list
      if (
        (normalized.kind === 'mkdir' || normalized.kind === 'project')
        && normalized.openPath
        && normalized.status === 'done'
      ) {
        const existingIdx = target.findIndex((a) =>
          a && a.kind === normalized.kind && a.openPath === normalized.openPath && a.status === 'done'
        );
        if (existingIdx >= 0) {
          return target; // already rendered, skip
        }
      }
      target.push(normalized);
      return target;
    }

    function getActiveAgentStreamState() {
      return typeof d.getActiveAgentStreamState === 'function' ? d.getActiveAgentStreamState() : null;
    }

    function setActiveAgentStreamState(next) {
      if (typeof d.setActiveAgentStreamState === 'function') d.setActiveAgentStreamState(next || null);
    }

    function ensureActiveAgentStreamState(chatId) {
      const key = String(chatId || '');
      let state = getActiveAgentStreamState();
      if (!state || String(state.chatId || '') !== key) {
        state = { chatId: key, statusText: 'Working...', activities: [] };
        setActiveAgentStreamState(state);
      }
      return state;
    }

    function resetActiveAgentStreamState() {
      setActiveAgentStreamState(null);
    }

    function traceDiffDrawer(kind, payload) {
      if (!pushDebugTrace) return;
      try {
        pushDebugTrace(kind, payload && typeof payload === 'object' ? payload : {});
      } catch (_) { }
    }

    function setActiveAgentStreamStatus(chatId, text) {
      const state = ensureActiveAgentStreamState(chatId);
      state.statusText = String(text || '').trim() || 'Working...';
      setActiveAgentStreamState(state);
    }

    function pushActiveAgentStreamActivity(chatId, activity) {
      const state = ensureActiveAgentStreamState(chatId);
      mergeAgentActivityIntoList(state.activities, activity);
      if (state.activities.length > 24) {
        state.activities = state.activities.slice(state.activities.length - 24);
      }
      setActiveAgentStreamState(state);
    }

    function countTextLines(text) {
      const source = String(text || '');
      return source ? source.split('\n').length : 0;
    }

    function formatAgentActivityPathLabel(path) {
      const normalized = normalizeWorkspacePath(path || '');
      if (!normalized || normalized === '/') return 'workspace file';
      return normalized.replace(/^\/+/, '');
    }

    function buildInlineAgentActivityBase(activity) {
      return {
        ...activity,
        inlineMode: true,
      };
    }

    function countLineDiffStats(beforeText, afterText) {
      const before = String(beforeText || '');
      const after = String(afterText || '');
      const beforeLines = before ? before.split('\n') : [];
      const afterLines = after ? after.split('\n') : [];
      if (!beforeLines.length && !afterLines.length) {
        return { added: 0, removed: 0 };
      }
      if (!beforeLines.length) {
        return { added: afterLines.length, removed: 0 };
      }
      if (!afterLines.length) {
        return { added: 0, removed: beforeLines.length };
      }
      const width = afterLines.length + 1;
      let prev = new Uint16Array(width);
      let curr = new Uint16Array(width);
      for (let i = 1; i <= beforeLines.length; i += 1) {
        for (let j = 1; j <= afterLines.length; j += 1) {
          curr[j] = beforeLines[i - 1] === afterLines[j - 1]
            ? prev[j - 1] + 1
            : Math.max(prev[j], curr[j - 1]);
        }
        const temp = prev;
        prev = curr;
        curr = temp;
        curr.fill(0);
      }
      const common = prev[afterLines.length] || 0;
      return {
        added: Math.max(0, afterLines.length - common),
        removed: Math.max(0, beforeLines.length - common),
      };
    }

    function buildLineDiffPreview(beforeText, afterText, contextLines = 2, maxRows = 240) {
      const before = String(beforeText || '');
      const after = String(afterText || '');
      const beforeLines = before ? before.split('\n') : [];
      const afterLines = after ? after.split('\n') : [];
      const rows = [];
      if (!beforeLines.length && !afterLines.length) return rows;
      const width = afterLines.length + 1;
      const dp = Array.from({ length: beforeLines.length + 1 }, () => new Uint16Array(width));
      for (let i = 1; i <= beforeLines.length; i += 1) {
        for (let j = 1; j <= afterLines.length; j += 1) {
          dp[i][j] = beforeLines[i - 1] === afterLines[j - 1]
            ? dp[i - 1][j - 1] + 1
            : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      const reversed = [];
      let i = beforeLines.length;
      let j = afterLines.length;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
          reversed.push({ type: 'context', oldLine: i, newLine: j, text: beforeLines[i - 1] });
          i -= 1;
          j -= 1;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
          reversed.push({ type: 'add', oldLine: 0, newLine: j, text: afterLines[j - 1] });
          j -= 1;
        } else if (i > 0) {
          reversed.push({ type: 'remove', oldLine: i, newLine: 0, text: beforeLines[i - 1] });
          i -= 1;
        }
      }
      const full = reversed.reverse();
      const changedIndexes = [];
      full.forEach((row, index) => {
        if (row.type !== 'context') changedIndexes.push(index);
      });
      if (!changedIndexes.length) return rows;
      const include = new Set();
      changedIndexes.forEach((index) => {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(full.length - 1, index + contextLines);
        for (let cursor = start; cursor <= end; cursor += 1) include.add(cursor);
      });
      const selected = Array.from(include).sort((a, b) => a - b);
      let previousIndex = -1;
      selected.forEach((index) => {
        if (previousIndex >= 0 && index > previousIndex + 1) {
          rows.push({ type: 'spacer' });
        }
        rows.push(full[index]);
        previousIndex = index;
      });
      return rows.slice(0, maxRows);
    }

    function buildAgentActivityFromToolResult(decision, toolResult, toolEvents = []) {
      const tool = String(decision && decision.tool ? decision.tool : '').toLowerCase();
      const ok = Boolean(toolResult && toolResult.ok);
      const targetInfo = d.describeAgentToolTarget ? d.describeAgentToolTarget(decision) : '';
      const observation = String((toolResult && toolResult.observation) || '').trim();
      if (!ok) return null;
      if (tool === 'new_project') {
        return buildInlineAgentActivityBase({
          kind: 'project',
          title: 'Created project',
          detail: (typeof d.getWorkspaceRootName === 'function' && d.getWorkspaceRootName()) || 'New project',
          status: 'done',
        });
      }
      if (tool === 'list_dir') {
        return buildInlineAgentActivityBase({
          kind: 'scan',
          title: targetInfo && targetInfo !== '/' ? `Inspected ${formatAgentActivityPathLabel(targetInfo)}` : 'Inspected workspace',
          detail: '',
          status: 'done',
        });
      }
      if (tool === 'read_file') {
        return buildInlineAgentActivityBase({
          kind: 'read',
          title: 'Read',
          detail: formatAgentActivityPathLabel(targetInfo || 'workspace file'),
          openPath: targetInfo,
          openKind: 'file',
          meta: 'Open file',
          status: 'done',
        });
      }
      if (tool === 'write_file') {
        const writtenPath = normalizeWorkspacePath(toolResult && toolResult.writtenPath ? toolResult.writtenPath : targetInfo);
        const diffStats = countLineDiffStats(toolResult && toolResult.originalContent, toolResult && toolResult.writtenContent);
        return buildInlineAgentActivityBase({
          kind: 'write',
          title: Boolean(toolResult && toolResult.createdNewFile) ? 'Wrote' : 'Edited',
          detail: formatAgentActivityPathLabel(writtenPath || targetInfo || 'workspace file'),
          openPath: writtenPath || targetInfo,
          openKind: 'file',
          diff: diffStats,
          diffPreview: !Boolean(toolResult && toolResult.createdNewFile)
            ? buildLineDiffPreview(toolResult && toolResult.originalContent, toolResult && toolResult.writtenContent)
            : null,
          status: 'done',
        });
      }
      if (tool === 'edit_file') {
        const writtenPath = normalizeWorkspacePath(toolResult && toolResult.writtenPath ? toolResult.writtenPath : targetInfo);
        const diffStats = countLineDiffStats(toolResult && toolResult.originalContent, toolResult && toolResult.writtenContent);
        return buildInlineAgentActivityBase({
          kind: 'edit',
          title: 'Edited',
          detail: formatAgentActivityPathLabel(writtenPath || targetInfo || 'workspace file'),
          openPath: writtenPath || targetInfo,
          openKind: 'file',
          diff: diffStats,
          diffPreview: buildLineDiffPreview(toolResult && toolResult.originalContent, toolResult && toolResult.writtenContent),
          status: 'done',
        });
      }
      if (tool === 'validate_files') {
        return buildInlineAgentActivityBase({
          kind: 'validate',
          title: 'Checked files',
          detail: toolResult && toolResult.validationPassed === false
            ? 'Found issues that need repair.'
            : 'No obvious issues found.',
          meta: '',
          status: 'done',
        });
      }
      if (tool === 'mkdir') {
        const normalizedTarget = normalizeWorkspacePath(targetInfo || '');
        const priorNewProject = Array.isArray(toolEvents) && toolEvents.some((event) => (
          event
          && event.ok
          && String(event.tool || '').toLowerCase() === 'new_project'
        ));
        const currentRoot = typeof d.getWorkspaceRootName === 'function' ? String(d.getWorkspaceRootName() || '').trim() : '';
        if (priorNewProject && normalizedTarget && currentRoot && normalizedTarget === `/${currentRoot}`) {
          return null;
        }
        return buildInlineAgentActivityBase({
          kind: 'mkdir',
          title: 'Created folder',
          detail: formatAgentActivityPathLabel(targetInfo || 'new folder'),
          openPath: targetInfo,
          openKind: 'folder',
          meta: 'Open folder',
          status: 'done',
        });
      }
      if (tool === 'move') {
        const dstPath = normalizeWorkspacePath(decision && (decision.dstPath || decision.dst_path) || '');
        return buildInlineAgentActivityBase({
          kind: 'move',
          title: 'Moved',
          detail: formatAgentActivityPathLabel(dstPath || targetInfo || observation),
          openPath: dstPath,
          openKind: d.guessWorkspaceTargetKind ? d.guessWorkspaceTargetKind(dstPath) : 'file',
          meta: 'Open target',
          status: 'done',
        });
      }
      if (tool === 'delete') {
        return buildInlineAgentActivityBase({
          kind: 'delete',
          title: 'Moved to Trash',
          detail: formatAgentActivityPathLabel(targetInfo || observation),
          status: 'done',
        });
      }
      return {
        kind: tool || 'tool',
        title: d.describeAgentToolPhase ? d.describeAgentToolPhase(tool, targetInfo, 'done') : (tool || 'Tool'),
        detail: observation.replace(/\s+/g, ' ').trim(),
        status: 'done',
      };
    }

    function buildAgentPendingActivity(decision, toolEvents = []) {
      const tool = String(decision && decision.tool ? decision.tool : '').toLowerCase();
      const targetInfo = d.describeAgentToolTarget ? d.describeAgentToolTarget(decision) : '';
      if (tool === 'new_project') {
        return buildInlineAgentActivityBase({
          kind: 'project',
          title: 'Creating project',
          detail: (typeof d.getWorkspaceRootName === 'function' && d.getWorkspaceRootName()) || 'Project workspace',
          status: 'pending',
        });
      }
      if (tool === 'list_dir') {
        return buildInlineAgentActivityBase({
          kind: 'scan',
          title: targetInfo && targetInfo !== '/' ? `Inspecting ${formatAgentActivityPathLabel(targetInfo)}` : 'Inspecting workspace',
          detail: '',
          status: 'pending',
        });
      }
      if (tool === 'read_file') {
        return buildInlineAgentActivityBase({
          kind: 'read',
          title: 'Reading',
          detail: formatAgentActivityPathLabel(targetInfo || 'workspace file'),
          openPath: targetInfo,
          openKind: 'file',
          status: 'pending',
        });
      }
      if (tool === 'write_file') {
        const isNewFile = d.isLikelyNewAgentFileTarget ? d.isLikelyNewAgentFileTarget(toolEvents, targetInfo) : true;
        return buildInlineAgentActivityBase({
          kind: 'write',
          title: isNewFile ? 'Writing' : 'Editing',
          detail: formatAgentActivityPathLabel(targetInfo || 'workspace file'),
          openPath: targetInfo,
          openKind: 'file',
          status: 'pending',
        });
      }
      if (tool === 'edit_file') {
        return buildInlineAgentActivityBase({
          kind: 'edit',
          title: 'Editing',
          detail: formatAgentActivityPathLabel(targetInfo || 'workspace file'),
          openPath: targetInfo,
          openKind: 'file',
          status: 'pending',
        });
      }
      if (tool === 'validate_files') {
        return {
          kind: 'validate',
          title: 'Checking files',
          detail: 'Looking for syntax, file-role, and MVP issues.',
          status: 'pending',
        };
      }
      if (tool === 'mkdir') {
        return buildInlineAgentActivityBase({
          kind: 'mkdir',
          title: 'Creating folder',
          detail: formatAgentActivityPathLabel(targetInfo || 'new folder'),
          openPath: targetInfo,
          openKind: 'folder',
          status: 'pending',
        });
      }
      if (tool === 'move') {
        const dstPath = normalizeWorkspacePath(decision && (decision.dstPath || decision.dst_path) || '');
        return buildInlineAgentActivityBase({
          kind: 'move',
          title: 'Moving',
          detail: formatAgentActivityPathLabel(dstPath || targetInfo || ''),
          openPath: dstPath,
          openKind: d.guessWorkspaceTargetKind ? d.guessWorkspaceTargetKind(dstPath) : 'file',
          status: 'pending',
        });
      }
      if (tool === 'delete') {
        return buildInlineAgentActivityBase({
          kind: 'delete',
          title: 'Deleting',
          detail: formatAgentActivityPathLabel(targetInfo || ''),
          status: 'pending',
        });
      }
      return {
        kind: tool || 'tool',
        title: d.describeAgentToolPhase ? d.describeAgentToolPhase(tool, targetInfo, 'start') : (tool || 'Tool'),
        detail: targetInfo || '',
        status: 'pending',
      };
    }

    function buildAgentPlanActivity(planSpec = null) {
      const plan = planSpec && typeof planSpec === 'object' ? planSpec : null;
      if (!plan) return null;
      const detail = String(plan.summary || (plan.projectName ? plan.projectName.replace(/-/g, ' ') : 'Plan ready')).trim();
      const meta = Array.isArray(plan.expectedFiles) && plan.expectedFiles.length
        ? plan.expectedFiles.slice(0, 6).join(' ')
        : (plan.taskKind === 'project' ? 'MVP deliverables planned' : '');
      return {
        kind: 'plan',
        title: '',
        detail,
        meta,
        status: 'done',
      };
    }

    function buildAgentCorrectionActivity(detail) {
      const text = String(detail || '').trim();
      if (!text) return null;
      return buildInlineAgentActivityBase({
        kind: 'correction',
        title: 'Needs work',
        detail: text,
        status: 'done',
      });
    }

    async function openAgentActivityTarget(activity) {
      const path = normalizeWorkspacePath(activity && activity.openPath ? activity.openPath : '');
      if (!path || path === '/') return;
      const kind = String(activity && activity.openKind ? activity.openKind : '').toLowerCase() === 'folder' ? 'folder' : 'file';
      if (typeof d.setWorkspaceSelection === 'function') d.setWorkspaceSelection(path, kind);
      if (kind === 'file') {
        if (typeof d.openFileTab === 'function') {
          await d.openFileTab(path, typeof d.workspaceBaseName === 'function' ? d.workspaceBaseName(path) : 'file');
        }
      } else {
        if (typeof d.getWorkspaceNodeState === 'function') d.getWorkspaceNodeState(path).expanded = true;
        if (typeof d.renderArtifacts === 'function') await d.renderArtifacts();
      }
    }

    function buildAgentActivityRow(chatId, activity) {
      if (activity && activity.kind === 'thought') {
        const item = document.createElement('div');
        item.className = 'msg-agent-activity-thought';
        if (typeof d.marked === 'function') {
          item.innerHTML = d.marked(String(activity.detail || '').trim());
        } else {
          item.textContent = String(activity.detail || '').trim();
        }
        return item;
      }
      const hasDiffDrawer = Boolean(activity && activity.diffPreview && activity.diffPreview.length);
      const clickable = Boolean(activity && activity.status === 'done' && activity.openPath && !hasDiffDrawer);
      const item = document.createElement(clickable ? 'button' : 'div');
      item.className = `msg-agent-activity-row${activity && activity.status === 'error' ? ' error' : ''}${clickable ? ' clickable' : ''}`;
      if (item instanceof HTMLButtonElement) item.type = 'button';
      let inlineRow = null;
      let titleEl = null;
      let pathEl = null;
      let metaEl = null;
      let plusEl = null;
      let minusEl = null;
      if (activity && activity.inlineMode) {
        inlineRow = document.createElement('div');
        inlineRow.className = 'msg-agent-activity-inline';

        titleEl = document.createElement('span');
        titleEl.className = 'msg-agent-activity-inline-title';
        titleEl.textContent = String(activity && activity.title ? activity.title : '').trim() || 'Step';
        inlineRow.appendChild(titleEl);

        const detail = String(activity && activity.detail ? activity.detail : '').trim();
        if (detail) {
          pathEl = document.createElement('span');
          const fileLikeTarget = Boolean(
            activity
            && activity.openKind === 'file'
            && activity.openPath
            && normalizeWorkspacePath(activity.openPath) !== '/'
          );
          pathEl.className = `msg-agent-activity-inline-path${fileLikeTarget ? ' file-target' : ''}`;
          pathEl.textContent = detail;
          inlineRow.appendChild(pathEl);
        }

        const meta = String(activity && activity.meta ? activity.meta : '').trim();
        if (meta) {
          metaEl = document.createElement('span');
          metaEl.className = 'msg-agent-activity-inline-meta';
          metaEl.textContent = meta;
          inlineRow.appendChild(metaEl);
        }

        const diff = activity && activity.diff && typeof activity.diff === 'object' ? activity.diff : null;
        if (diff && Number(diff.added) > 0) {
          plusEl = document.createElement('span');
          plusEl.className = 'msg-agent-activity-inline-plus';
          plusEl.textContent = `+${Number(diff.added)}`;
          inlineRow.appendChild(plusEl);
        }
        if (diff && Number(diff.removed) > 0) {
          minusEl = document.createElement('span');
          minusEl.className = 'msg-agent-activity-inline-minus';
          minusEl.textContent = `-${Number(diff.removed)}`;
          inlineRow.appendChild(minusEl);
        }

        let chevron = null;
        if (hasDiffDrawer) {
          chevron = document.createElement('span');
          chevron.className = 'msg-agent-summary-chevron';
          chevron.innerHTML = `
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4.5 6.5 8 10l3.5-3.5"></path>
            </svg>
          `;
          inlineRow.appendChild(chevron);
        }

        item.appendChild(inlineRow);
      } else {
      const title = String(activity && activity.title ? activity.title : '').trim();
      if (title) {
        const titleRow = document.createElement('div');
        titleRow.className = 'msg-agent-activity-title';
        titleRow.textContent = title;
        item.appendChild(titleRow);
      }
      const detail = String(activity && activity.detail ? activity.detail : '').trim();
      if (detail) {
        const detailEl = document.createElement('div');
        detailEl.className = `msg-agent-activity-detail${activity && activity.kind === 'plan' ? ' plan-note' : ''}`;
        detailEl.textContent = detail;
        item.appendChild(detailEl);
      }
      const meta = String(activity && activity.meta ? activity.meta : '').trim();
      if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = `msg-agent-activity-meta${activity && activity.kind === 'plan' ? ' plan-note' : ''}`;
        metaEl.textContent = meta;
        item.appendChild(metaEl);
      }
      }
      if (hasDiffDrawer) {
        item.classList.add('diff-toggle');
        item.setAttribute('aria-expanded', 'false');
        const drawer = document.createElement('div');
        drawer.className = 'msg-agent-diff-drawer';
        drawer.hidden = true;
        const drawerHeader = document.createElement('div');
        drawerHeader.className = 'msg-agent-diff-header';
        const drawerTitle = document.createElement('div');
        drawerTitle.className = 'msg-agent-diff-header-title';
        const drawerName = document.createElement('span');
        drawerName.className = 'msg-agent-diff-header-name';
        drawerName.textContent = String(activity && activity.detail ? activity.detail : '').trim() || 'file';
        drawerTitle.appendChild(drawerName);
        const drawerDiff = activity && activity.diff && typeof activity.diff === 'object' ? activity.diff : null;
        if (drawerDiff && Number(drawerDiff.added) > 0) {
          const headerPlus = document.createElement('span');
          headerPlus.className = 'msg-agent-activity-inline-plus';
          headerPlus.textContent = `+${Number(drawerDiff.added)}`;
          drawerTitle.appendChild(headerPlus);
        }
        if (drawerDiff && Number(drawerDiff.removed) > 0) {
          const headerMinus = document.createElement('span');
          headerMinus.className = 'msg-agent-activity-inline-minus';
          headerMinus.textContent = `-${Number(drawerDiff.removed)}`;
          drawerTitle.appendChild(headerMinus);
        }
        drawerHeader.appendChild(drawerTitle);
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'msg-agent-diff-copy-btn msg-action-btn copy';
        copyBtn.setAttribute('aria-label', 'Copy diff');
        const baseCopyIcon = typeof d.makeMessageActionIcon === 'function'
          ? d.makeMessageActionIcon('copy')
          : `
          <svg class="copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        `;
        copyBtn.innerHTML = `
          <span class="copy">${baseCopyIcon}</span>
          <svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m3.5 8.5 2.7 2.7L12.5 5"></path>
          </svg>
        `;
        copyBtn.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const diffRows = Array.isArray(activity.diffPreview) ? activity.diffPreview : [];
          const diffText = diffRows.map((row) => {
            if (!row || typeof row !== 'object') return '';
            if (row.type === 'spacer') return '...';
            const prefix = row.type === 'add' ? '+' : (row.type === 'remove' ? '-' : ' ');
            return `${prefix}${String(row.text || '')}`;
          }).filter(Boolean).join('\n');
          try {
            const copied = d.copyTextToClipboard ? await d.copyTextToClipboard(diffText) : false;
            if (typeof d.applyCopyFeedback === 'function') {
              d.applyCopyFeedback(copyBtn, copied, 'Copy diff');
            } else if (copied) {
              copyBtn.classList.add('copied');
              window.setTimeout(() => {
                copyBtn.classList.remove('copied');
              }, 1800);
            }
          } catch (_) { }
        });
        drawerHeader.appendChild(copyBtn);
        drawer.appendChild(drawerHeader);
        const drawerBody = document.createElement('div');
        drawerBody.className = 'msg-agent-diff-body';
        const diffRows = Array.isArray(activity.diffPreview) ? activity.diffPreview : [];
        diffRows.forEach((row) => {
          if (!row || typeof row !== 'object') return;
          if (row.type === 'spacer') {
            const spacer = document.createElement('div');
            spacer.className = 'msg-agent-diff-spacer';
            spacer.textContent = '...';
            drawerBody.appendChild(spacer);
            return;
          }
          const diffRow = document.createElement('div');
          diffRow.className = `msg-agent-diff-row ${row.type}`;
          const line = document.createElement('span');
          line.className = 'msg-agent-diff-line';
          const lineNumber = row.newLine > 0 ? row.newLine : row.oldLine;
          line.textContent = lineNumber > 0 ? String(lineNumber) : '';
          diffRow.appendChild(line);
          const code = document.createElement('code');
          code.className = 'msg-agent-diff-code';
          code.textContent = row.text || '';
          diffRow.appendChild(code);
          drawerBody.appendChild(diffRow);
        });
        drawer.appendChild(drawerBody);
        item.appendChild(drawer);
        item.addEventListener('click', () => {
          const expanded = item.getAttribute('aria-expanded') === 'true';
          const nextExpanded = !expanded;
          const traceBase = {
            title: String(activity && activity.title ? activity.title : ''),
            path: String(activity && activity.openPath ? activity.openPath : activity && activity.detail ? activity.detail : ''),
            expanded,
            nextExpanded,
            drawerHidden: Boolean(drawer.hidden),
            currentMaxHeight: String(drawer.style.maxHeight || ''),
            currentOpacity: String(drawer.style.opacity || ''),
            rowCount: Array.isArray(activity && activity.diffPreview) ? activity.diffPreview.length : 0,
          };
          traceDiffDrawer('diff_drawer_toggle_click', traceBase);
          item.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
          if (titleEl) titleEl.textContent = nextExpanded
            ? `${String(activity && activity.title ? activity.title : 'Edited')} file`
            : String(activity && activity.title ? activity.title : 'Edited');
          if (pathEl) pathEl.hidden = nextExpanded;
          if (metaEl) metaEl.hidden = nextExpanded;
          if (plusEl) plusEl.hidden = nextExpanded;
          if (minusEl) minusEl.hidden = nextExpanded;
          if (nextExpanded) {
            drawer.hidden = false;
            drawer.style.maxHeight = 'none';
            drawer.style.opacity = '0';
            const measuredScrollHeight = Number(drawer.scrollHeight) || 0;
            const targetHeight = Math.min(measuredScrollHeight, 230);
            traceDiffDrawer('diff_drawer_toggle_measure', {
              ...traceBase,
              drawerHidden: Boolean(drawer.hidden),
              measuredScrollHeight,
              targetHeight,
              offsetHeight: Number(drawer.offsetHeight) || 0,
            });
            drawer.style.maxHeight = '0px';
            void drawer.offsetHeight;
            requestAnimationFrame(() => {
              drawer.style.maxHeight = `${targetHeight}px`;
              drawer.style.opacity = '1';
              traceDiffDrawer('diff_drawer_toggle_after_open', {
                ...traceBase,
                drawerHidden: Boolean(drawer.hidden),
                appliedMaxHeight: String(drawer.style.maxHeight || ''),
                appliedOpacity: String(drawer.style.opacity || ''),
                scrollHeight: Number(drawer.scrollHeight) || 0,
                offsetHeight: Number(drawer.offsetHeight) || 0,
              });
            });
          } else {
            const measuredScrollHeight = Number(drawer.scrollHeight) || 0;
            const currentHeight = Math.min(measuredScrollHeight, 230);
            traceDiffDrawer('diff_drawer_toggle_measure', {
              ...traceBase,
              drawerHidden: Boolean(drawer.hidden),
              measuredScrollHeight,
              targetHeight: currentHeight,
              offsetHeight: Number(drawer.offsetHeight) || 0,
            });
            drawer.style.maxHeight = `${currentHeight}px`;
            drawer.style.opacity = '1';
            void drawer.offsetHeight;
            requestAnimationFrame(() => {
              drawer.style.maxHeight = '0px';
              drawer.style.opacity = '0';
              traceDiffDrawer('diff_drawer_toggle_after_close', {
                ...traceBase,
                drawerHidden: Boolean(drawer.hidden),
                appliedMaxHeight: String(drawer.style.maxHeight || ''),
                appliedOpacity: String(drawer.style.opacity || ''),
                scrollHeight: Number(drawer.scrollHeight) || 0,
                offsetHeight: Number(drawer.offsetHeight) || 0,
              });
            });
            const settle = () => {
              drawer.hidden = true;
              traceDiffDrawer('diff_drawer_toggle_settled', {
                ...traceBase,
                expanded: false,
                nextExpanded: false,
                drawerHidden: Boolean(drawer.hidden),
                finalMaxHeight: String(drawer.style.maxHeight || ''),
                finalOpacity: String(drawer.style.opacity || ''),
                scrollHeight: Number(drawer.scrollHeight) || 0,
                offsetHeight: Number(drawer.offsetHeight) || 0,
              });
              drawer.removeEventListener('transitionend', settle);
            };
            drawer.addEventListener('transitionend', settle);
          }
        });
      } else if (clickable) {
        item.addEventListener('click', () => {
          void openAgentActivityTarget(activity).then(() => {
            if (typeof d.updateAssistantAgentMeta === 'function') {
              d.updateAssistantAgentMeta(chatId, Number(activity && activity.ts) || 0, (current) => current, { rerender: false }).catch(() => {});
            }
          });
        });
      }
      return item;
    }

    function setAgentFinalDividerExpanded(bubble, expanded) {
      if (!bubble) return;
      const divider = bubble.querySelector('.msg-agent-final-divider');
      if (!divider) return;
      const nextExpanded = Boolean(expanded);
      const currentExpanded = divider.dataset.expanded === 'true';
      if (currentExpanded === nextExpanded) return;
      divider.dataset.expanded = nextExpanded ? 'true' : 'false';
      if (nextExpanded) {
        divider.hidden = false;
        divider.style.maxHeight = '0px';
        divider.style.opacity = '0';
        divider.style.marginTop = '0px';
        requestAnimationFrame(() => {
          divider.style.maxHeight = `${divider.scrollHeight}px`;
          divider.style.opacity = '1';
          divider.style.marginTop = '10px';
        });
        const settle = () => {
          divider.style.maxHeight = 'none';
          divider.removeEventListener('transitionend', settle);
        };
        divider.addEventListener('transitionend', settle);
      } else {
        const currentHeight = divider.scrollHeight;
        divider.style.maxHeight = `${currentHeight}px`;
        divider.style.opacity = '1';
        divider.style.marginTop = '10px';
        requestAnimationFrame(() => {
          divider.style.maxHeight = '0px';
          divider.style.opacity = '0';
          divider.style.marginTop = '0px';
        });
        const settle = () => {
          divider.hidden = true;
          divider.removeEventListener('transitionend', settle);
        };
        divider.addEventListener('transitionend', settle);
      }
    }

    function setAgentPanelExpanded(panel, expanded, animate = true) {
      if (!panel) return;
      panel.dataset.expanded = expanded ? 'true' : 'false';
      const summaryToggle = panel.querySelector('.msg-agent-summary-toggle');
      if (summaryToggle) summaryToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const drawer = panel.querySelector('.msg-agent-activity-drawer');
      if (drawer) {
        if (!animate) {
          drawer.hidden = !expanded;
          drawer.style.maxHeight = expanded ? 'none' : '0px';
          drawer.style.opacity = expanded ? '1' : '0';
          drawer.style.transform = expanded ? 'translateY(0)' : 'translateY(-6px)';
        } else if (expanded) {
          drawer.hidden = false;
          drawer.style.maxHeight = '0px';
          drawer.style.opacity = '0';
          drawer.style.transform = 'translateY(-6px)';
          requestAnimationFrame(() => {
            drawer.style.maxHeight = `${drawer.scrollHeight}px`;
            drawer.style.opacity = '1';
            drawer.style.transform = 'translateY(0)';
          });
          const settle = () => {
            drawer.style.maxHeight = 'none';
            drawer.removeEventListener('transitionend', settle);
          };
          drawer.addEventListener('transitionend', settle);
        } else {
          const currentHeight = drawer.scrollHeight;
          drawer.style.maxHeight = `${currentHeight}px`;
          drawer.style.opacity = '1';
          drawer.style.transform = 'translateY(0)';
          requestAnimationFrame(() => {
            drawer.style.maxHeight = '0px';
            drawer.style.opacity = '0';
            drawer.style.transform = 'translateY(-6px)';
          });
          const settle = () => {
            drawer.hidden = true;
            drawer.removeEventListener('transitionend', settle);
          };
          drawer.addEventListener('transitionend', settle);
        }
      }
      const bubble = panel.closest('.msg-bubble');
      setAgentFinalDividerExpanded(bubble, expanded);
    }

    function buildAgentActivitySummaryToggle(chatId, messageTs, meta) {
      const normalizedMeta = normalizeAgentMeta(meta);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'msg-agent-summary-toggle';
      const collapsed = !normalizedMeta || normalizedMeta.collapsed !== false;
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

      const leftLine = document.createElement('span');
      leftLine.className = 'msg-agent-summary-line';
      button.appendChild(leftLine);

      const labelWrap = document.createElement('span');
      labelWrap.className = 'msg-agent-summary-label';

      const labelText = document.createElement('span');
      labelText.className = 'msg-agent-summary-label-text';
      labelText.textContent = `Worked for ${formatAgentWorkedDuration(normalizedMeta && normalizedMeta.startedAt, normalizedMeta && normalizedMeta.completedAt)}`;
      labelWrap.appendChild(labelText);

      const chevron = document.createElement('span');
      chevron.className = 'msg-agent-summary-chevron';
      chevron.innerHTML = `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5"></path>
        </svg>
      `;
      labelWrap.appendChild(chevron);
      button.appendChild(labelWrap);

      const rightLine = document.createElement('span');
      rightLine.className = 'msg-agent-summary-line';
      button.appendChild(rightLine);

      button.addEventListener('click', () => {
        const panel = button.closest('.msg-agent-panel');
        const expanded = !(panel && panel.dataset.expanded === 'true');
        setAgentPanelExpanded(panel, expanded, true);
        if (typeof d.updateAssistantAgentMeta === 'function') {
          void d.updateAssistantAgentMeta(chatId, messageTs, (current) => ({
            ...(current || normalizedMeta || {}),
            collapsed: !expanded,
          }), { rerender: false });
        }
      });
      return button;
    }

    function buildAgentActivityPanel(chatId, activities, options = {}) {
      const normalizedRows = normalizeAgentActivities(activities);
      const meta = normalizeAgentMeta(options.agentMeta);
      const completed = Boolean(meta && meta.completedAt);
      const expanded = completed ? meta.collapsed === false : true;
      const rows = completed
        ? normalizedRows
        : normalizedRows.filter((activity) => activity && activity.status !== 'pending');
      const wrapper = document.createElement('div');
      wrapper.className = `msg-agent-panel${completed ? ' completed' : ''}`;
      wrapper.dataset.expanded = expanded ? 'true' : 'false';
      const statusText = String(options.statusText || '').trim();
      if (rows.length > 0) {
        const list = document.createElement('div');
        list.className = 'msg-agent-activity-list';
        if (completed) wrapper.appendChild(buildAgentActivitySummaryToggle(chatId, Number(options.messageTs) || 0, meta));
        rows.forEach((activity) => {
          list.appendChild(buildAgentActivityRow(chatId, activity));
        });
        if (completed) {
          const drawer = document.createElement('div');
          drawer.className = 'msg-agent-activity-drawer';
          drawer.appendChild(list);
          wrapper.appendChild(drawer);
          setAgentPanelExpanded(wrapper, expanded, false);
        } else {
          wrapper.appendChild(list);
        }
      }
      if (statusText && !completed) wrapper.appendChild(buildAgentProgressLoader(statusText));
      return wrapper;
    }

    function hasCanvasTokenStarted(text) {
      const source = String(text || '');
      return /<AIcanvas\b/i.test(source)
        || /<AIcanvasJSON\b/i.test(source)
        || /<(?:\/)?canvas>\s*$/i.test(source)
        || /^canvas\s*[>:]/i.test(source.trim());
    }

    function buildCanvasLoader(displayText = '', rawText = '') {
      const loader = document.createElement('div');
      loader.className = 'msg-canvas-loading';
      const intro = String(displayText || '').trim();
      if (intro) {
        const introEl = document.createElement('div');
        introEl.className = 'msg-canvas-loading-intro';
        introEl.textContent = intro;
        loader.appendChild(introEl);
      }
      const card = document.createElement('div');
      card.className = 'msg-artifact-card msg-artifact-card-canvas msg-artifact-card-loading';
      const title = document.createElement('div');
      title.className = 'msg-artifact-title msg-canvas-loading-title';
      const titleMatch = String(rawText || '').match(/<AIcanvas[^>]*\btitle="([^"]{1,90})"/i);
      title.textContent = String(titleMatch && titleMatch[1] ? titleMatch[1] : 'Canvas').trim() || 'Canvas';
      card.appendChild(title);
      const body = document.createElement('div');
      body.className = 'msg-canvas-loading-body';
      for (let i = 0; i < 4; i += 1) {
        const line = document.createElement('span');
        line.className = 'msg-canvas-loading-line';
        body.appendChild(line);
      }
      card.appendChild(body);
      loader.appendChild(card);
      return loader;
    }

    function populateAssistantBubble(bubble, displayText, options = {}) {
      if (!bubble) return;
      bubble.innerHTML = '';
      const shouldShowThinkingLoader = Boolean(options.showThinkingLoader);
      if (options.showCanvasLoader) {
        bubble.appendChild(buildCanvasLoader(displayText, options.canvasRawText));
        return;
      }
      if (Array.isArray(options.agentActivities) && (options.agentActivities.length > 0 || options.agentStatusText)) {
        bubble.appendChild(buildAgentActivityPanel(options.chatId || '', options.agentActivities, {
          statusText: options.agentStatusText || '',
          agentMeta: options.agentMeta || null,
          messageTs: Number(options.messageTs) || 0,
        }));
      }
      const contentText = String(displayText || '').trim();
      if (!contentText) return;
      const normalizedAgentMeta = normalizeAgentMeta(options.agentMeta);
      if (normalizedAgentMeta && normalizedAgentMeta.completedAt) {
        const divider = document.createElement('div');
        divider.className = 'msg-agent-final-divider';
        divider.hidden = normalizedAgentMeta.collapsed !== false;
        divider.innerHTML = `
          <span class="msg-agent-final-divider-line"></span>
          <span class="msg-agent-final-divider-label">Final message</span>
          <span class="msg-agent-final-divider-line"></span>
        `;
        bubble.appendChild(divider);
        if (normalizedAgentMeta.collapsed === false) {
          divider.dataset.expanded = 'true';
          divider.style.maxHeight = 'none';
          divider.style.opacity = '1';
          divider.style.marginTop = '10px';
        } else {
          divider.dataset.expanded = 'false';
          divider.style.maxHeight = '0px';
          divider.style.opacity = '0';
          divider.style.marginTop = '0px';
        }
      }
      const content = document.createElement('div');
      content.className = 'msg-answer';
      content.innerHTML = d.renderMarkdownHtml ? d.renderMarkdownHtml(contentText) : contentText;
      bubble.appendChild(content);
      if (typeof d.attachCodeCopyButtons === 'function') d.attachCodeCopyButtons(content);
      if (shouldShowThinkingLoader) bubble.appendChild(buildThinkingLoader());
    }

    function buildMsgNode(role, text, chatId = '', messageTs = 0, loopDetected = false, thinkingText = '', branchAnchorTs = 0, agentActivities = [], agentMeta = null) {
      const div = document.createElement('div');
      div.className = `msg ${role}`;
      const editingUserMessage = role === 'user' && d.isEditingUserMessage && d.isEditingUserMessage(chatId, messageTs);
      if (editingUserMessage) div.classList.add('editing');
      if (messageTs) div.dataset.msgTs = String(messageTs);
      const stack = document.createElement('div');
      stack.className = 'msg-stack';
      const navTargetTs = Number(branchAnchorTs) || Number(messageTs) || 0;

      const bubble = document.createElement('div');
      bubble.className = role === 'error' ? 'msg-error-panel' : 'msg-bubble';
      const followMarker = '<<AIEXE_CANVAS_FOLLOWUP>>';
      const originalText = String(text || '');
      let renderText = originalText;
      let canvasFollowUp = '';
      const markerIndex = originalText.indexOf(followMarker);
      if (role === 'ai' && markerIndex >= 0) {
        renderText = originalText.slice(0, markerIndex).trim();
        canvasFollowUp = originalText.slice(markerIndex + followMarker.length).trim();
      }
      if (role === 'ai') {
        populateAssistantBubble(bubble, renderText, { chatId, agentActivities, agentMeta, messageTs });
      } else if (role === 'error') {
        bubble.textContent = renderText;
      } else if (editingUserMessage) {
        bubble.classList.add('msg-editing-bubble');
        const shell = document.createElement('div');
        shell.className = 'msg-edit-shell';
        const textarea = document.createElement('textarea');
        textarea.className = 'msg-edit-textarea';
        const editingState = typeof d.getEditingMessageState === 'function' ? d.getEditingMessageState() : null;
        textarea.value = editingState ? String(editingState.draft || '') : renderText;
        textarea.rows = 1;
        textarea.spellcheck = true;
        textarea.setAttribute('aria-label', 'Edit message');
        if (typeof d.autoResizeInlineMessageEditor === 'function') d.autoResizeInlineMessageEditor(textarea);
        let saveBtn = null;
        textarea.addEventListener('input', () => {
          if (typeof d.updateEditingMessageDraft === 'function') d.updateEditingMessageDraft(textarea.value);
          if (typeof d.autoResizeInlineMessageEditor === 'function') d.autoResizeInlineMessageEditor(textarea);
          if (saveBtn) saveBtn.disabled = !String(textarea.value || '').trim();
        });
        textarea.addEventListener('keydown', (evt) => {
          if (evt.key === 'Escape') {
            evt.preventDefault();
            if (typeof d.cancelMessageEditMode === 'function') d.cancelMessageEditMode();
            return;
          }
          if (evt.key === 'Enter' && !evt.shiftKey) {
            evt.preventDefault();
            if (typeof d.saveEditedUserMessage === 'function') d.saveEditedUserMessage(chatId, messageTs, textarea.value);
          }
        });
        shell.appendChild(textarea);

        const footer = document.createElement('div');
        footer.className = 'msg-edit-footer';
        const note = document.createElement('div');
        note.className = 'msg-edit-note';
        note.textContent = 'Editing this message creates an alternate branch in this chat. Use the branch switcher on this message to move between versions.';
        footer.appendChild(note);

        const actions = document.createElement('div');
        actions.className = 'msg-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'msg-edit-btn cancel icon-only';
        cancelBtn.setAttribute('aria-label', 'Cancel');
        if (typeof d.applyCustomTooltip === 'function') d.applyCustomTooltip(cancelBtn, 'Cancel');
        cancelBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round">
            <path d="M18 6 6 18"></path>
            <path d="M6 6 18 18"></path>
          </svg>
        `;
        cancelBtn.addEventListener('click', () => {
          if (typeof d.cancelMessageEditMode === 'function') d.cancelMessageEditMode();
        });
        actions.appendChild(cancelBtn);

        saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'msg-edit-btn save icon-only';
        saveBtn.setAttribute('aria-label', 'Save');
        if (typeof d.applyCustomTooltip === 'function') d.applyCustomTooltip(saveBtn, 'Save');
        saveBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.5 9.2 16.7 19 7.5"></path>
          </svg>
        `;
        saveBtn.disabled = !String(textarea.value || '').trim();
        saveBtn.addEventListener('click', () => {
          if (typeof d.saveEditedUserMessage === 'function') d.saveEditedUserMessage(chatId, messageTs, textarea.value);
        });
        actions.appendChild(saveBtn);

        footer.appendChild(actions);
        shell.appendChild(footer);
        bubble.appendChild(shell);
      } else {
        bubble.textContent = renderText;
      }
      const rawText = [renderText, canvasFollowUp].filter(Boolean).join('\n');

      if (role === 'ai') {
        let followRendered = false;
        const relatedArtifacts = typeof d.getArtifactsForMessage === 'function'
          ? d.getArtifactsForMessage(chatId, messageTs).filter((item) => item && item.type === 'canvas')
          : [];
        if (relatedArtifacts.length > 0) {
          const cards = document.createElement('div');
          cards.className = 'msg-artifacts';
          relatedArtifacts.forEach((item) => {
            const card = document.createElement('button');
            card.type = 'button';
            const artifactTypeClass = String(item && item.type || '').trim().toLowerCase() === 'canvas'
              ? ' msg-artifact-card-canvas'
              : '';
            card.className = `msg-artifact-card${artifactTypeClass}`;
            card.innerHTML = `<div class="msg-artifact-title">${d.escapeHtml ? d.escapeHtml(item.name) : item.name}</div><div class="msg-artifact-meta">Open details</div>`;
            card.addEventListener('click', () => {
              if (typeof d.openArtifactDetail === 'function' && typeof d.makeArtifactKey === 'function') {
                d.openArtifactDetail(d.makeArtifactKey(item), 'chat');
              }
            });
            cards.appendChild(card);
          });
          bubble.appendChild(cards);
          if (canvasFollowUp) {
            const follow = document.createElement('div');
            follow.className = 'msg-canvas-followup';
            follow.textContent = canvasFollowUp;
            bubble.appendChild(follow);
            followRendered = true;
          }
        }
        if (canvasFollowUp && !followRendered) {
          const follow = document.createElement('div');
          follow.className = 'msg-canvas-followup';
          follow.textContent = canvasFollowUp;
          bubble.appendChild(follow);
        }
      }

      stack.appendChild(bubble);

      if (role === 'ai' || role === 'user') {
        const actions = document.createElement('div');
        actions.className = `msg-action-rail ${role}`;
        const makeActionButton = (kind, title, onClick) => {
          const btn = document.createElement('button');
          btn.className = `msg-action-btn ${kind}`;
          btn.type = 'button';
          btn.setAttribute('aria-label', title);
          if (typeof d.applyCustomTooltip === 'function') d.applyCustomTooltip(btn, title);
          btn.innerHTML = d.makeMessageActionIcon ? d.makeMessageActionIcon(kind) : title;
          btn.addEventListener('click', async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            await onClick(btn);
          });
          return btn;
        };

        if (role === 'user') {
          actions.appendChild(makeActionButton('edit', 'Edit', async () => {
            if (typeof d.editUserMessage === 'function') d.editUserMessage(chatId, messageTs);
          }));
          actions.appendChild(makeActionButton('copy', 'Copy', async (btn) => {
            const copied = d.copyTextToClipboard ? await d.copyTextToClipboard(rawText) : false;
            if (typeof d.applyCopyFeedback === 'function') d.applyCopyFeedback(btn, copied, 'Copy');
          }));
          const userNav = d.buildBranchNavigator ? d.buildBranchNavigator(chatId, messageTs, 'edit') : null;
          if (userNav) actions.appendChild(userNav);
        } else {
          actions.appendChild(makeActionButton('copy', 'Copy', async (btn) => {
            const copied = d.copyTextToClipboard ? await d.copyTextToClipboard(rawText) : false;
            if (typeof d.applyCopyFeedback === 'function') d.applyCopyFeedback(btn, copied, 'Copy');
          }));
          if (d.isRetryableAssistantMessage && d.isRetryableAssistantMessage(chatId, messageTs)) {
            actions.appendChild(makeActionButton('retry', 'Retry', async () => {
              if (typeof d.retryAssistantMessage === 'function') d.retryAssistantMessage(chatId, messageTs);
            }));
          }
          const aiNav = (d.buildBranchNavigator && d.buildBranchNavigator(chatId, navTargetTs, 'retry'))
            || (d.buildBranchNavigator && d.buildBranchNavigator(chatId, d.findFallbackRetryAnchorTs ? d.findFallbackRetryAnchorTs(chatId, messageTs) : 0, 'retry'));
          if (aiNav) actions.appendChild(aiNav);
        }
        if (actions.childElementCount > 0) stack.appendChild(actions);
      }

      div.appendChild(stack);
      return div;
    }

    function renderActiveChat() {
      if (typeof d.renderSidebarCounts === 'function') d.renderSidebarCounts();
      const chatArea = d.getChatArea ? d.getChatArea() : null;
      if (!chatArea) return;
      const previousBottomDistance = d.getScrollBottomDistance ? d.getScrollBottomDistance(chatArea) : 0;
      if (!(d.currentAuthUser && d.currentAuthUser())) {
        if (typeof d.setLastRenderedChatId === 'function') d.setLastRenderedChatId('');
        if (typeof d.setCanvasMode === 'function') d.setCanvasMode(false);
        if (typeof d.setDeveloperAgentMode === 'function') d.setDeveloperAgentMode(false);
        if (typeof d.setThinkMode === 'function') d.setThinkMode(false);
        if (typeof d.setPendingManualContext === 'function') d.setPendingManualContext('');
        if (typeof d.setPendingAttachments === 'function') d.setPendingAttachments([]);
        if (typeof d.setPendingNewChatAttachments === 'function') d.setPendingNewChatAttachments([]);
        chatArea.innerHTML = d.emptyStateTemplate || '';
        const sub = chatArea.querySelector('.empty-sub');
        if (sub) sub.innerHTML = 'Your private chats and files are hidden while signed out. Log back into the same account to restore them.';
        const chips = chatArea.querySelector('.suggestion-chips');
        if (chips) chips.style.display = 'none';
        if (typeof d.setCanvasPanelContent === 'function') d.setCanvasPanelContent('', '');
        if (typeof d.updateContinueButtonVisibility === 'function') d.updateContinueButtonVisibility();
        if (typeof d.updateChatScrollDownButtonVisibility === 'function') d.updateChatScrollDownButtonVisibility();
        if (typeof d.syncInputAugmentState === 'function') d.syncInputAugmentState();
        if (typeof d.renderMiddleView === 'function') d.renderMiddleView();
        if (typeof d.syncLiveInferenceUiState === 'function') d.syncLiveInferenceUiState();
        return;
      }
      if (d.isInNewChatMode && d.isInNewChatMode()) {
        if (typeof d.setLastRenderedChatId === 'function') d.setLastRenderedChatId('');
        if (typeof d.setCanvasMode === 'function') d.setCanvasMode(false);
        if (typeof d.setThinkMode === 'function') d.setThinkMode(false);
        if (typeof d.setPendingAttachments === 'function' && typeof d.normalizePendingAttachmentList === 'function') {
          d.setPendingAttachments(d.normalizePendingAttachmentList(d.getPendingNewChatAttachments ? d.getPendingNewChatAttachments() : []));
        }
        chatArea.innerHTML = d.emptyStateTemplate || '';
        if (typeof d.setCanvasPanelContent === 'function') d.setCanvasPanelContent('', '');
        if (typeof d.updateContinueButtonVisibility === 'function') d.updateContinueButtonVisibility();
        if (typeof d.updateChatScrollDownButtonVisibility === 'function') d.updateChatScrollDownButtonVisibility();
        if (typeof d.syncInputAugmentState === 'function') d.syncInputAugmentState();
        if (typeof d.renderMiddleView === 'function') d.renderMiddleView();
        if (typeof d.syncLiveInferenceUiState === 'function') d.syncLiveInferenceUiState();
        return;
      }
      const chat = d.getActiveChat ? d.getActiveChat() : null;
      if (!chat || chat.messages.length === 0) {
        if (typeof d.setLastRenderedChatId === 'function') d.setLastRenderedChatId(chat && chat.id ? String(chat.id) : '');
        if (typeof d.setCanvasMode === 'function') d.setCanvasMode(Boolean(chat && chat.canvasMode));
        if (typeof d.setDeveloperAgentMode === 'function') d.setDeveloperAgentMode(Boolean(chat && chat.agentMode));
        if (typeof d.setThinkMode === 'function') d.setThinkMode(Boolean(chat && chat.thinkMode));
        if (typeof d.setPendingAttachments === 'function' && typeof d.normalizePendingAttachmentList === 'function') d.setPendingAttachments(d.normalizePendingAttachmentList((chat && chat.pendingAttachments) || []));
        if (typeof d.setPendingManualContext === 'function') d.setPendingManualContext(String((chat && chat.manualContext) || ''));
        chatArea.innerHTML = d.emptyStateTemplate || '';
        if (typeof d.setCanvasPanelContent === 'function') d.setCanvasPanelContent('', '');
        if (typeof d.updateContinueButtonVisibility === 'function') d.updateContinueButtonVisibility();
        if (typeof d.updateChatScrollDownButtonVisibility === 'function') d.updateChatScrollDownButtonVisibility();
        if (typeof d.syncInputAugmentState === 'function') d.syncInputAugmentState();
        if (typeof d.renderMiddleView === 'function') d.renderMiddleView();
        if (typeof d.syncLiveInferenceUiState === 'function') d.syncLiveInferenceUiState();
        return;
      }
      const lastRenderedChatId = d.getLastRenderedChatId ? d.getLastRenderedChatId() : '';
      const forceBottom = lastRenderedChatId !== String(chat.id || '');
      if (typeof d.setLastRenderedChatId === 'function') d.setLastRenderedChatId(String(chat.id || ''));
      if (typeof d.setCanvasMode === 'function') d.setCanvasMode(Boolean(chat.canvasMode));
      if (typeof d.setDeveloperAgentMode === 'function') d.setDeveloperAgentMode(Boolean(chat.agentMode));
      if (typeof d.setThinkMode === 'function') d.setThinkMode(Boolean(chat.thinkMode));
      if (typeof d.setPendingAttachments === 'function' && typeof d.normalizePendingAttachmentList === 'function') d.setPendingAttachments(d.normalizePendingAttachmentList(chat.pendingAttachments || []));
      if (typeof d.setPendingManualContext === 'function') d.setPendingManualContext(String(chat.manualContext || ''));
      chatArea.innerHTML = '';
      chat.messages.forEach((msg) => {
        chatArea.appendChild(buildMsgNode(
          msg.role,
          msg.text,
          chat.id,
          msg.ts,
          Boolean(msg.loopDetected),
          msg.thinking || '',
          Number(msg.branchAnchorTs) || 0,
          msg.agentActivities || [],
          msg.agentMeta || null,
        ));
      });
      if (forceBottom || (d.getChatAutoScrollPinned && d.getChatAutoScrollPinned())) {
        if (typeof d.scrollChatToBottom === 'function') d.scrollChatToBottom(true);
      } else if (typeof d.restoreChatScrollPosition === 'function') {
        d.restoreChatScrollPosition(previousBottomDistance);
      }
      if (typeof d.updateChatScrollDownButtonVisibility === 'function') d.updateChatScrollDownButtonVisibility();
      if (typeof d.syncCanvasPanelFromArtifacts === 'function') d.syncCanvasPanelFromArtifacts();
      if (typeof d.updateContinueButtonVisibility === 'function') d.updateContinueButtonVisibility();
      if (typeof d.syncInputAugmentState === 'function') d.syncInputAugmentState();
      if (typeof d.renderMiddleView === 'function') d.renderMiddleView();
      if (typeof d.syncLiveInferenceUiState === 'function') d.syncLiveInferenceUiState();
    }

    return {
      buildThinkingState,
      normalizeImplicitThinkingTrace,
      normalizeStandaloneFinalAnswer,
      buildThinkingLoader,
      buildAgentProgressMarker,
      parseAgentProgressMarker,
      formatAgentWorkedDuration,
      normalizeAgentActivities,
      normalizeAgentMeta,
      cloneAgentActivities,
      cloneAgentMeta,
      mergeAgentActivityIntoList,
      ensureActiveAgentStreamState,
      resetActiveAgentStreamState,
      setActiveAgentStreamStatus,
      pushActiveAgentStreamActivity,
      buildAgentActivityFromToolResult,
      buildAgentPendingActivity,
      buildAgentPlanActivity,
      buildAgentCorrectionActivity,
      buildAgentActivityPanel,
      hasCanvasTokenStarted,
      buildCanvasLoader,
      populateAssistantBubble,
      buildMsgNode,
      renderActiveChat,
    };
  }

  window.AIExeChatRenderer = { createChatRenderer };
})();
