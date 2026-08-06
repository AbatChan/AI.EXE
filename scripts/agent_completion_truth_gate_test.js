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

// The gate is wired into every completion return path, the prompt directive, and the
// runtime-proof check no longer trusts a listening dev server.
assert.match(runtime, /return enforceCompletionTruth\(text, toolEvents, workspaceLabel, taskText\)/, 'remote/external returns go through the gate with the task');
assert.match(runtime, /return enforceCompletionTruth\(deterministicCompletion, toolEvents, workspaceLabel, taskText\)/, 'deterministic fallback goes through the gate');
assert.match(runtime, /sanitizeCompletionForTruth\(remote\.output \|\| '', toolEvents\)/, 'remote verdict is captured before display sanitizing');
assert.match(runtime, /sanitizeCompletionForTruth\(external\.output \|\| '', toolEvents\)/, 'external verdict is captured before display sanitizing');
assert.match(runtime, /VERIFIED OUTCOME/, 'prompt carries the hard verified-outcome directive');
assert.match(runtime, /const runtimeProofSeen = latestBrowserOutcome\(toolEvents\)/, 'dev-server readiness is not runtime proof');

// Execute the real gate helpers (closure-scoped, not exported).
const block = sliceBetween(runtime, 'function latestBuildOutcome(', 'async function generateAgentCompletionText(');
const sandbox = { console, deps: { normalizeWorkspacePath: (p) => p }, recordDebugTrace: () => {} };
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.api = { latestBuildOutcome, latestBrowserOutcome, enforceCompletionTruth };`, sandbox);
const api = sandbox.api;

const err = "run_app Node build failed (npm run build exited 1).\nCannot find module 'framer-motion'";
const redBuild = [
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
  { tool: 'run_app', ok: true, runErrorCount: 1, observation: err },
];
const green = [
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
  { tool: 'run_app', ok: true, runErrorCount: 0, observation: 'run_app Node build passed (npm run build exited 0).' },
];

// Baseline: red vs green.
assert.equal(api.latestBuildOutcome(redBuild).failed, true, 'red build is failing');
assert.equal(api.latestBuildOutcome(green).failed, false, 'green build is not failing');
assert.equal(api.latestBuildOutcome(green).stale, false, 'green with no later edit is fresh');

// HOLE 1 — a mutation AFTER a green build makes the proof stale (unverified code).
const greenThenEdit = [
  { tool: 'run_app', ok: true, runErrorCount: 0 },
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
];
assert.equal(api.latestBuildOutcome(greenThenEdit).stale, true, 'a mutation after proof invalidates the proof');
assert.equal(api.latestBuildOutcome(greenThenEdit).failed, false, 'stale is distinct from failed');

// HOLE 2 — a passing static validation must NOT cancel a failed build.
const redBuildThenGreenValidate = [
  { tool: 'run_app', ok: true, runErrorCount: 1, observation: err },
  { tool: 'validate_files', ok: true, validationPassed: true },
];
assert.equal(api.latestBuildOutcome(redBuildThenGreenValidate).failed, true, 'static validation must not overwrite a failed build');
// An install after a failed build also keeps it red.
assert.equal(api.latestBuildOutcome([
  { tool: 'run_app', ok: true, runErrorCount: 1, observation: err },
  { tool: 'run_command', ok: true, runErrorCount: 0, terminalCommand: 'npm install framer-motion' },
]).failed, true, 'install after failure keeps the build red');

// HOLE 3 — a listening dev server is NOT browser-runtime proof.
assert.equal(api.latestBrowserOutcome([{ tool: 'run_app', ok: true, runErrorCount: 0, devServer: { ready: true } }]).hasProof, false, 'server readiness is not browser runtime proof');
assert.equal(api.latestBrowserOutcome([{ tool: 'run_app', ok: true, browserProof: { pageLoaded: true, uncaughtErrors: [], consoleErrors: [] } }]).passed, true, 'a real browser proof counts');

// HOLE 4 — success phrases NOT in any blacklist are still neutralized (always-replace).
[
  'Fixed the ReactCurrentOwner crash! 🔥 The scene works now.',
  'Everything is working perfectly and the crash is gone.',
  'All checks are green — shipped successfully. 🚀',
].forEach((claim) => {
  const gated = api.enforceCompletionTruth(claim, redBuild, 'proj');
  assert.doesNotMatch(gated, /works now|working perfectly|crash is gone|checks are green|shipped successfully|Fixed the/i, `success framing neutralized: ${claim}`);
  assert.match(gated, /build is still failing/i, 'honest status replaces it');
  assert.match(gated, /framer-motion/, 'the real error is surfaced');
});

// Stale (green-then-edit) also gets replaced with an honest, non-success message.
const gatedStale = api.enforceCompletionTruth('Done — it all works now. ✨', greenThenEdit, 'proj');
assert.doesNotMatch(gatedStale, /it all works now/i, 'stale success claim neutralized');
assert.match(gatedStale, /changed after the last verification|not been re-checked/i, 'stale status surfaced');

// Green + fresh passes through untouched.
const ok = 'Added the dark theme and the build passes clean. ✨';
assert.equal(api.enforceCompletionTruth(ok, green, 'proj'), ok, 'green+fresh build leaves the message unchanged');

// A no-build task (docs/create with no build proof) is not gated.
const docOnly = [{ tool: 'write_file', ok: true, path: '/README.md' }];
const docMsg = 'Wrote the README with setup steps.';
assert.equal(api.enforceCompletionTruth(docMsg, docOnly, 'proj', 'Add a README'), docMsg, 'no-build task passes through');

// v9.7.1 hardening ---------------------------------------------------------

// A browser-runtime-error task with a GREEN build but NO browser proof cannot claim fixed.
const runtimeTask = 'Runtime TypeError: Cannot read properties of undefined (reading ReactCurrentOwner)';
const gatedRuntime = api.enforceCompletionTruth('Fixed the crash — it works now. 🔥', green, 'proj', runtimeTask);
assert.doesNotMatch(gatedRuntime, /works now|Fixed the/i, 'runtime success claim blocked on a green build without browser proof');
assert.match(gatedRuntime, /runtime error that a build cannot reproduce|reload\/rerun/i, 'tells the user to confirm in a browser');
// Same green build for a NON-runtime task passes through (no over-gating).
assert.equal(api.enforceCompletionTruth('Added the theme, build passes.', green, 'proj', 'Add a dark theme'), 'Added the theme, build passes.', 'non-runtime green build is not gated');
// A FRESH passing browser proof lets the runtime task through.
const browserOk = [
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
  { tool: 'run_app', ok: true, runErrorCount: 0, browserProof: { pageLoaded: true, uncaughtErrors: [], consoleErrors: [] } },
];
assert.equal(api.enforceCompletionTruth('The crash is fixed.', browserOk, 'proj', runtimeTask), 'The crash is fixed.', 'fresh passing browser proof clears the runtime gate');
// A browser proof that predates a later edit is STALE → still gated.
const browserStale = [
  { tool: 'run_app', ok: true, browserProof: { pageLoaded: true, uncaughtErrors: [], consoleErrors: [] } },
  { tool: 'edit_file', ok: true, path: '/src/app/page.tsx' },
];
assert.equal(api.latestBrowserOutcome(browserStale).stale, true, 'a browser proof before a later edit is stale');
assert.doesNotMatch(api.enforceCompletionTruth('Fixed it, works now.', browserStale, 'proj', runtimeTask), /works now/i, 'stale browser proof does not clear the gate');

// Validation staleness with NO build: validate passes, then an edit → stale.
const validateThenEdit = [
  { tool: 'validate_files', ok: true, validationPassed: true },
  { tool: 'edit_file', ok: true, path: '/src/lib/util.ts' },
];
assert.equal(api.latestBuildOutcome(validateThenEdit).stale, true, 'an edit after a passing validation is stale even with no build');

// `ls -l` after a failed build must NOT be treated as a passing build.
const failThenLs = [
  { tool: 'run_app', ok: true, runErrorCount: 1, observation: err },
  { tool: 'run_command', ok: true, runErrorCount: 0, terminalCommand: 'ls -l' },
];
assert.equal(api.latestBuildOutcome(failThenLs).failed, true, '`ls -l` is not a build proof and does not clear a failed build');

console.log('PASS: v9.7.0 + 9.7.1 — proof freshness, channel separation, runtime-needs-browser-proof, and -l fix all hold');
