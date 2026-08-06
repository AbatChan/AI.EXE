// Replay real recorded agent runs through the SHIPPED guard code and assert the
// harness always leaves the model a legal move.
//
// Why a replay and not a scenario: v10.0.2/10.0.3/10.0.4 each fixed "guards
// deadlocked a run" and each shipped a passing test written by the same person who
// wrote the theory of the bug — such a test can only confirm the theory. These
// fixtures are recordings of runs that actually died (scripts/extract_deadlock_fixture.js),
// so they are independent of any theory about why.
//
// Structure:
//   1. FIDELITY  — the replay must reproduce the recorded guard blocks. An
//                  instrument that cannot reproduce history proves nothing.
//   2. LIVENESS  — invariants about the harness, checked against every run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));
require(path.join(__dirname, '..', 'ui', 'agent-loop.js'));

const { parseAgentDecision } = global.AIExeAgentCore.createAgentCore({});
const {
  countInspectionsSinceMutation,
  countConsecutiveGuardBlocks,
  guardShouldStandDown,
  preferSuccessfulReadIndex,
  RELEASABLE_GUARDS,
  hasRelevantWorkspaceMutationSince,
} = global.AIExeAgentLoop;
assert.equal(typeof preferSuccessfulReadIndex, 'function', 'preferSuccessfulReadIndex is exported');
assert.equal(typeof guardShouldStandDown, 'function', 'guardShouldStandDown is exported');
assert.equal(typeof hasRelevantWorkspaceMutationSince, 'function', 'path-scoped mutation check is exported');

const normPath = (value) => `/${String(value || '').replace(/^\/+/, '')}`;
const mutationTool = (tool) => ['write_file', 'edit_file', 'move', 'delete'].includes(String(tool || '').toLowerCase());
const crossFileTrace = [
  { tool: 'read_file', ok: true, path: '/requirements.txt' },
  { tool: 'edit_file', ok: true, path: '/main.py' },
  { tool: 'edit_file', ok: true, path: '/organizer.py' },
];
assert.equal(
  hasRelevantWorkspaceMutationSince(crossFileTrace, 0, '/requirements.txt', normPath, mutationTool),
  false,
  'edits to other files do not stale the cached requirements.txt read',
);
assert.equal(
  hasRelevantWorkspaceMutationSince(
    [...crossFileTrace, { tool: 'edit_file', ok: true, path: '/requirements.txt' }],
    0,
    '/requirements.txt',
    normPath,
    mutationTool,
  ),
  true,
  'an edit to requirements.txt itself does stale its cached read',
);

// Observation helpers — these belong to the TEST, not the harness. They read what
// a failing build said about itself so the invariants can ask whether the model was
// ever allowed to look at it. Deliberately not shipped: a guard rule built on this
// was written, found to be unreachable code once the budget reset on a failing run,
// and removed. The invariant stays so its absence is noticed if that changes.
const FAILURE_NAMED_PATH = /(?:^|[\s(>'"])(\.?\/?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,4})(?::\d+)?/g;
function pathsNamedByRecentFailure(toolEvents) {
  const events = Array.isArray(toolEvents) ? toolEvents : [];
  const named = new Set();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || !event.ok) continue;
    const tool = String(event.tool || '').toLowerCase();
    if (tool !== 'run_command' && tool !== 'run_app') continue;
    if (!Number(event.runErrorCount || 0)) continue;
    let match;
    FAILURE_NAMED_PATH.lastIndex = 0;
    while ((match = FAILURE_NAMED_PATH.exec(String(event.observation || '')))) {
      const p = `/${String(match[1] || '').replace(/^\.?\//, '')}`;
      if (!/node_modules|\/\.next\/|\/dist\/|\/logs?\//.test(p)) named.add(p);
    }
    break; // most recent failing run only
  }
  return named;
}
function failureNamedPathIsUnread(toolEvents, targetPath) {
  const target = String(targetPath || '');
  if (!target) return false;
  if (!pathsNamedByRecentFailure(toolEvents).has(target)) return false;
  return !(Array.isArray(toolEvents) ? toolEvents : []).some((event) => (
    event && event.ok
    && ['read_file', 'read_files'].includes(String(event.tool || '').toLowerCase())
    && String(event.path || '') === target
  ));
}

const runs = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agent_guard_deadlock_runs.json'), 'utf8'));
assert.ok(runs.length >= 5, 'fixture holds a corpus of real runs');

const INSPECTION_TOOLS = ['read_file', 'read_files', 'search_files'];
const MUTATION_TOOLS = ['write_file', 'write_files', 'edit_file', 'new_project', 'mkdir', 'move', 'delete'];

// The counting rule EXACTLY as it shipped when these runs were recorded. Frozen on
// purpose: it is the oracle the fidelity check uses to prove the toolEvents
// reconstruction is faithful. Using the live function there would make the check
// vacuous the moment the live function changes — which is the change under test.
function originalCountInspections(toolEvents) {
  const events = Array.isArray(toolEvents) ? toolEvents : [];
  let inspections = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || !e.ok) continue;
    const tool = String(e.tool || '').toLowerCase();
    if (tool === 'write_file' || tool === 'edit_file' || tool === 'new_project') break;
    if (tool === 'read_files') inspections += 1;
    else if (tool === 'read_file' && !e._fromBatchRead) inspections += 1;
    else if (tool === 'search_files') inspections += 1;
  }
  return inspections;
}

