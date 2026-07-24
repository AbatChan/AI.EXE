const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// The ledger is wired into the decision prompt's tool-log.
assert.match(planner, /const evidenceLedger = buildAgentEvidenceLedger\(allEvents\)/, 'ledger is computed from all events');
assert.match(planner, /appliedDigest \+ evidenceLedger \+ diagnosticsLog/, 'ledger is prepended into the tool log');

// Execute the real pure helper.
const block = sliceBetween(planner, 'function buildAgentEvidenceLedger(', 'async function buildAgentDecisionPrompt(');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.api = { buildAgentEvidenceLedger };`, sandbox);
const build = sandbox.api.buildAgentEvidenceLedger;

// The exact ReactCurrentOwner-run evidence: one deduped react, an invalid reconciler,
// extraneous drei — plus a node -e version print.
const npmLs = `run_command \`npm ls\`: finished.
├─┬ @react-three/drei@9.114.0 extraneous
│ └── react@18.3.1 deduped
├─┬ @react-three/fiber@8.18.0
│ ├─┬ react-reconciler@0.29.2 invalid: "^0.27.0" from node_modules/@react-three/fiber
│ │ └── react@18.3.1 deduped
├── react@18.3.1
└── react-dom@18.3.1 deduped`;
const nodePrint = 'run_command `node -e ...`: finished cleanly (exit 0).\nreact 18.3.1\nreconciler 0.29.2';

const ledger = build([
  { tool: 'run_command', ok: true, terminalCommand: 'npm ls', observation: npmLs },
  { tool: 'run_command', ok: true, terminalCommand: 'node -e "..."', observation: nodePrint },
]);

assert.match(ledger, /ESTABLISHED FACTS/, 'produces an established-facts block');
assert.match(ledger, /do NOT propose a fix premised on a version differing/, 'forbids re-theorizing against the facts');
assert.match(ledger, /react@18\.3\.1/, 'pins the proven react version');
assert.match(ledger, /react-reconciler@0\.29\.2 — INVALID/, 'flags the invalid reconciler as the real evidence');
assert.match(ledger, /@react-three\/drei@9\.114\.0 — installed but not in package\.json/, 'flags the extraneous package');
assert.ok(ledger.indexOf('INVALID') < ledger.indexOf('deduped in its branch'), 'invalid facts are ranked ahead of routine ones');
assert.equal((ledger.match(/- react@18\.3\.1/g) || []).length, 1, 'react is de-duplicated to a single fact');

// E#1 — MULTIPLE installed versions are PRESERVED, not collapsed (the real conflict signal).
const dupe = build([{
  tool: 'run_command', ok: true, terminalCommand: 'npm ls react',
  observation: 'run_command `npm ls react`:\n├── react@18.3.1\n└─┬ some-lib@1.0.0\n  └── react@19.0.0',
}]);
assert.match(dupe, /react — MULTIPLE VERSIONS INSTALLED: 18\.3\.1, 19\.0\.0/, 'two react versions are surfaced, not collapsed');

// E#3 — prose in a NON-diagnostic command must NOT become a fact.
const prose = build([{
  tool: 'run_command', ok: true, terminalCommand: 'npm run build',
  observation: "run_command `npm run build`: failed. Try upgrading to @react-three/fiber@9.0.0 to fix it.",
}]);
assert.equal(prose, '', 'a suggestion in build output is not promoted to an established fact');

// E#4 — facts proven BEFORE a later install/manifest change are dropped as stale.
const stale = build([
  { tool: 'run_command', ok: true, terminalCommand: 'npm ls react', observation: 'run_command `npm ls react`:\n└── react@18.3.1' },
  { tool: 'run_command', ok: true, terminalCommand: 'npm install react@19', observation: 'added 1 package' },
]);
assert.equal(stale, '', 'a diagnostic before a later install is invalidated');
const refreshed = build([
  { tool: 'run_command', ok: true, terminalCommand: 'npm install react@19', observation: 'added 1 package' },
  { tool: 'run_command', ok: true, terminalCommand: 'npm ls react', observation: 'run_command `npm ls react`:\n└── react@19.0.0' },
]);
assert.match(refreshed, /react@19\.0\.0/, 'a diagnostic AFTER the install is trusted');

// No diagnostic output → no ledger.
assert.equal(build([{ tool: 'edit_file', ok: true, path: '/a.ts', content: 'x' }]), '', 'no evidence → empty ledger');
assert.equal(build([]), '', 'no events → empty ledger');

console.log('PASS: diagnostic-only facts, multiple versions preserved, prose ignored, stale-after-install dropped');
