// No time limit: runs stop only when truly stuck (10 steps with nothing new), and the
// wrap-up says why in ONE line instead of three stacked canned sentences.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');

assert.match(loop, /const deadlineNow = \(\) => Number\.POSITIVE_INFINITY;/);
assert.doesNotMatch(loop, /I ran out of time before finishing/);
assert.doesNotMatch(loop, /I didn't get to finish everything/);
assert.doesNotMatch(loop, /ran out of steps before verifying/);
assert.match(ui, /const agentMaxSteps = 150;/);

// Every step counts toward "stuck"; only something new resets it.
const top = loop.indexOf('stepsWithoutProgress += 1;');
assert.ok(top > 0 && top < loop.indexOf('let decision = String(planSpec'), 'counted at the top of every step, before guards can skip it');
assert.match(loop, /if \(stepsWithoutProgress > STUCK_AFTER_STEPS\) \{/);

// Exercise the real progress rules.
const src = loop.slice(loop.indexOf('const STUCK_AFTER_STEPS'), loop.indexOf('// Read-only cross-phase contract check runs'));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.api = { note: noteStepProgress, get: () => stepsWithoutProgress, bump: () => { stepsWithoutProgress += 1; } };`, ctx);
const { note, get, bump } = ctx.api;
const step = (decision, result) => { bump(); note(decision, result); return get(); };
assert.equal(step({ tool: 'write_file', path: '/a.js' }, { ok: true, mutated: true }), 0, 'a real change is progress');
assert.equal(step({ tool: 'edit_file', path: '/a.js' }, { ok: true, mutated: true, noChangeNeeded: true }), 1, 'a no-op edit is not');
assert.equal(step({ tool: 'run_app', path: '/' }, { ok: true, runErrorCount: 1, observation: 'TypeError: x (12ms)' }), 0, 'a new error is progress');
assert.equal(step({ tool: 'run_app', path: '/' }, { ok: true, runErrorCount: 1, observation: 'TypeError: x (40ms)' }), 1, 'the same error again (timing aside) is not');
assert.equal(step({ tool: 'read_file', path: '/b.js' }, { ok: true }), 0, 'reading something new is progress');
assert.equal(step({ tool: 'read_file', path: '/b.js' }, { ok: true }), 1, 're-reading it is not');
assert.equal(step({ tool: 'read_file', path: '/b.js', start_line: 200, end_line: 260 }, { ok: true }), 0, 'a new range is new information');
assert.equal(step({ tool: 'write_file', path: '/c.js' }, { ok: false, observation: 'blocked' }), 1, 'a blocked step is not progress');
assert.equal(step({ tool: 'none' }, null), 2, 'a rejected finish is not progress');

// Stop copy: one reason line, model-written wrap-up keeps its own verdict.
assert.match(loop, /I stopped because the last few steps weren't getting anywhere/);
assert.match(loop, /if \(!usedNaturalCompletion && unresolvedValidationClause\) fallback \+= unresolvedValidationClause;\n\s+else if \(!phaseState && !\(cl && cl\.allDone\)\) fallback \+= pauseReason;/, 'never both');
console.log('PASS: no run deadline; stops only after 10 steps with nothing new; one stop line');

// Cube Lab waste: checks raced animations (1s expect, instant fail on a disabled button)
// and a 6.7 KB file was read in four overlapping slices.
{
  const ex = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-executor.js'), 'utf8');
  assert.match(ui, /if \(!matches && Date\.now\(\) - assertionStarted < 5000\) \{ setTimeout\(step, 40\); return; \}/, 'expect waits up to 5s');
  assert.match(ui, /if \(\(!el \|\| el\.disabled\) && \(!assertionStarted \|\| Date\.now\(\) - assertionStarted < 5000\)\) \{/, 'click waits for an enabled control');
  assert.match(ui, /window\.setTimeout\(finish, Math\.min\(90000, 6000 \+ checks\.length \* 2500\)\);/, 'budget covers the waits');
  assert.match(ex, /const wholeSmallFile = startLine > 0 && body\.length <= cap;/);
  assert.match(loop, /startLine: toolResult && toolResult\.wholeFile \? 0 :/, 'recorded as a full read so later slices count as seen');
  console.log('PASS: checks wait like a user; small-file slices return the whole file');
}

// Cube Lab: checks could not press Shift+R, so reverse turns were never testable.
{
  const src = ui.slice(ui.indexOf('function aiexeRunSmokeChecks('), ui.indexOf('async function runWorkspaceAppSmokeTest'));
  const seen = [];
  const body = { tagName: 'BODY', dispatchEvent(e) { seen.push(`${e.type}:${e.key}:${e.shiftKey ? 'S' : ''}${e.ctrlKey ? 'C' : ''}`); return true; } };
  class KeyboardEvent { constructor(type, o) { Object.assign(this, o, { type }); } }
  const queue = [];
  const ctx = { document: { activeElement: body, body, querySelector: () => null }, KeyboardEvent, setTimeout: (fn) => queue.push(fn), Date };
  const run = vm.runInNewContext(`${src};aiexeRunSmokeChecks`, ctx);
  let out;
  run([{ key: 'Shift+r' }, { key: 'Control+Z' }, { key: 'R' }], () => {}, (r) => { out = r; });
  while (queue.length) queue.shift()();
  assert.ok(seen.includes('keydown:R:S'), `Shift+r -> key "R" with shiftKey (${seen.join(' ')})`);
  assert.ok(seen.includes('keydown:Z:C') || seen.includes('keydown:Z:SC') || seen.some((x) => /^keydown:Z:.*C/.test(x)), 'Control+Z holds ctrl');
  assert.equal(seen.filter((x) => x.startsWith('keydown:Shift')).length, 0, 'Shift is held, not pressed on its own');
  assert.equal(out.length, 3);
  console.log('PASS: checks press key combinations (Shift+R, Control+Z)');
}