// The cap rule as shipped (agent-loop.js): a phase that has produced no mutation
// yet is treated as "creation work" and gets a much tighter budget.
function inspectionCapFor(tool, noMutationsYet) {
  if (noMutationsYet) return tool === 'search_files' ? 4 : 3;
  return tool === 'search_files' ? 7 : 6;
}

// Feed the RECORDED decision sequence through the CURRENT guard code.
//
// The recording supplies which guard wanted to veto (it vetoed, on this exact
// state); the shipped code decides whether it still gets to. That split is what
// keeps the test honest — the veto conditions are historical fact, not something
// this file re-implements, and the only thing under test is the harness's answer.
//
// It is also deliberately pessimistic: the model is replayed as maximally stubborn,
// repeating its recorded proposals even when a release would have handed it new
// content. Liveness proven against that model holds against a real one.
function replayRunAgainstCurrentCode(run) {
  const toolEvents = [];
  const steps = [];

  const byStep = new Map();
  run.events.forEach((event) => {
    if (!byStep.has(event.step)) byStep.set(event.step, []);
    byStep.get(event.step).push(event);
  });

  [...byStep.keys()].sort((a, b) => a - b).forEach((step) => {
    const events = byStep.get(step);
    const planner = events.find((e) => e.kind === 'agent_planner_output');
    const decision = planner ? parseAgentDecision(String(planner.rawPlannerOutput || '')) : null;
    const tool = String((decision && decision.tool) || '').toLowerCase();
    const declPath = String((decision && decision.path) || '');
    const result = events.find((e) => e.kind === 'agent_tool_result');

    // Which guard vetoed here, historically.
    const budgetEvent = events.find((e) => e.kind === 'agent_inspection_budget_blocked');
    let guard = null;
    if (budgetEvent) guard = 'enough_context';
    else if (events.some((e) => e.kind === 'agent_read_loop_blocked')) guard = 'already_read';
    else if (result && !result.ok && /blocked for|blocked:/.test(String(result.observation || ''))) guard = 'no_change_since_last_run';

    let blocked = false;
    if (guard) {
      // Does the guard still WANT to veto under the current code? For the budget
      // guard, recompute the count with the shipped function against the threshold
      // the run actually used — no unobservable cap to guess at.
      let wants = true;
      if (guard === 'enough_context' && budgetEvent && budgetEvent.inspections != null) {
        wants = countInspectionsSinceMutation(toolEvents) >= budgetEvent.inspections;
      }
      blocked = wants && !guardShouldStandDown(guard, toolEvents, declPath);
    }

    const previous = toolEvents[toolEvents.length - 1];
    steps.push({
      step, tool, path: declPath, guard, blocked,
      inspections: countInspectionsSinceMutation(toolEvents),
      consecutive: countConsecutiveGuardBlocks(toolEvents),
      // Was the last thing that happened a build/run that failed? Then the model
      // is acting on fresh evidence, not padding its context.
      afterFailingRun: Boolean(previous && previous.ok
        && ['run_command', 'run_app'].includes(String(previous.tool || '').toLowerCase())
        && Number(previous.runErrorCount || 0) > 0),
      failureNamedTarget: failureNamedPathIsUnread(toolEvents, declPath),
      observation: String((result && result.observation) || ''),
      ok: Boolean(result && result.ok) && !blocked,
    });

    if (blocked) {
      toolEvents.push({ tool: tool || 'read_file', ok: false, _guardBlock: true, _guardReason: guard, path: declPath });
      return;
    }
    if (guard) {
      // Released (or no longer wanted): the tool runs. A released read succeeds.
      toolEvents.push({ tool: tool || 'read_file', ok: true, _released: true, path: declPath, observation: 'released by arbiter' });
      return;
    }
    if (events.some((e) => e.kind === 'agent_read_served_from_cache')) {
      toolEvents.push({ tool: 'read_file', ok: true, _guardBlock: true, path: declPath, observation: 'served from cache' });
      return;
    }
    if (events.some((e) => e.kind === 'agent_guard_deadlock_broken')) {
      toolEvents.push({ tool: 'read_file', ok: true, _deadlockBreak: true, path: declPath, observation: 'deadlock break' });
      return;
    }
    if (result) {
      const observation = String(result.observation || '');
      toolEvents.push({
        tool: String(result.tool || ''), ok: Boolean(result.ok),
        path: String(result.path || ''), content: String(result.content || ''),
        observation,
        // The fixture does not carry runErrorCount; recover it the way the
        // executor sets it, so failure-named paths resolve.
        runErrorCount: /exited with code [1-9]|Failed to compile|Type error:/.test(observation) ? 1 : 0,
        offset: Number(result.offset || 0),
        startLine: Number(result.startLine || 0),
        endLine: Number(result.endLine || 0),
      });
    }
  });

  return steps;
}

