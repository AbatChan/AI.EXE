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

    // Count-up tween for diff stats (+A / -R), animated once per logical row.
    const animatedDiffKeys = new Set();
    function setAnimatedCount(el, target, prefix, key) {
      const end = Math.max(0, Number(target) || 0);
      if (!el) return;
      if (!key || animatedDiffKeys.has(key) || end <= 0 || typeof requestAnimationFrame !== 'function') {
        el.textContent = `${prefix}${end}`;
        return;
      }
      animatedDiffKeys.add(key);
      if (animatedDiffKeys.size > 600) animatedDiffKeys.clear();
      const startTs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dur = Math.min(700, 220 + end * 9);
      const tick = (now) => {
        const t = Math.min(1, ((now || Date.now()) - startTs) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = `${prefix}${Math.round(end * eased)}`;
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = `${prefix}${end}`;
      };
      el.textContent = `${prefix}0`;
      requestAnimationFrame(tick);
    }

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

    function formatThoughtDuration(startedAtMs, completedAtMs = Date.now()) {
      const start = Number(startedAtMs) || 0;
      if (!start) return 'a couple of seconds';
      const end = Math.max(start, Number(completedAtMs) || (start + 2000));
      const totalSec = Math.max(0, Math.round((end - start) / 1000));
      if (totalSec < 3) return 'a couple of seconds';
      if (totalSec < 60) return `${totalSec} seconds`;
      const minutes = Math.floor(totalSec / 60);
      const seconds = totalSec - (minutes * 60);
      if (minutes === 1 && seconds < 10) return 'a minute';
      if (minutes === 1) return `1 minute ${seconds}s`;
      return seconds > 0 ? `${minutes} minutes ${seconds}s` : `${minutes} minutes`;
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
          // Structured checklist rows (for kind:'checklist') survive normalization
          // so the plan renders as a real UI element, not raw markdown text, and is
          // preserved across clone/persist/reload (which all re-run this normalizer).
          const checklistItems = Array.isArray(item.items)
            ? item.items
                .map((row) => (row && typeof row === 'object'
                  ? { text: String(row.text || '').trim().slice(0, 160), done: row.done === true }
                  : null))
                .filter((row) => row && row.text)
                .slice(0, 12)
            : null;
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
          const streamContent = String(item.streamContent || item.content || '').trim().slice(0, 30000);
          return {
            kind: String(item.kind || '').trim().toLowerCase(),
            title: title.slice(0, 160),
            detail,
            meta,
            inlineMode: item.inlineMode === true,
            diff: added > 0 || removed > 0 ? { added, removed } : null,
            diffPreview: diffPreview && diffPreview.length ? diffPreview : null,
            streamContent,
            openPath: openPath && openPath !== '/' ? openPath : '',
            openKind: String(item.openKind || '').trim().toLowerCase() === 'folder' ? 'folder' : 'file',
            openStartLine: Math.max(0, Number(item.openStartLine) || 0),
            openEndLine: Math.max(0, Number(item.openEndLine) || 0),
            status: status === 'error' ? 'error' : (status === 'pending' ? 'pending' : 'done'),
            items: checklistItems && checklistItems.length ? checklistItems : null,
            ts: Number(item.ts) || nowTs(),
          };
        })
        .filter(Boolean)
        .slice(-120);
    }

    function normalizeAgentMeta(meta) {
      if (!meta || typeof meta !== 'object') return null;
      const startedAt = Number(meta.startedAt) || 0;
      const completedAt = Number(meta.completedAt) || 0;
      const collapsed = meta.collapsed !== false;
      if (!startedAt && !completedAt) return null;
      const normalized = { startedAt, completedAt, collapsed };
      // Per-response revert snapshot: pre-run file states (+ post-run states once
      // a revert captured them) so the message can restore either direction.
      const normalizeSnapshotFiles = (list) => (Array.isArray(list) ? list : [])
        .map((file) => (file && file.path ? {
          path: String(file.path),
          existedBefore: file.existedBefore === true,
          content: String(file.content || ''),
          added: Math.max(0, Number(file.added) || 0),
          removed: Math.max(0, Number(file.removed) || 0),
        } : null))
        .filter(Boolean);
      if (meta.revert && typeof meta.revert === 'object') {
        const files = normalizeSnapshotFiles(meta.revert.files);
        if (files.length) {
          normalized.revert = { files };
          const restored = normalizeSnapshotFiles(meta.revert.restored);
          if (restored.length) normalized.revert.restored = restored;
        }
      }
      if (meta.reverted === true) normalized.reverted = true;
      return normalized;
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
      // The plan checklist is a single live element: when it re-renders with an
      // item newly ticked, replace the existing one in place rather than stacking
      // a fresh copy on every progress update.
      if (normalized.kind === 'checklist') {
        for (let i = target.length - 1; i >= 0; i -= 1) {
          if (target[i] && target[i].kind === 'checklist') {
            target[i] = normalized;
            return target;
          }
        }
        target.push(normalized);
        return target;
      }
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
        state = { chatId: key, statusText: 'Working...', activities: [], startedAt: Date.now() };
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
      if (state.activities.length > 80) {
        state.activities = state.activities.slice(state.activities.length - 80);
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
        // Show WHICH part was read so repeated/partial reads of the same file are
        // visually distinct instead of a row of identical "Read script.js" lines.
        // Matches how Roo Code / Cursor / Claude Code label ranged reads.
        const startLine = Number(decision && decision.start_line) || 0;
        const endLine = Number(decision && decision.end_line) || 0;
        const charOffset = Number(decision && decision.offset) || 0;
        let rangeLabel = '';
        if (startLine > 0) {
          rangeLabel = endLine > startLine ? `lines ${startLine}–${endLine}` : `from line ${startLine}`;
        } else if (charOffset > 0) {
          rangeLabel = 'continued';
        }
        return buildInlineAgentActivityBase({
          kind: 'read',
          title: 'Read',
          detail: formatAgentActivityPathLabel(targetInfo || 'workspace file'),
          openPath: targetInfo,
          openKind: 'file',
          openStartLine: startLine,
          openEndLine: endLine,
          meta: rangeLabel || 'Open file',
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
      if (tool === 'run_app') {
        const runErrors = Number(toolResult && toolResult.runErrorCount) || 0;
        return buildInlineAgentActivityBase({
          kind: 'validate',
          title: 'Ran the app',
          detail: runErrors
            ? `${runErrors} runtime error${runErrors === 1 ? '' : 's'} at startup.`
            : 'Started cleanly — no runtime errors.',
          hasIssues: runErrors > 0,
          meta: '',
          status: 'done',
        });
      }
      if (tool === 'check_code') {
        const errorCount = Number(toolResult && toolResult.checkErrorCount) || 0;
        return buildInlineAgentActivityBase({
          kind: 'validate',
          title: 'Checked syntax',
          detail: errorCount
            ? `${errorCount} file${errorCount === 1 ? '' : 's'} with parse errors.`
            : 'All files parse cleanly.',
          hasIssues: errorCount > 0,
          meta: '',
          status: 'done',
        });
      }
      if (tool === 'validate_files') {
        const advisoryCount = Array.isArray(toolResult && toolResult.validationAdvisory)
          ? toolResult.validationAdvisory.length
          : 0;
        return buildInlineAgentActivityBase({
          kind: 'validate',
          title: 'Checked files',
          detail: toolResult && toolResult.validationPassed === false
            ? 'Found issues that need repair.'
            : (advisoryCount
              ? `No blocking issues; ${advisoryCount} advisory note${advisoryCount === 1 ? '' : 's'}.`
              : 'No obvious issues found.'),
          hasIssues: Boolean(toolResult && toolResult.validationPassed === false),
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
      const detail = String(plan.summary || '').trim();
      if (!detail) return null;
      // Render the goal summary as a 'thought' so it matches the narration lines
      // below the plan (same style + DOM), instead of the distinct 'plan' note style.
      return {
        kind: 'thought',
        title: '',
        detail,
        meta: '',
        status: 'done',
      };
    }

    function buildAgentCorrectionActivity(detail) {
      const text = String(detail || '').trim();
      if (!text) return null;
      return null;
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
        // Scroll to + highlight the read/edited range; a plain open (no range)
        // clears any previous highlight so the file shows clean.
        const startLine = Math.max(0, Number(activity && activity.openStartLine) || 0);
        const endLine = Math.max(startLine, Number(activity && activity.openEndLine) || 0);
        const hlKind = String(activity && activity.kind || '').toLowerCase() === 'read' ? 'read' : 'edit';
        if (typeof d.revealWorkspaceFileLine === 'function') {
          d.revealWorkspaceFileLine(startLine, endLine, hlKind);
        }
      } else {
        if (typeof d.getWorkspaceNodeState === 'function') d.getWorkspaceNodeState(path).expanded = true;
        if (typeof d.renderArtifacts === 'function') await d.renderArtifacts();
      }
    }

    function buildAgentActivityRow(chatId, activity) {
      if (activity && activity.kind === 'stream_file' && String(activity.streamContent || '').trim()) {
        return buildAgentStreamingFileView({
          path: activity.openPath || activity.detail || 'partial file',
          content: activity.streamContent,
        });
      }
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
      if (activity && activity.kind === 'checklist' && Array.isArray(activity.items) && activity.items.length) {
        const wrap = document.createElement('div');
        wrap.className = 'msg-agent-checklist';
        const doneCount = activity.items.filter((row) => row && row.done).length;
        const head = document.createElement('div');
        head.className = 'msg-agent-checklist-head';
        const headLabel = document.createElement('span');
        headLabel.className = 'msg-agent-checklist-title';
        headLabel.textContent = String(activity.title || 'Plan').trim() || 'Plan';
        const headCount = document.createElement('span');
        headCount.className = 'msg-agent-checklist-count';
        headCount.textContent = `${doneCount}/${activity.items.length}`;
        head.appendChild(headLabel);
        head.appendChild(headCount);
        wrap.appendChild(head);
        activity.items.forEach((row) => {
          const li = document.createElement('div');
          li.className = `msg-agent-checklist-item${row && row.done ? ' done' : ''}`;
          const box = document.createElement('span');
          box.className = 'msg-agent-checklist-box';
          box.setAttribute('aria-hidden', 'true');
          box.textContent = row && row.done ? '✓' : '';
          const text = document.createElement('span');
          text.className = 'msg-agent-checklist-text';
          text.textContent = String(row && row.text ? row.text : '').trim();
          li.appendChild(box);
          li.appendChild(text);
          wrap.appendChild(li);
        });
        return wrap;
      }
      const hasDiffDrawer = Boolean(activity && activity.diffPreview && activity.diffPreview.length);
      const clickable = Boolean(activity && activity.status === 'done' && activity.openPath && !hasDiffDrawer);
      const item = document.createElement(clickable ? 'button' : 'div');
      item.className = `msg-agent-activity-row${activity && activity.status === 'error' ? ' error' : ''}${clickable ? ' clickable' : ''}`;
      if (item instanceof HTMLButtonElement) item.type = 'button';
      const activityRowPath = normalizeWorkspacePath(activity && activity.openPath ? activity.openPath : '');
      if (activityRowPath && activityRowPath !== '/') item.dataset.activityPath = activityRowPath;
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
        const diffKeyBase = `${activity && activity.openPath ? activity.openPath : (activity && activity.detail) || ''}:${activity && activity.ts ? activity.ts : 0}`;
        if (diff && Number(diff.added) > 0) {
          plusEl = document.createElement('span');
          plusEl.className = 'msg-agent-activity-inline-plus';
          setAnimatedCount(plusEl, Number(diff.added), '+', `${diffKeyBase}:+${Number(diff.added)}`);
          inlineRow.appendChild(plusEl);
        }
        if (diff && Number(diff.removed) > 0) {
          minusEl = document.createElement('span');
          minusEl.className = 'msg-agent-activity-inline-minus';
          setAnimatedCount(minusEl, Number(diff.removed), '-', `${diffKeyBase}:-${Number(diff.removed)}`);
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
        detailEl.className = `msg-agent-activity-detail${activity && (activity.kind === 'plan' || activity.kind === 'summary') ? ' plan-note' : ''}`;
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

    function setThoughtPanelExpanded(panel, expanded, animate = true) {
      if (!panel) return;
      panel.dataset.expanded = expanded ? 'true' : 'false';
      const summaryToggle = panel.querySelector('.msg-thought-summary-toggle');
      if (summaryToggle) summaryToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const drawer = panel.querySelector('.msg-agent-activity-drawer');
      if (!drawer) return;
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
        drawer.style.maxHeight = `${drawer.scrollHeight}px`;
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

    function buildThoughtSummaryToggle(label, expanded = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'msg-thought-summary-toggle';
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');

      const labelText = document.createElement('span');
      labelText.className = 'msg-thought-summary-label-text';
      labelText.textContent = String(label || '').trim() || 'Details';
      button.appendChild(labelText);

      const chevron = document.createElement('span');
      chevron.className = 'msg-thought-summary-chevron';
      chevron.innerHTML = `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5"></path>
        </svg>
      `;
      button.appendChild(chevron);

      button.addEventListener('click', () => {
        const panel = button.closest('.msg-thought-panel');
        const nextExpanded = !(panel && panel.dataset.expanded === 'true');
        setThoughtPanelExpanded(panel, nextExpanded, true);
      });
      return button;
    }

    function buildThinkingPanel(thinkingText = '', options = {}) {
      const text = String(thinkingText || '').trim();
      const inProgress = Boolean(options.inProgress);
      if (!text && !inProgress) return null;

      const expanded = inProgress;
      const wrapper = document.createElement('div');
      wrapper.className = 'msg-agent-panel msg-thought-panel';
      if (inProgress) wrapper.classList.add('in-progress');
      wrapper.dataset.expanded = expanded ? 'true' : 'false';
      const label = inProgress
        ? 'Thinking'
        : `Thought for ${formatThoughtDuration(options.startedAt, options.completedAt)}`;
      wrapper.appendChild(buildThoughtSummaryToggle(label, expanded));

      const drawer = document.createElement('div');
      drawer.className = 'msg-agent-activity-drawer';
      if (text) {
        const body = document.createElement('div');
        body.className = 'msg-agent-activity-thought';
        body.textContent = text;
        drawer.appendChild(body);
      }
      wrapper.appendChild(drawer);
      setThoughtPanelExpanded(wrapper, expanded, false);
      return wrapper;
    }

    function classifyActivityPhase(activity) {
      if (!activity || activity.kind === 'thought' || activity.kind === 'error') return 'other';
      if (activity.phase) return String(activity.phase);
      const kind = String(activity.kind || '').toLowerCase();
      const tool = String(activity.tool || '').toLowerCase();
      if (kind === 'project' || kind === 'mkdir') return 'setup';
      if (kind === 'read' || kind === 'scan' || kind === 'search' || kind === 'search_files') return 'explore';
      if (kind === 'write') return 'create';
      if (kind === 'edit') return 'edit';
      if (kind === 'validate') return 'validate';
      if (kind === 'move' || kind === 'delete') return 'cleanup';
      if (tool === 'new_project' || tool === 'mkdir') return 'setup';
      if (tool === 'read_file' || tool === 'search_files' || tool === 'list_dir') return 'explore';
      if (tool === 'write_file') return 'create';
      if (tool === 'edit_file') return 'edit';
      if (tool === 'validate_files') return 'validate';
      if (tool === 'move' || tool === 'delete') return 'cleanup';
      return 'other';
    }

    function groupActivitiesByPhase(rows) {
      const groups = [];
      for (const activity of rows) {
        const phase = classifyActivityPhase(activity);
        const last = groups[groups.length - 1];
        if (phase !== 'other' && last && last.phase === phase) {
          last.items.push(activity);
        } else {
          groups.push({ phase, items: [activity] });
        }
      }
      return groups;
    }

    function buildActivitySubgroup(chatId, group, startExpanded) {
      const { phase, items } = group;
      const runningItem = items.find((a) => a && a.status === 'running');
      const errorItem = items.find((a) => a && a.status === 'error');
      const groupStatus = runningItem ? 'running' : (errorItem ? 'error' : 'done');
      const count = items.length;
      // Structured flag set by the validate activity builder — the old detail-text
      // regex matched the word "issues" inside "no obvious issues found".
      const validateHasIssues = phase === 'validate' && items.some((a) => a && (a.hasIssues === true || a.status === 'error'));
      const setupLabel = (() => {
        const projects = items.filter((a) => a && a.kind === 'project').length;
        const folders = items.filter((a) => a && a.kind === 'mkdir').length;
        if (projects && folders) return folders === 1 ? 'Created project structure' : `Created project + ${folders} folders`;
        if (projects) return projects === 1 ? 'Created project' : `Created ${projects} projects`;
        if (folders) return folders === 1 ? 'Created folder' : `Created ${folders} folders`;
        return 'Prepared workspace';
      })();
      const labelsByPhase = {
        setup: { running: 'Preparing workspace', done: setupLabel },
        create: { running: 'Generating files', done: `Generated ${count} file${count !== 1 ? 's' : ''}` },
        explore: {
          running: 'Inspecting files',
          done: (() => {
            const readItems = items.filter((a) => a && a.kind === 'read');
            const reads = readItems.length;
            const searches = items.filter((a) => a && (a.kind === 'search' || a.kind === 'search_files')).length;
            if (reads && !searches && reads === count) {
              const uniquePaths = new Set(readItems.map((a) => String(a && a.openPath ? a.openPath : '')));
              if (uniquePaths.size === 1) {
                const name = (readItems[0].openPath || '').split('/').filter(Boolean).pop() || 'file';
                // Same file read in chunks — name it, don't claim multiple files.
                return reads === 1 ? `Read ${name}` : `Read ${name} · ${reads} sections`;
              }
              return `Read ${reads} files`;
            }
            if (searches && !reads) return `Searched ${searches} pattern${searches !== 1 ? 's' : ''}`;
            return `Inspected ${count} item${count !== 1 ? 's' : ''}`;
          })()
        },
        edit: { running: 'Applying changes', done: `Updated ${count} file${count !== 1 ? 's' : ''}` },
        validate: { running: 'Checking files', done: validateHasIssues ? 'Checked files \u2014 issues found' : 'Checked files \u2014 no issues found' },
        cleanup: { running: 'Organizing files', done: (() => {
          const moves = items.filter((a) => a && a.kind === 'move').length;
          const deletes = items.filter((a) => a && a.kind === 'delete').length;
          if (moves && !deletes) return `Moved ${moves} item${moves !== 1 ? 's' : ''}`;
          if (deletes && !moves) return `Removed ${deletes} item${deletes !== 1 ? 's' : ''}`;
          return `Reorganized ${count} item${count !== 1 ? 's' : ''}`;
        })() },
      };
      const labels = labelsByPhase[phase] || { running: 'Working', done: `${count} steps` };
      const label = groupStatus === 'running' ? labels.running : labels.done;
      const expanded = Boolean(startExpanded);

      const subgroup = document.createElement('div');
      subgroup.className = `msg-agent-subgroup${groupStatus === 'error' ? ' error' : ''}`;
      subgroup.dataset.expanded = expanded ? 'true' : 'false';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'msg-agent-subgroup-toggle';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');

      const labelEl = document.createElement('span');
      labelEl.className = 'msg-agent-subgroup-label';
      labelEl.textContent = label;
      toggle.appendChild(labelEl);

      const chevron = document.createElement('span');
      chevron.className = 'msg-agent-subgroup-chevron';
      chevron.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"></path></svg>`;
      toggle.appendChild(chevron);
      subgroup.appendChild(toggle);

      const drawer = document.createElement('div');
      drawer.className = 'msg-agent-subgroup-drawer';
      items.forEach((activity) => drawer.appendChild(buildAgentActivityRow(chatId, activity)));
      subgroup.appendChild(drawer);
      if (!expanded) {
        drawer.hidden = true;
        drawer.style.maxHeight = '0px';
        drawer.style.opacity = '0';
      }

      toggle.addEventListener('click', () => {
        const isExpanded = subgroup.dataset.expanded === 'true';
        const next = !isExpanded;
        subgroup.dataset.expanded = next ? 'true' : 'false';
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
        if (next) {
          drawer.hidden = false;
          drawer.style.maxHeight = '0px';
          drawer.style.opacity = '0';
          requestAnimationFrame(() => {
            drawer.style.maxHeight = `${drawer.scrollHeight}px`;
            drawer.style.opacity = '1';
          });
          const settle = () => { drawer.style.maxHeight = 'none'; drawer.removeEventListener('transitionend', settle); };
          drawer.addEventListener('transitionend', settle);
        } else {
          drawer.style.maxHeight = `${drawer.scrollHeight}px`;
          drawer.style.opacity = '1';
          requestAnimationFrame(() => {
            drawer.style.maxHeight = '0px';
            drawer.style.opacity = '0';
          });
          const settle = () => { drawer.hidden = true; drawer.removeEventListener('transitionend', settle); };
          drawer.addEventListener('transitionend', settle);
        }
      });

      return subgroup;
    }

    function buildLiveRowsWithStreamingFile(rows, streamingFile, completed) {
      const liveRows = Array.isArray(rows) ? rows.slice() : [];
      if (completed || !streamingFile || typeof streamingFile !== 'object') return liveRows;
      const content = String(streamingFile.content || '').trim();
      if (!content) return liveRows;
      if (liveRows.some((activity) => activity && activity.kind === 'stream_file')) return liveRows;

      const streamPath = normalizeWorkspacePath(streamingFile.path || '');
      const streamActivity = {
        kind: 'stream_file',
        title: 'Streaming file',
        detail: formatAgentActivityPathLabel(streamPath || streamingFile.path || 'file'),
        openPath: streamPath && streamPath !== '/' ? streamPath : '',
        openKind: 'file',
        status: 'done',
        streamContent: content,
        ts: nowTs(),
      };

      let insertAfter = -1;
      for (let i = liveRows.length - 1; i >= 0; i -= 1) {
        const activity = liveRows[i];
        if (!activity) continue;
        const activityPath = normalizeWorkspacePath(activity.openPath || '');
        if (streamPath && activityPath === streamPath) {
          insertAfter = i;
          break;
        }
      }
      if (insertAfter >= 0) {
        liveRows.splice(insertAfter + 1, 0, streamActivity);
      } else {
        liveRows.push(streamActivity);
      }
      return liveRows;
    }

    function buildAgentActivityPanel(chatId, activities, options = {}) {
      const normalizedRows = normalizeAgentActivities(activities);
      const meta = normalizeAgentMeta(options.agentMeta);
      const completed = Boolean(meta && meta.completedAt);
      const expanded = completed ? meta.collapsed === false : true;
      const streamingFile = options.streamingFile && typeof options.streamingFile === 'object' ? options.streamingFile : null;
      // Pending rows are represented by the live loader/status text. Keep them
      // hidden in the activity list so "Writing file" is not duplicated above
      // the streaming preview and again below it.
      const baseRows = normalizedRows.filter((activity) => activity && activity.status !== 'pending');
      const rows = buildLiveRowsWithStreamingFile(baseRows, streamingFile, completed);
      const wrapper = document.createElement('div');
      wrapper.className = `msg-agent-panel${completed ? ' completed' : ''}`;
      wrapper.dataset.expanded = expanded ? 'true' : 'false';
      const statusText = String(options.statusText || '').trim();
      if (rows.length > 0) {
        const list = document.createElement('div');
        list.className = 'msg-agent-activity-list';
        if (completed) wrapper.appendChild(buildAgentActivitySummaryToggle(chatId, Number(options.messageTs) || 0, meta));
        const alwaysGroupPhases = new Set(['setup', 'validate', 'cleanup']);
        const groups = groupActivitiesByPhase(rows);
        groups.forEach((group, groupIndex) => {
          const isLastGroup = groupIndex === groups.length - 1;
          const groupHasRunning = group.items.some((a) => a && a.status === 'running');
          const groupHasError = group.items.some((a) => a && a.status === 'error');
          // While streaming, keep every group expanded so completed steps stay visible
          // and the worked log accumulates — collapsing a finished group the instant work
          // moves on reads as "the steps got removed". On the finalized message, collapse
          // as usual (errors stay open).
          const groupStartExpanded = completed ? groupHasError : true;
          if (group.phase === 'other' || (group.items.length < 2 && !alwaysGroupPhases.has(group.phase))) {
            group.items.forEach((activity) => list.appendChild(buildAgentActivityRow(chatId, activity)));
          } else {
            list.appendChild(buildActivitySubgroup(chatId, group, groupStartExpanded));
          }
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

    // Live view of a file being generated — fills in as tokens stream, with a
    // line counter (+N) that grows in real time. Shows the tail like a terminal.
    function buildAgentStreamingFileView(streamingFile) {
      const path = String(streamingFile.path || '').replace(/^\//, '') || 'file';
      const content = String(streamingFile.content || '');
      const lineCount = content ? content.split('\n').length : 0;
      const box = document.createElement('div');
      box.className = 'msg-agent-stream-file';
      const head = document.createElement('div');
      head.className = 'msg-agent-stream-file-head';
      const name = document.createElement('span');
      name.className = 'msg-agent-stream-file-name';
      name.textContent = path;
      // Neutral live line count — NOT a green "+N", because while generating an
      // edit/rewrite this is the size of the content, not the real diff. The
      // accurate +A/-B animates on the committed row once the change is known.
      const meter = document.createElement('span');
      meter.className = 'msg-agent-activity-inline-meta';
      meter.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}`;
      head.appendChild(name);
      head.appendChild(meter);
      const pre = document.createElement('pre');
      pre.className = 'msg-agent-stream-file-body';
      pre.textContent = content.split('\n').slice(-24).join('\n');
      box.appendChild(head);
      box.appendChild(pre);
      return box;
    }

    // Expand the "work" panel (main collapsible) and scroll to it; with a path,
    // also open that file's edit row and its diff drawer.
    function revealAgentWorkPanel(bubble, path = '') {
      const panel = bubble ? bubble.querySelector('.msg-agent-panel') : null;
      if (!panel) return;
      setAgentPanelExpanded(panel, true, true);
      window.setTimeout(() => {
        let target = panel;
        if (path) {
          const rows = panel.querySelectorAll('.msg-agent-activity-row[data-activity-path]');
          for (const row of rows) {
            if (row.dataset.activityPath !== path) continue;
            target = row;
            if (row.classList.contains('diff-toggle')) break;
          }
        }
        if (target !== panel) {
          const subgroup = target.closest('.msg-agent-subgroup');
          if (subgroup && subgroup.dataset.expanded !== 'true') {
            const toggle = subgroup.querySelector('.msg-agent-subgroup-toggle');
            if (toggle) toggle.click();
          }
          if (target.classList.contains('diff-toggle') && target.getAttribute('aria-expanded') !== 'true') {
            target.click();
          }
        }
        window.setTimeout(() => {
          try {
            target.scrollIntoView({ behavior: 'smooth', block: target === panel ? 'start' : 'center' });
          } catch (_) { }
        }, 140);
      }, 60);
    }

    // Per-response edit summary card, rendered at the bottom of the message
    // (after the final message, before the action icons). The aggregate +A/-R
    // swaps to "Review changes ↗" on hover; rows reveal that file's edit inside
    // the work panel.
    function buildAgentEditCard(chatId, messageTs, meta, editedFiles, bubble) {
      const reverted = meta.reverted === true;
      const totalAdded = editedFiles.reduce((sum, file) => sum + file.added, 0);
      const totalRemoved = editedFiles.reduce((sum, file) => sum + file.removed, 0);
      const rememberPanelExpanded = () => {
        if (typeof d.updateAssistantAgentMeta === 'function') {
          void d.updateAssistantAgentMeta(chatId, messageTs, (current) => ({
            ...(current || {}),
            collapsed: false,
          }), { rerender: false });
        }
      };

      const card = document.createElement('div');
      card.className = `msg-agent-editcard${reverted ? ' reverted' : ''}`;

      const header = document.createElement('div');
      header.className = 'msg-agent-editcard-header';

      const icon = document.createElement('span');
      icon.className = 'msg-agent-editcard-icon';
      icon.innerHTML = `
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="14" height="14" rx="4"></rect>
          <path d="M10 6.8v3.4M8.3 8.5h3.4"></path>
          <path d="M8.3 12.8h3.4"></path>
        </svg>
      `;
      header.appendChild(icon);

      const titles = document.createElement('div');
      titles.className = 'msg-agent-editcard-titles';
      const createdCount = meta.revert.files.length - editedFiles.length;
      const title = document.createElement('div');
      title.className = 'msg-agent-editcard-title';
      title.textContent = `Edited ${editedFiles.length} file${editedFiles.length === 1 ? '' : 's'}${createdCount > 0 ? ` · ${createdCount} new file${createdCount === 1 ? '' : 's'}` : ''}${reverted ? ' · reverted' : ''}`;
      titles.appendChild(title);

      const statsSwap = document.createElement('button');
      statsSwap.type = 'button';
      statsSwap.className = 'msg-agent-editcard-statswap';
      statsSwap.innerHTML = `
        <span class="msg-agent-editcard-stats"><span class="plus">+${totalAdded}</span> <span class="minus">-${totalRemoved}</span></span>
        <span class="msg-agent-editcard-review-link">Review changes
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 11 11 5"></path>
            <path d="M6.5 5H11v4.5"></path>
          </svg>
        </span>
      `;
      statsSwap.addEventListener('click', () => {
        revealAgentWorkPanel(bubble);
        rememberPanelExpanded();
      });
      titles.appendChild(statsSwap);
      header.appendChild(titles);

      const actions = document.createElement('div');
      actions.className = 'msg-agent-editcard-actions';
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'msg-agent-editcard-undo ui-tooltip-anchor';
      undoBtn.dataset.tooltip = reverted
        ? 'Re-apply the changes from this response'
        : `Restore the edited files to their state just before this response${createdCount > 0 ? ` and remove the ${createdCount} new file${createdCount === 1 ? '' : 's'} it created (moved to Trash)` : ''}`;
      undoBtn.innerHTML = `
        <span>${reverted ? 'Redo' : 'Undo'}</span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.5 6.5h-6a3 3 0 0 0 0 6h4"></path>
          <path d="M10 3.5l3 3-3 3"></path>
        </svg>
      `;
      undoBtn.addEventListener('click', async () => {
        if (undoBtn.disabled) return;
        undoBtn.disabled = true;
        try {
          await d.revertAgentMessageEdits(chatId, messageTs);
        } finally {
          undoBtn.disabled = false;
        }
      });
      actions.appendChild(undoBtn);
      header.appendChild(actions);
      card.appendChild(header);

      const fileList = document.createElement('div');
      fileList.className = 'msg-agent-editcard-files';
      const visibleCount = 3;
      editedFiles.forEach((file, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'msg-agent-editcard-row';
        if (index >= visibleCount) row.hidden = true;
        const pathEl = document.createElement('span');
        pathEl.className = 'msg-agent-editcard-row-path';
        pathEl.textContent = file.path.replace(/^\//, '');
        row.appendChild(pathEl);
        const rowStats = document.createElement('span');
        rowStats.className = 'msg-agent-editcard-stats';
        rowStats.innerHTML = `<span class="plus">+${file.added}</span> <span class="minus">-${file.removed}</span>`;
        row.appendChild(rowStats);
        row.addEventListener('click', () => {
          revealAgentWorkPanel(bubble, file.path);
          rememberPanelExpanded();
        });
        fileList.appendChild(row);
      });
      card.appendChild(fileList);

      if (editedFiles.length > visibleCount) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'msg-agent-editcard-more';
        const hiddenCount = editedFiles.length - visibleCount;
        const setMoreLabel = (expanded) => {
          moreBtn.innerHTML = `
            <span>${expanded ? 'Show fewer files' : `Show ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}`}</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform: rotate(${expanded ? 180 : 0}deg)">
              <path d="M4.5 6.5 8 10l3.5-3.5"></path>
            </svg>
          `;
        };
        setMoreLabel(false);
        moreBtn.addEventListener('click', () => {
          const expanded = moreBtn.dataset.expanded === 'true';
          const next = !expanded;
          moreBtn.dataset.expanded = next ? 'true' : 'false';
          Array.from(fileList.children).forEach((row, index) => {
            if (index >= visibleCount) row.hidden = !next;
          });
          setMoreLabel(next);
        });
        card.appendChild(moreBtn);
      }

      return card;
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
      const thinkingPanel = buildThinkingPanel(options.thinkingText || '', {
        inProgress: shouldShowThinkingLoader,
        startedAt: options.thinkingStartedAt,
        completedAt: options.thinkingCompletedAt,
      });
      if (options.showCanvasLoader) {
        bubble.appendChild(buildCanvasLoader(displayText, options.canvasRawText));
        return;
      }
      if (thinkingPanel) bubble.appendChild(thinkingPanel);
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
      // Edit summary card at the bottom of the finished response (before the
      // message action icons). Edited files only — a response that only created
      // files gets no card.
      if (normalizedAgentMeta && normalizedAgentMeta.completedAt && normalizedAgentMeta.revert
        && typeof d.revertAgentMessageEdits === 'function') {
        const editedSnapshotFiles = normalizedAgentMeta.revert.files.filter((file) => file.existedBefore);
        if (editedSnapshotFiles.length) {
          bubble.appendChild(buildAgentEditCard(
            options.chatId || '',
            Number(options.messageTs) || 0,
            normalizedAgentMeta,
            editedSnapshotFiles,
            bubble,
          ));
        }
      }
    }

    function populateUserBubble(bubble, text) {
      const source = String(text || '').trim();
      const lineCount = source ? source.split(/\n/).length : 0;
      const shouldCollapse = source.length > 280 || lineCount > 5;
      if (!shouldCollapse) {
        bubble.textContent = source;
        return;
      }

      const body = document.createElement('div');
      body.className = 'msg-user-text is-collapsed';
      body.textContent = source;
      bubble.appendChild(body);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'msg-user-expand-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.innerHTML = `
        <span class="msg-user-expand-label">Show more</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6"></path>
        </svg>
      `;
      toggle.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        const nextExpanded = !expanded;
        body.classList.toggle('is-collapsed', !nextExpanded);
        body.classList.toggle('is-expanded', nextExpanded);
        toggle.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
        const label = toggle.querySelector('.msg-user-expand-label');
        if (label) label.textContent = nextExpanded ? 'Show less' : 'Show more';
      });
      bubble.appendChild(toggle);
    }

    function buildMsgNode(role, text, chatId = '', messageTs = 0, loopDetected = false, thinkingText = '', branchAnchorTs = 0, agentActivities = [], agentMeta = null, displayTs = 0, thinkingMeta = null, attachments = []) {
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
        populateAssistantBubble(bubble, renderText, {
          chatId,
          agentActivities,
          agentMeta,
          messageTs,
          thinkingText,
          thinkingStartedAt: Number(thinkingMeta && thinkingMeta.startedAt) || 0,
          thinkingCompletedAt: Number(thinkingMeta && thinkingMeta.completedAt) || 0,
        });
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
        populateUserBubble(bubble, renderText);
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

      // Attachment capsule(s) — show the files the user attached to this message.
      if (role === 'user' && Array.isArray(attachments) && attachments.length) {
        const chips = document.createElement('div');
        chips.className = 'msg-attachment-chips';
        attachments.forEach((a) => {
          const nm = String((a && a.name) || 'attachment');
          const chip = document.createElement('span');
          chip.className = 'msg-attachment-chip';
          chip.title = nm;
          const icon = (a && a.kind) === 'text' ? '📄' : '📎';
          chip.textContent = `${icon} ${nm}`;
          chips.appendChild(chip);
        });
        bubble.appendChild(chips);
      }

      stack.appendChild(bubble);

      if (role === 'ai' || role === 'user') {
        const actions = document.createElement('div');
        actions.className = `msg-action-rail ${role}`;
        const makeTimeNode = () => {
          const ts = Number(displayTs) || Number(messageTs) || 0;
          const label = ts && typeof d.formatMessageClockTime === 'function'
            ? d.formatMessageClockTime(ts)
            : '';
          if (!label) return null;
          const node = document.createElement('span');
          node.className = 'msg-action-time';
          node.textContent = label;
          const full = typeof d.formatMessageFullTime === 'function'
            ? d.formatMessageFullTime(ts)
            : '';
          if (full) node.title = full;
          return node;
        };
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
          const timeNode = makeTimeNode();
          if (timeNode) actions.appendChild(timeNode);
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
          const timeNode = makeTimeNode();
          if (timeNode) actions.appendChild(timeNode);
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
          Number(msg.displayTs) || 0,
          msg.thinkingMeta || null,
          Array.isArray(msg.attachments) ? msg.attachments : [],
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
