// Agent run event protocol (agent-events.js): unit tests for the lifecycle
// emitter + summarizer, and static checks that the loop/app/native wiring
// stays in place. The durable log is the replay/interrupted-run source of
// truth — these invariants keep it honest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-events.js'));

const events = global.AIExeAgentEvents;
let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`PASS: ${name}`);
  passed += 1;
}

// --- emitter lifecycle ---
const persisted = [];
const log = events.createRunEventLog({
  threadId: 'chat-1',
  task: 'build a landing page',
  persist: (entry) => { persisted.push(entry); },
});
ok('turn started is emitted first', persisted.length === 1
  && persisted[0].type === 'turn' && persisted[0].state === 'started'
  && persisted[0].data.task === 'build a landing page');
ok('turnId/threadId stamped on entries', persisted[0].turnId === log.turnId && persisted[0].threadId === 'chat-1');

log.emitPlan({ taskKind: 'project', expectedFiles: ['/a.html', '/b.css'], doneCriteria: ['x'] });
log.emitDecision(1, 'model', { action: 'tool', tool: 'write_file', path: '/a.html' });
log.emitToolEvent({ tool: 'write_file', ok: true, path: '/a.html', mutated: true, content: 'abc', observation: 'wrote it' });
log.emitToolEvent({ tool: 'run_command', ok: false, commandPolicy: 'ask_first', terminalCommand: 'npm install x', observation: 'needs approval' });
log.emitToolEvent({ tool: 'edit_file', ok: false, _guardBlock: true, path: '/a.html', observation: 'oscillation blocked' });
log.emitDecisionFailure(2, 'Agent step timed out.', true);
ok('seq is strictly monotonic', persisted.every((e, i) => e.seq === i + 1));
ok('itemId derives from turnId+seq', persisted.every((e) => e.itemId === `${e.turnId}:${e.seq}`));

const toolEntries = persisted.filter((e) => e.type === 'tool');
ok('ok tool event → completed', toolEntries[0].state === 'completed' && toolEntries[0].data.mutated === true);
ok('tool data carries sizes, never content bodies', toolEntries[0].data.contentBytes === 3
  && !JSON.stringify(toolEntries[0]).includes('"abc"'));
ok('ask_first tool event → awaiting_approval', toolEntries[1].state === 'awaiting_approval'
  && toolEntries[1].data.command === 'npm install x');
ok('guard block → blocked (not failed)', toolEntries[2].state === 'blocked');
ok('decision failure captured with timeout flag', persisted.some((e) => e.type === 'decision'
  && e.state === 'failed' && e.data.timedOut === true));

const terminal = log.end({ timedOut: true });
ok('end() emits terminal timed_out with toolCount', terminal.type === 'turn'
  && terminal.state === 'timed_out' && terminal.data.toolCount === 3);
ok('end() is idempotent', log.end({ errored: true }) === null && log.ended === true);

// classify table
ok('classifyToolEventState table', events.classifyToolEventState({ ok: true }) === 'completed'
  && events.classifyToolEventState({ ok: false }) === 'failed'
  && events.classifyToolEventState({ ok: false, commandPolicy: 'blocked' }) === 'blocked'
  && events.classifyToolEventState(null) === 'failed');

// persist failures never propagate
const throwingLog = events.createRunEventLog({ threadId: 'c', persist: () => { throw new Error('disk'); } });
throwingLog.emitToolEvent({ tool: 'read_file', ok: true });
ok('persist failure never throws into the loop', throwingLog.seq === 2);

// terminal state mapping
const l2 = events.createRunEventLog({ threadId: 'c2', persist: () => {} });
ok('errored end → failed', l2.end({ errored: true }).state === 'failed');
const l3 = events.createRunEventLog({ threadId: 'c3', persist: () => {} });
ok('cancelled end → cancelled', l3.end({ cancelled: true }).state === 'cancelled');
const l4 = events.createRunEventLog({ threadId: 'c4', persist: () => {} });
ok('clean end → completed', l4.end({}).state === 'completed');