// Rebuild the toolEvents array the loop ACTUALLY held, from the recording. Used
// only to validate the instrument against ground truth.
function replayRun(run) {
  const toolEvents = [];
  const steps = [];
  let noMutationsYet = true;

  const byStep = new Map();
  run.events.forEach((event) => {
    if (!byStep.has(event.step)) byStep.set(event.step, []);
    byStep.get(event.step).push(event);
  });

  [...byStep.keys()].sort((a, b) => a - b).forEach((step) => {
    const events = byStep.get(step);
    const planner = events.find((e) => e.kind === 'agent_planner_output');
    const decision = planner ? parseAgentDecision(String(planner.rawPlannerOutput || '')) : null;
    const tool = String((decision && decision.tool) || '').toLowerCase();

    // What the harness ACTUALLY did at this step, per the recording.
    const budgetBlocked = events.some((e) => e.kind === 'agent_inspection_budget_blocked');
    const readLoopBlocked = events.some((e) => e.kind === 'agent_read_loop_blocked');
    const servedFromCache = events.some((e) => e.kind === 'agent_read_served_from_cache');
    const deadlockBroken = events.some((e) => e.kind === 'agent_guard_deadlock_broken');
    const result = events.find((e) => e.kind === 'agent_tool_result');
    const duplicateBlocked = Boolean(result && !result.ok && /blocked for|blocked:/.test(String(result.observation || '')));

    // Oracle count — the rule in force when this run was recorded.
    const inspections = originalCountInspections(toolEvents);
    const predictedBudgetBlock = INSPECTION_TOOLS.includes(tool)
      && inspections >= inspectionCapFor(tool, noMutationsYet);

    steps.push({
      step,
      tool,
      path: String((decision && decision.path) || ''),
      recordedInspections: (events.find((e) => e.kind === 'agent_inspection_budget_blocked') || {}).inspections,
      inspections,
      predictedBudgetBlock,
      budgetBlocked,
      blocked: budgetBlocked || readLoopBlocked || duplicateBlocked,
      observation: String((result && result.observation) || ''),
      ok: Boolean(result && result.ok),
    });

    // Now advance toolEvents exactly as the loop would have.
    if (budgetBlocked) {
      toolEvents.push({ tool, ok: false, _guardBlock: true, _guardReason: 'enough_context', path: String((decision && decision.path) || '') });
      return;
    }
    if (readLoopBlocked) {
      toolEvents.push({ tool: 'read_file', ok: false, _guardBlock: true, _guardReason: 'already_read', path: String((decision && decision.path) || '') });
      return;
    }
    if (servedFromCache) {
      // Cache hits push an ok:true read_file — which COUNTS toward the budget.
      toolEvents.push({ tool: 'read_file', ok: true, _guardBlock: true, path: String((decision && decision.path) || ''), observation: 'served from cache' });
      return;
    }
    if (deadlockBroken) {
      // So does the deadlock breaker's own read.
      toolEvents.push({ tool: 'read_file', ok: true, _deadlockBreak: true, path: String((decision && decision.path) || ''), observation: 'deadlock break' });
      return;
    }
    if (result) {
      if (result.ok && MUTATION_TOOLS.includes(String(result.tool || '').toLowerCase())) noMutationsYet = false;
      toolEvents.push({
        tool: String(result.tool || ''),
        ok: Boolean(result.ok),
        path: String(result.path || ''),
        content: String(result.content || ''),
        observation: String(result.observation || ''),
        offset: Number(result.offset || 0),
        startLine: Number(result.startLine || 0),
        endLine: Number(result.endLine || 0),
      });
    }
  });

  return steps;
}

