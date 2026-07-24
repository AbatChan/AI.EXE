// v9.7.6 — the completion truth-gate must correct a message that lies, and keep one that
// already tells the truth.
//
// Regression: the model wrote "Heads up — not verified yet: these files changed after the
// last successful build, so the current code hasn't been confirmed to compile… Also one
// real issue: ControlDock.tsx imports @/lib/store, but the store lives at
// @/store/useSwarmStore. Next step: npm install && npm run build." — i.e. exactly what the
// gate exists to enforce, plus the actual defect and the actual command. The gate replaced
// it wholesale with a generic sentence, so the user lost the only actionable detail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');

// ---- Wiring ----
assert.match(runtime, /function completionAlreadyDisclosesRisk\(text\)/, 'the gate can recognize a compliant message');
assert.match(runtime, /function openContractIssueLines\(toolEvents, max = 2\)/, 'a replaced message can still name real findings');
assert.match(runtime, /agent_completion_truth_gate_kept/, 'keeping a message is traced, not silent');
assert.match(runtime, /Still open: \$\{openIssues\.join\('; '\)\}/, 'the replacement carries the open findings');

// ---- Behaviour: run the real predicate ----
const start = runtime.indexOf('function completionAlreadyDisclosesRisk(text)');
const end = runtime.indexOf('function openContractIssueLines(');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${runtime.slice(start, end)}\nthis.api = { completionAlreadyDisclosesRisk };`, sandbox);
const { completionAlreadyDisclosesRisk: discloses } = sandbox.api;

// The real message from the run that triggered this fix.
const realMessage = `SWARM is wired up, mathew! Here's what just landed:
- /src/lib/droneEngine.ts — boid flocking engine
Heads up — not verified yet: the validator flagged that these files changed after the last
successful build, so the current code hasn't been confirmed to compile/pass. Also one real
issue: /src/components/ControlDock.tsx imports from @/lib/store, but the store lives at
@/store/useSwarmStore. Next step: run npm install && npm run build.`;
assert.equal(discloses(realMessage), true, 'the message that started this is kept');

[
  'I changed three files. They have not been verified yet — run the build to confirm.',
  'Wrote the store and the scene. This still needs to be built and checked before it is done.',
  'Added the timeline. Not confirmed working yet; press Run to try it.',
].forEach((text) => assert.equal(discloses(text), true, `honest message kept: ${text.slice(0, 40)}`));

// A success claim always wins over a disclosure — anything ambiguous is still replaced.
[
  'All done! The app is complete and working.',
  'Fixed it — the build passes cleanly now.',
  'Everything is now working. It has not been verified on mobile, but desktop is complete.',
  'Task complete. Not verified on Windows.',
  'The drone show is fully functional and ready to ship.',
  '',
  'Updated the files.',
  'I created the store, the engine, and the scene components.',
].forEach((text) => assert.equal(discloses(text), false, `claim or silence is replaced: ${text.slice(0, 40) || '(empty)'}`));

// ---- The polish guard must not block a REPAIR of a truncated write ----
// Regression: a component saved cut off mid-file; the model correctly asked to regenerate
// it whole and got "full rewrite prevented — targeted edit required".
assert.match(loop, /if \(String\(event\.structuralIssue \|\| ''\)\.trim\(\)\) return false;/,
  'a structurally incomplete write does not count as a clean write');
const guardFn = loop.slice(loop.indexOf('const lastWriteWithoutFailureSince'), loop.indexOf('return sawCleanWrite;'));
assert.ok(guardFn.indexOf('structuralIssue') < guardFn.indexOf('sawCleanWrite = true'),
  'the incompleteness check runs BEFORE the write is treated as clean');

console.log('PASS: a completion that already states it is unverified survives the gate; claims and silence are still replaced, now naming the open findings; regenerating a truncated file is no longer blocked');
