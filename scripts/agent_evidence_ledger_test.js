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
const npmLs = `run_command npm ls: finished.
├─┬ @react-three/drei@9.114.0 extraneous
│ └── react@18.3.1 deduped
├─┬ @react-three/fiber@8.18.0
│ ├─┬ react-reconciler@0.29.2 invalid: "^0.27.0" from node_modules/@react-three/fiber
│ │ └── react@18.3.1 deduped
├── react@18.3.1
└── react-dom@18.3.1 deduped`;
const nodePrint = 'run_command node -e ...: finished cleanly (exit 0).\nreact 18.3.1\nreconciler 0.29.2';

const ledger = build([
  { tool: 'run_command', ok: true, observation: npmLs },
  { tool: 'run_command', ok: true, observation: nodePrint },
]);

assert.match(ledger, /ESTABLISHED FACTS/, 'produces an established-facts block');
assert.match(ledger, /do NOT propose a fix premised on a version differing/, 'forbids re-theorizing against the facts');
assert.match(ledger, /react@18\.3\.1/, 'pins the proven react version');
assert.match(ledger, /react-reconciler@0\.29\.2 — INVALID/, 'flags the invalid reconciler as the real evidence');
assert.match(ledger, /@react-three\/drei@9\.114\.0 — installed but not in package\.json/, 'flags the extraneous package');
// INVALID facts are surfaced first (most decision-relevant).
assert.ok(ledger.indexOf('INVALID') < ledger.indexOf('single copy'), 'invalid facts are ranked ahead of routine ones');
// react appears once despite many deduped lines.
assert.equal((ledger.match(/- react@18\.3\.1/g) || []).length, 1, 'react is de-duplicated to a single fact');

// No diagnostic output → no ledger (does not pollute normal runs).
assert.equal(build([{ tool: 'edit_file', ok: true, path: '/a.ts', content: 'x' }]), '', 'no evidence → empty ledger');
assert.equal(build([]), '', 'no events → empty ledger');

console.log('PASS: diagnostic-proven versions are pinned as established facts (invalid/extraneous flagged, deduped, no false facts)');