// Two passes over the same recordings: the historical one validates the
// instrument, the current-code one is what the liveness invariants judge.
const historical = runs.map((run) => ({ run, steps: replayRun(run) }));
const replayed = runs.map((run) => ({ run, steps: replayRunAgainstCurrentCode(run) }));

// ---------------------------------------------------------------------------
// 1. FIDELITY — is the replay a faithful instrument?
//
// The cap depends on phaseState, which the log does not record, so predicting a
// block would mean fitting an unobservable. But the log DOES record the output of
// countInspectionsSinceMutation at each block. Comparing the replayed value to the
// logged one validates the exact function under test against ground truth, with no
// free parameter. If this drifts, the fixtures no longer describe the shipped code
// and every assertion below is worthless.
// ---------------------------------------------------------------------------
let agree = 0;
let disagree = 0;
const disagreements = [];
historical.forEach(({ run, steps }) => {
  steps.forEach((s) => {
    if (!s.budgetBlocked || s.recordedInspections == null) return;
    if (s.inspections === s.recordedInspections) { agree += 1; return; }
    disagree += 1;
    if (disagreements.length < 8) {
      disagreements.push(`${run.chatId}#${run.runIndex} step ${s.step} ${s.tool}: replay counted ${s.inspections}, run logged ${s.recordedInspections}`);
    }
  });
});
assert.ok(agree + disagree >= 20, 'enough recorded blocks to validate the replay against');
const fidelity = agree / Math.max(1, agree + disagree);
console.log(`FIDELITY: countInspectionsSinceMutation reproduces ${agree}/${agree + disagree} recorded counts (${(fidelity * 100).toFixed(1)}%)`);
if (disagreements.length) disagreements.forEach((d) => console.log(`  mismatch: ${d}`));
assert.ok(
  fidelity >= 0.9,
  `replay must reproduce the recorded counts to be a valid instrument (got ${(fidelity * 100).toFixed(1)}%)`,
);

// DEBUG_REPLAY=<runIndex> prints the per-step verdict for one run.
if (process.env.DEBUG_REPLAY) {
  const want = Number(process.env.DEBUG_REPLAY);
  replayed.filter(({ run }) => run.runIndex === want).forEach(({ run, steps }) => {
    console.log(`\nDEBUG ${run.chatId}#${run.runIndex}`);
    steps.forEach((s) => console.log(`  step ${s.step} ${s.tool || '-'} ${s.path || '-'} guard=${s.guard || '-'} blocked=${s.blocked} insp=${s.inspections} consec=${s.consecutive}`));
  });
}

// ---------------------------------------------------------------------------
// 2. SAFETY — the arbiter may unstick the model, never let it clobber files.
//
// Liveness is bought by releasing guards, so the boundary of what is releasable is
// the whole safety argument. Only guards that withhold INFORMATION may stand down;
// the ones protecting the user's files must hold no matter how stuck the run is.
// ---------------------------------------------------------------------------
const PROTECTIVE_GUARDS = ['would_overwrite_existing', 'rewrite_would_regenerate', 'just_written', 'edits_cycling'];
PROTECTIVE_GUARDS.forEach((guard) => {
  assert.ok(!RELEASABLE_GUARDS.includes(guard), `${guard} protects the user's files and must never be releasable`);
  // Even at an arbitrarily long deadlock, a protective guard never stands down.
  const wedged = Array.from({ length: 50 }, () => ({ tool: 'edit_file', ok: false, _guardBlock: true, path: '/a.ts' }));
  assert.equal(guardShouldStandDown(guard, wedged), false, `${guard} must hold even in a wedged run`);
});
// And the releasable ones do stand down once the run is demonstrably stuck.
RELEASABLE_GUARDS.forEach((guard) => {
  const stuck = Array.from({ length: 3 }, () => ({ tool: 'read_file', ok: false, _guardBlock: true, path: '/a.ts' }));
  assert.equal(guardShouldStandDown(guard, stuck), true, `${guard} must release a stuck run`);
  assert.equal(guardShouldStandDown(guard, []), false, `${guard} must not release a healthy run`);
});
console.log(`\nSAFETY: ${RELEASABLE_GUARDS.length} releasable guards, ${PROTECTIVE_GUARDS.length} that never release`);