// --- parse + lifecycle summary (the replay path) ---
const lines = [
  ...persisted.map((e) => JSON.stringify(e)),
  '{"torn json',
  JSON.stringify({ v: 1, seq: 1, ts: 5, threadId: 'chat-2', turnId: 'run-x', itemId: 'run-x:1', type: 'turn', state: 'started', data: { task: 'crashed run' } }),
  JSON.stringify({ v: 1, seq: 2, ts: 6, threadId: 'chat-2', turnId: 'run-x', itemId: 'run-x:2', type: 'tool', state: 'completed', data: { tool: 'write_file' } }),
].join('\n');
const parsed = events.parseRunEventLines(lines);
ok('torn JSONL line is skipped', parsed.length === persisted.length + 2);

const summary = events.summarizeRunLifecycle(parsed);
ok('summary groups per turn', summary.length === 2);
const finished = summary.find((r) => r.turnId === log.turnId);
const crashed = summary.find((r) => r.turnId === 'run-x');
ok('finished run has terminal state, not interrupted', finished.terminalState === 'timed_out'
  && finished.interrupted === false && finished.task === 'build a landing page');
ok('tool states tallied', finished.tools.completed === 1 && finished.tools.blocked === 1
  && finished.tools.awaiting_approval === 1);
ok('run with no terminal event is INTERRUPTED', crashed.interrupted === true && crashed.terminalState === null);

// --- static wiring checks ---
const agentLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.html'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const bridgeCpp = fs.readFileSync(path.join(__dirname, '..', 'src', 'web_runtime_bridge.cpp'), 'utf8');
const bridgeH = fs.readFileSync(path.join(__dirname, '..', 'src', 'web_runtime_bridge.h'), 'utf8');
const macHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui_main_mac_web.mm'), 'utf8');
const winHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui_main_win_webview.cpp'), 'utf8');
const pkg = require('../package.json');

ok('loop creates the run log and intercepts toolEvents.push', /deps\.createRunEventLog/.test(agentLoop)
  && /pushWithRunLog/.test(agentLoop));
ok('loop guarantees one terminal event in finally', /runLog\.end\(\{ cancelled: !deps\.isInferenceActive\(requestToken\), timedOut: totalTimedOut \}\)/.test(agentLoop));
ok('loop emits decisions from all four sources', /'deterministic', decision/.test(agentLoop)
  && /'model', decision/.test(agentLoop) && /'repair', decision/.test(agentLoop)
  && /'fallback', decision/.test(agentLoop));
ok('main tool event carries commandPolicy for approval states', /commandPolicy: String\(\(toolResult && toolResult\.commandPolicy\) \|\| ''\)/.test(agentLoop));
ok('app persists to agent_runs channel un-gated', /channel: 'agent_runs'/.test(aiExe)
  && /function persistAgentRunEvent/.test(aiExe));
ok('app passes createRunEventLog into the loop deps', /createRunEventLog: createAgentRunEventLog/.test(aiExe));
ok('read-back + :debug runs viewer wired', /readDebugLog/.test(aiExe) && /action === 'runs'/.test(aiExe));
ok('html loads agent-events before agent-core', html.indexOf('agent-events.js') !== -1
  && html.indexOf('agent-events.js') < html.indexOf('agent-core.js'));
ok('cmake bundles agent-events.js on both hosts', /WIN_AGENT_EVENTS_JS/.test(cmake) && /MAC_AGENT_EVENTS_JS/.test(cmake));
ok('native ReadDebugLog implemented and exposed on both hosts', /ReadDebugLog/.test(bridgeH)
  && /ReadDebugLog/.test(bridgeCpp) && /"readDebugLog"/.test(macHost) && /"readDebugLog"/.test(winHost));
ok('version synced package.json ↔ CMake', pkg.version === (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log(`\nAll ${passed} checks passed: run events are durable, lifecycle-typed, and replay-summarizable.`);
