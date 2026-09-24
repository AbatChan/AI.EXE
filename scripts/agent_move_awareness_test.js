// A move/delete is a real change: reviewers see it, and the finish shape the model sends parses.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-runtime.js'));
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));

const norm = (p) => { let s = String(p || '').trim(); if (!s.startsWith('/')) s = `/${s}`; return s.replace(/\/+/g, '/').replace(/\/$/, '') || '/'; };
const rt = global.AIExeAgentRuntime.createAgentRuntime({
  normalizeWorkspacePath: norm,
  nativeBridge: { available: () => false, invoke: async () => null },
  deriveProjectNameFromTask: () => 'project',
  sanitizeAssistantText: (t) => String(t || ''),
});
const summary = rt.buildAgentChangeSummaries([
  { tool: 'move', ok: true, srcPath: '/README.md', dstPath: '/GUIDE.md' },
  { tool: 'delete', ok: true, path: '/old.css' },
  { tool: 'move', ok: false, srcPath: '/a.js', dstPath: '/b.js' },
]);
assert.match(summary, /Moved\/renamed \/README\.md -> \/GUIDE\.md/);
assert.match(summary, /Deleted \/old\.css/);
assert.doesNotMatch(summary, /\/a\.js/, 'failed moves are not changes');

const core = global.AIExeAgentCore.createAgentCore({
  normalizeWorkspaceName: (s) => String(s || '').trim(),
  normalizeWorkspacePath: norm,
  getWorkspaceContext: () => ({}),
  looksLikePlaceholderImplementation: () => false,
});
const d = core.parseAgentDecision('```json\n{"action":"tool","tool":"final","message":"Renamed README.md to GUIDE.md."}\n```');
assert.ok(d, 'tool:"final" must parse');
assert.equal(d.action, 'final');
assert.equal(d.tool, 'none');
console.log('PASS: moves/deletes reach reviewers; tool:"final" is a finish');