// ---------------------------------------------------------------------------
// 3. LIVENESS — the harness must always leave a legal move.
// ---------------------------------------------------------------------------

// A. No run may be blocked on N consecutive steps. The model has by then tried N
//    different things and the harness refused every one; that is a deadlock
//    regardless of which guard did the refusing.
const MAX_CONSECUTIVE_BLOCKS = 2;
const streaks = [];
replayed.forEach(({ run, steps }) => {
  let streak = 0;
  let worst = 0;
  let worstAt = 0;
  steps.forEach((s) => {
    if (s.blocked) { streak += 1; if (streak > worst) { worst = streak; worstAt = s.step; } } else streak = 0;
  });
  if (worst) streaks.push({ label: `${run.chatId}#${run.runIndex}`, worst, worstAt });
});
streaks.sort((a, b) => b.worst - a.worst);
console.log('\nLONGEST BLOCKED STREAKS:');
streaks.slice(0, 6).forEach((s) => console.log(`  ${s.label}: ${s.worst} consecutive blocked steps (ending step ${s.worstAt})`));
const overLimit = streaks.filter((s) => s.worst > MAX_CONSECUTIVE_BLOCKS);
assert.equal(
  overLimit.length,
  0,
  `${overLimit.length} run(s) had more than ${MAX_CONSECUTIVE_BLOCKS} consecutive harness-blocked steps — the model had no legal move: ${overLimit.slice(0, 3).map((s) => `${s.label}(${s.worst})`).join(', ')}`,
);

