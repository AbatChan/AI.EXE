// Mini Sheets follow-up (13.4.9): run_app smoke-tested tests.html instead of the app,
// and a 9.8 KB formula engine was called "thin" because it has no DOM keywords.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-planner.js'));
const normalizeWorkspacePath = (p) => {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+/g, '/');
};
const planner = global.AIExeAgentPlanner.createAgentPlanner({ normalizeWorkspacePath });

const engine = fs.readFileSync(path.join(__dirname, 'fixtures_mini_sheets_formula_engine.js.txt'), 'utf8');
assert.ok(engine.length > 9000);
assert.equal(planner.isLikelyCompletePrimarySource('/formula-engine.js', engine, 'build mini sheets'), true, 'a real engine is not thin');
assert.equal(planner.isLikelyCompletePrimarySource('/app.js', 'function a() {}\n// placeholder for later\n', 'app'), false, 'tiny stubs still flagged');
assert.equal(planner.isLikelyCompletePrimarySource('/app.js', `const x = 1;\n${'x;\n'.repeat(1600)}\nconst msg = "placeholder code";`, 'app'), false, 'placeholders still flagged at any size');

const executor = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-executor.js'), 'utf8');
const cand = executor.slice(executor.indexOf('const htmlCandidates = normalizeWorkspacePathList(['), executor.indexOf(']);', executor.indexOf('const htmlCandidates')));
assert.ok(cand.indexOf("'/index.html'") < cand.indexOf('plannedFiles.filter'), 'index.html is tried before planned helper pages');
assert.match(executor, /const htmlTarget = \/\\\.html\?\$\/i\.test\(requestedHtml\)\n\s+\? requestedHtml/, 'an explicit page from the model wins');
assert.match(executor, /const smallByDesign = .*config.*main/, 'config + Vite entry files skip the thin note');
console.log('PASS: run_app tests the app entry page; big non-DOM modules are not "thin"');
