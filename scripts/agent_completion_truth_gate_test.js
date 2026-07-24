const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// The gate is wired into every completion return path and the prompt directive.
assert.match(runtime, /return enforceCompletionTruth\(text, toolEvents, workspaceLabel\)/, 'remote/external returns go through the gate');
assert.match(runtime, /return enforceCompletionTruth\(deterministicCompletion, toolEvents, workspaceLabel\)/, 'deterministic fallback goes through the gate');
assert.match(runtime, /VERIFIED OUTCOME — the latest build is currently FAILING/, 'prompt carries the hard build-failed directive');

// Execute the real gate helpers (closure-scoped, not exported).
const block = sliceBetween(runtime, 'function latestBuildOutcome(', 'async function generateAgentCompletionText(');
const sandbox = { console, deps: { normalizeWorkspacePath: (p) => p }, recordDebugTrace: () => {} };
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.api = { latestBuildOutcome, completionAssertsSuccess, enforceCompletionTruth };`, sandbox);
const api = sandbox.api;

// A RED build after the last edit.
const redBuild = [
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
  { tool: 'run_app', ok: true, runErrorCount: 1, observation: "run_app Node build failed (npm run build exited 1).\n./src/components/ColorPanel.tsx:3\nCannot find module 'framer-motion'" },
];
const green = [
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
  { tool: 'run_app', ok: true, runErrorCount: 0, observation: 'run_app Node build passed (npm run build exited 0).' },
];
const installAfterFail = [
  { tool: 'run_app', ok: true, runErrorCount: 1, observation: "Cannot find module 'framer-motion'" },
  { tool: 'run_command', ok: true, runErrorCount: 0, terminalCommand: 'npm install framer-motion', observation: 'finished cleanly (exit 0).' },
];

assert.equal(api.latestBuildOutcome(redBuild).failed, true, 'red build is detected as failing');
assert.equal(api.latestBuildOutcome(green).failed, false, 'green build is not failing');
// An install after a failed build must NOT be read as a passing build.
assert.equal(api.latestBuildOutcome(installAfterFail).failed, true, 'install after failure keeps the build red');

// A false "fixed" claim on a red build is REPLACED — the success language cannot ship.
const lie = 'Fixed the ReactCurrentOwner crash! 🔥 The build passes and the scene works now.';
const gatedLie = api.enforceCompletionTruth(lie, redBuild, 'drone light show');
assert.doesNotMatch(gatedLie, /works now|Fixed the/i, 'the success claim is stripped');
assert.match(gatedLie, /build is not passing yet/i, 'the honest status replaces it');
assert.match(gatedLie, /framer-motion/, 'the real error is surfaced');

// An honest message on a red build keeps its content but gets an authoritative footer.
const honest = "I updated page.tsx, but the build is still failing on a missing dependency.";
const gatedHonest = api.enforceCompletionTruth(honest, redBuild, 'drone light show');
assert.match(gatedHonest, /updated page\.tsx/, 'honest content is preserved');
assert.match(gatedHonest, /build is not passing yet/i, 'authoritative footer is appended');

// A green build passes the claim through untouched.
const success = 'Done — added the dark theme and the build passes clean. ✨';
assert.equal(api.enforceCompletionTruth(success, green, 'proj'), success, 'green build leaves the message unchanged');

// Negated success language on a red build is not mistaken for a claim (footer path only).
assert.equal(api.completionAssertsSuccess('This is not fixed yet and still fails.'), false, 'negated claim is not a success assertion');
assert.equal(api.completionAssertsSuccess('Fixed it — everything works now.'), true, 'plain claim is a success assertion');

console.log('PASS: no completion can assert success while the latest build is red; green/honest messages pass through');