// B. A file the build itself named as failing must be reachable. Extract paths
//    from failing run output, then assert the model was never left unable to read
//    one it asked for.
const FILE_IN_ERROR = /(?:^|[\s(>])(\.?\/?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,4})(?::\d+)?/g;
const unreachable = [];
replayed.forEach(({ run, steps }) => {
  const named = new Set();
  const readOk = new Set();
  const blockedReads = new Map();
  const norm = (p) => `/${String(p || '').replace(/^\.?\//, '')}`;
  steps.forEach((s) => {
    // A read that was not blocked got through — whether it ran normally or the
    // arbiter released it. Both put the content in front of the model.
    if (['read_file', 'read_files'].includes(s.tool) && !s.blocked && s.path) readOk.add(norm(s.path));
    if (s.ok && /Type error|error TS|Failed to compile|Error:/.test(s.observation)) {
      let m;
      const text = s.observation;
      FILE_IN_ERROR.lastIndex = 0;
      while ((m = FILE_IN_ERROR.exec(text))) {
        const p = norm(m[1]);
        if (!/node_modules|\.npm|\/logs?\//.test(p)) named.add(p);
      }
    }
    if (s.blocked && ['read_file', 'read_files'].includes(s.tool) && s.path) {
      blockedReads.set(norm(s.path), (blockedReads.get(norm(s.path)) || 0) + 1);
    }
  });
  blockedReads.forEach((count, p) => {
    if (named.has(p) && !readOk.has(p)) {
      unreachable.push(`${run.chatId}#${run.runIndex}: ${p} was named by a failing build, the model asked for it ${count}x, every read was blocked, and it was never read`);
    }
  });
});
console.log('\nUNREACHABLE FILES NAMED BY FAILING BUILDS:');
if (!unreachable.length) console.log('  (none)');
unreachable.slice(0, 6).forEach((u) => console.log(`  ${u}`));
assert.equal(unreachable.length, 0, `${unreachable.length} file(s) named by a failing build could never be read`);

// C. A file the build is complaining about, that has never been read, must never
//    be blocked — not "eventually released after two more wasted steps". Relying
//    on the arbiter here would mean the harness only works by overriding itself.
const namedButBlocked = [];
replayed.forEach(({ run, steps }) => {
  steps.forEach((s) => {
    if (s.blocked && s.failureNamedTarget) {
      namedButBlocked.push(`${run.chatId}#${run.runIndex} step ${s.step}: ${s.path} (named by the failing build, never read) was blocked by ${s.guard}`);
    }
  });
});
console.log('\nBLOCKED READS OF FILES THE BUILD NAMED:');
if (!namedButBlocked.length) console.log('  (none)');
namedButBlocked.slice(0, 6).forEach((u) => console.log(`  ${u}`));
assert.equal(namedButBlocked.length, 0, `${namedButBlocked.length} read(s) of a build-named unread file were blocked`);

// D. Fresh evidence resets the inspection budget. A read taken immediately after a
//    failing build is acting on new information by definition, so budget-blocking
//    it is always wrong — this is what starved every diagnostic run.
const blockedOnFreshEvidence = [];
replayed.forEach(({ run, steps }) => {
  steps.forEach((s) => {
    if (s.blocked && s.guard === 'enough_context' && s.afterFailingRun) {
      blockedOnFreshEvidence.push(`${run.chatId}#${run.runIndex} step ${s.step}: ${s.tool} blocked by the inspection budget immediately after a failing build`);
    }
  });
});
console.log('\nINSPECTION BLOCKS ON FRESH BUILD EVIDENCE:');
if (!blockedOnFreshEvidence.length) console.log('  (none)');
blockedOnFreshEvidence.slice(0, 6).forEach((u) => console.log(`  ${u}`));
assert.equal(blockedOnFreshEvidence.length, 0, `${blockedOnFreshEvidence.length} read(s) blocked despite fresh build evidence`);

// E. The budget must not be raised by reads the HARNESS served. Every door it
//    opens would otherwise raise the wall — the ratchet that made these runs
//    monotonically more stuck the more the guards tried to help.
{
  const base = [
    { tool: 'read_file', ok: true, path: '/a.ts' },
    { tool: 'read_file', ok: true, path: '/b.ts' },
  ];
  const before = countInspectionsSinceMutation(base);
  const withCacheServe = countInspectionsSinceMutation([...base, { tool: 'read_file', ok: true, _guardBlock: true, path: '/c.ts' }]);
  const withDeadlockBreak = countInspectionsSinceMutation([...base, { tool: 'read_file', ok: true, _deadlockBreak: true, path: '/c.ts' }]);
  assert.equal(withCacheServe, before, 'a cache-served read must not raise the inspection budget');
  assert.equal(withDeadlockBreak, before, 'a deadlock-break read must not raise the inspection budget');
  const withRealRead = countInspectionsSinceMutation([...base, { tool: 'read_file', ok: true, path: '/c.ts' }]);
  assert.equal(withRealRead, before + 1, 'a genuine read still counts');
  console.log(`\nRATCHET: harness-served reads leave the budget at ${withCacheServe} (a real read raises it to ${withRealRead})`);
}

// F. A blocked read must resolve to the last SUCCESSFUL read of that path, so the
//    re-serve branch has content to hand back. Guard blocks carry the same
//    signature, so without this the newest match is the refusal — and the run that
//    ended one edit from the fix was refused with nothing attached.
{
  const norm = (p) => String(p || '');
  const sig = { tool: 'read_file', path: '/src/Scene.tsx' };
  const events = [
    { tool: 'read_file', ok: true, path: '/src/Scene.tsx', content: 'REAL CONTENT' },
    { tool: 'run_command', ok: true, path: '/' },
    { tool: 'read_file', ok: false, _guardBlock: true, path: '/src/Scene.tsx' },
  ];
  const noMutation = () => false;
  const picked = preferSuccessfulReadIndex(events, 2, sig, norm, noMutation);
  assert.equal(picked, 0, 'a blocked read resolves back to the successful read that has content');
  assert.equal(events[picked].content, 'REAL CONTENT', 'the re-served event actually carries the file');

  // A mutation since that read makes it stale — the block must stand.
  const stale = preferSuccessfulReadIndex(events, 2, sig, norm, (i) => i === 0);
  assert.equal(stale, 2, 'a read invalidated by a later write is not re-served');

  // A different path is never borrowed from.
  const other = preferSuccessfulReadIndex(
    [{ tool: 'read_file', ok: true, path: '/other.ts', content: 'x' }, { tool: 'read_file', ok: false, _guardBlock: true, path: '/src/Scene.tsx' }],
    1, sig, norm, noMutation,
  );
  assert.equal(other, 1, 'a successful read of a DIFFERENT file is not substituted');
  console.log('\nRE-SERVE: blocked reads resolve to real content, staleness and path identity respected');
}

console.log('\nPASS: the harness left a legal move in every recorded run');
