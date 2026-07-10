// Agent run event protocol v1 — durable thread/turn/item lifecycle records.
// Each agent run (turn) emits typed, sequenced events persisted as JSONL via
// the native bridge (data/logs/agent_runs.jsonl). Events OBSERVE the run —
// they never decide anything (see docs/DECISION_AUTHORITY.md).
//
// Entry shape: { v, seq, ts, threadId, turnId, itemId, type, state, data }
//   type:  turn | plan | decision | tool | note
//   state: started | completed | failed | cancelled | timed_out
//          | awaiting_approval | blocked
(function (global) {
  const PROTOCOL_VERSION = 1;
  const TERMINAL_TURN_STATES = ['completed', 'failed', 'cancelled', 'timed_out'];

  function clipText(value, maxLen = 300) {
    const text = String(value == null ? '' : value).replace(/\r/g, '');
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…[+${text.length - maxLen}]`;
  }

  // Guard blocks and approval pauses are distinct lifecycle states, not failures.
  function classifyToolEventState(ev) {
    if (!ev || typeof ev !== 'object') return 'failed';
    const policy = String(ev.commandPolicy || '').toLowerCase();
    if (policy === 'ask_first') return 'awaiting_approval';
    if (policy === 'blocked') return 'blocked';
    if (ev._guardBlock) return 'blocked';
    return ev.ok ? 'completed' : 'failed';
  }

  // Lean, body-free item payload: paths, sizes, and outcome — never file content.
  function summarizeToolEventData(ev) {
    if (!ev || typeof ev !== 'object') return {};
    const data = {
      tool: String(ev.tool || ''),
      path: String(ev.path || ''),
    };
    if (ev.srcPath) data.srcPath = String(ev.srcPath);
    if (ev.dstPath) data.dstPath = String(ev.dstPath);
    if (typeof ev.mutated === 'boolean') data.mutated = ev.mutated;
    if (typeof ev.createdNewFile === 'boolean' && ev.createdNewFile) data.createdNewFile = true;
    if (Number(ev.runErrorCount) > 0) data.runErrorCount = Number(ev.runErrorCount);
    if (typeof ev.validationPassed === 'boolean') data.validationPassed = ev.validationPassed;
    if (typeof ev.content === 'string' && ev.content) data.contentBytes = ev.content.length;
    if (ev.terminalCommand) data.command = clipText(ev.terminalCommand, 200);
    if (ev.observation) data.observation = clipText(ev.observation, 300);
    return data;
  }

  function createRunEventLog(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const persist = typeof opts.persist === 'function' ? opts.persist : null;
    const threadId = String(opts.threadId || '');
    const turnId = `run-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let seq = 0;
    let ended = false;
    let toolCount = 0;

    const emit = (type, state, data) => {
      seq += 1;
      const entry = {
        v: PROTOCOL_VERSION,
        seq,
        ts: now(),
        threadId,
        turnId,
        itemId: `${turnId}:${seq}`,
        type: String(type || 'note'),
        state: String(state || 'completed'),
        data: data && typeof data === 'object' ? data : {},
      };
      if (persist) {
        // Best-effort, fire-and-forget: persistence must never affect the run.
        try {
          const res = persist(entry);
          if (res && typeof res.catch === 'function') res.catch(() => undefined);
        } catch (_) { /* never throw into the loop */ }
      }
      return entry;
    };

    emit('turn', 'started', { task: clipText(opts.task, 400) });

    return {
      turnId,
      threadId,
      get seq() { return seq; },
      get ended() { return ended; },
      emit,
      emitToolEvent(ev) {
        toolCount += 1;
        return emit('tool', classifyToolEventState(ev), summarizeToolEventData(ev));
      },
      emitPlan(planSpec) {
        const spec = planSpec && typeof planSpec === 'object' ? planSpec : {};
        return emit('plan', 'completed', {
          taskKind: String(spec.taskKind || ''),
          phased: Boolean(spec.phased || spec._activePhase),
          expectedFiles: Array.isArray(spec.expectedFiles) ? spec.expectedFiles.length : 0,
          doneCriteria: Array.isArray(spec.doneCriteria) ? spec.doneCriteria.length : 0,
        });
      },
      emitDecision(step, source, decision) {
        const d = decision && typeof decision === 'object' ? decision : {};
        return emit('decision', 'completed', {
          step: Number(step) || 0,
          source: String(source || 'model'),
          action: String(d.action || ''),
          tool: String(d.tool || ''),
          path: String(d.path || ''),
        });
      },
      emitDecisionFailure(step, reason, timedOut) {
        return emit('decision', 'failed', {
          step: Number(step) || 0,
          reason: clipText(reason, 240),
          timedOut: Boolean(timedOut),
        });
      },
      // Idempotent terminal event — first call wins, every exit path may call it.
      end(info) {
        if (ended) return null;
        ended = true;
        const detail = info && typeof info === 'object' ? info : {};
        const state = detail.errored ? 'failed'
          : detail.cancelled ? 'cancelled'
            : detail.timedOut ? 'timed_out'
              : 'completed';
        const data = { toolCount };
        if (detail.message) data.message = clipText(detail.message, 300);
        return emit('turn', state, data);
      },
    };
  }

  // Tolerant JSONL parse — skips corrupt lines (e.g. a torn tail write).
  function parseRunEventLines(text) {
    const entries = [];
    String(text || '').split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && parsed.turnId && parsed.type) entries.push(parsed);
      } catch (_) { /* skip torn line */ }
    });
    return entries;
  }

  // Group entries into per-turn lifecycle summaries; a turn with no terminal
  // event was interrupted (crash/reload) — the whole point of the durable log.
  function summarizeRunLifecycle(entries) {
    const turns = new Map();
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry || !entry.turnId) return;
      let turn = turns.get(entry.turnId);
      if (!turn) {
        turn = {
          turnId: String(entry.turnId),
          threadId: String(entry.threadId || ''),
          task: '',
          firstTs: Number(entry.ts) || 0,
          lastTs: Number(entry.ts) || 0,
          eventCount: 0,
          terminalState: null,
          interrupted: true,
          tools: { completed: 0, failed: 0, blocked: 0, awaiting_approval: 0 },
          decisions: { completed: 0, failed: 0 },
        };
        turns.set(entry.turnId, turn);
      }
      turn.eventCount += 1;
      const ts = Number(entry.ts) || 0;
      if (ts && (!turn.firstTs || ts < turn.firstTs)) turn.firstTs = ts;
      if (ts > turn.lastTs) turn.lastTs = ts;
      const state = String(entry.state || '');
      if (entry.type === 'turn') {
        if (state === 'started' && entry.data && entry.data.task) turn.task = String(entry.data.task);
        if (TERMINAL_TURN_STATES.includes(state)) {
          turn.terminalState = state;
          turn.interrupted = false;
        }
      } else if (entry.type === 'tool') {
        if (Object.prototype.hasOwnProperty.call(turn.tools, state)) turn.tools[state] += 1;
      } else if (entry.type === 'decision') {
        if (Object.prototype.hasOwnProperty.call(turn.decisions, state)) turn.decisions[state] += 1;
      }
    });
    return Array.from(turns.values()).sort((a, b) => a.firstTs - b.firstTs);
  }

  global.AIExeAgentEvents = {
    PROTOCOL_VERSION,
    TERMINAL_TURN_STATES,
    createRunEventLog,
    classifyToolEventState,
    summarizeToolEventData,
    parseRunEventLines,
    summarizeRunLifecycle,
  };
})(typeof window !== 'undefined' ? window : globalThis);
