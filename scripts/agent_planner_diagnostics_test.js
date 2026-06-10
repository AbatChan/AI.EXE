// Unit tests for planner-side diagnostics injection. These diagnostics are
// derived from file content/tool history, not from user phrasing.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-planner.js'));

function normalizeWorkspacePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s) return '/';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

const planner = global.AIExeAgentPlanner.createAgentPlanner({
  normalizeWorkspacePath,
  agentMaxToolOutputChars: 26000,
});

const badJs = [
  'function ok() {',
  '  return true;',
  '}',
  '}',
].join('\n');

const log = planner.buildAgentDiagnosticsLog([
  { tool: 'read_file', ok: true, path: '/script.js', content: badJs },
]);

assert.ok(log.includes('CURRENT_CODE_DIAGNOSTICS'), 'emits diagnostics header');
assert.ok(log.includes('/script.js:4:'), 'reports concrete line/column');
assert.ok(/nothing is open/i.test(log), 'explains unmatched closing brace');

const clean = planner.buildAgentDiagnosticsLog([
  { tool: 'read_file', ok: true, path: '/script.js', content: 'function ok() { return true; }' },
]);
assert.equal(clean, '', 'clean JS emits no diagnostics');

console.log('Passed planner diagnostics tests.');
