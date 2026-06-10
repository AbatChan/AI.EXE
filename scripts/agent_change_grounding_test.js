// Tests for the change-grounding layer: compact diffs of what an edit actually
// changed, per-file change summaries, the evidence-based done-criteria audit,
// and the advisory cross-file coherence review.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-runtime.js'));
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));
require(path.join(__dirname, '..', 'ui', 'agent-planner.js'));

function normalizeWorkspacePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s) return '/';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function createRuntime(remoteOutput) {
  return global.AIExeAgentRuntime.createAgentRuntime({
    normalizeWorkspacePath,
    requestSelectedRemoteTextCompletion: async () => (
      remoteOutput == null ? null : { ok: true, output: remoteOutput }
    ),
    nativeBridge: { available: () => false, invoke: async () => null },
    deriveProjectNameFromTask: () => 'project',
    sanitizeAssistantText: (t) => String(t || ''),
  });
}

// --- buildCompactLineDiff ---
const rt = createRuntime(null);
const before = ['a', 'b', 'c', 'd'].join('\n');
const after = ['a', 'b', 'X', 'd'].join('\n');
const diff = rt.buildCompactLineDiff(before, after);
assert.equal(diff.removedCount, 1, 'one removed line');
assert.equal(diff.addedCount, 1, 'one added line');
assert.equal(diff.startLine, 3, 'hunk starts at the changed line');
assert.ok(diff.text.includes('- c') && diff.text.includes('+ X'), 'diff shows old and new lines');

const noChange = rt.buildCompactLineDiff('same\ntext', 'same\ntext');
assert.equal(noChange.text, '', 'identical content yields empty diff');

// --- buildAgentChangeSummaries ---
const events = [
  { tool: 'write_file', ok: true, path: '/index.html', content: '<html>\n<body>hi</body>\n</html>', originalContent: '' },
  { tool: 'read_file', ok: true, path: '/style.css', content: 'body { color: red; }' },
  { tool: 'edit_file', ok: true, path: '/style.css', content: 'body { color: blue; }', originalContent: 'body { color: red; }' },
];
const summaries = rt.buildAgentChangeSummaries(events);
assert.ok(summaries.includes('Created /index.html'), 'new file reported as created');
assert.ok(summaries.includes('Edited /style.css'), 'edited file reported as edited');
assert.ok(summaries.includes('- body { color: red; }'), 'edit summary includes removed line');
assert.ok(summaries.includes('+ body { color: blue; }'), 'edit summary includes added line');

// failed events and reads are excluded
const noisy = rt.buildAgentChangeSummaries([
  { tool: 'edit_file', ok: false, path: '/a.js', content: 'x', originalContent: 'y' },
  { tool: 'read_file', ok: true, path: '/b.js', content: 'z' },
]);
assert.equal(noisy, '', 'failed edits and reads produce no change summaries');

// --- structural guards (agent-executor) ---
const executor = global.AIExeAgentExecutor.createAgentExecutor({ normalizeWorkspacePath });
const goodHtml = '<!DOCTYPE html>\n<html><body><div class="layout"><div class="controls"><label>X</label></div></div></body></html>';
const brokenHtml = '<!DOCTYPE html>\n<html><body><div class="layout">\n<label>X</label></div></div></body></html>';
assert.equal(executor.getHtmlStructureIssue(goodHtml), '', 'balanced HTML passes');
assert.ok(/unbalanced HTML tags/.test(executor.getHtmlStructureIssue(brokenHtml)), 'orphaned closing div is flagged');
assert.equal(executor.getHtmlStructureIssue('<ul><li>one<li>two</ul>'), '', 'optional-close tags (li) are not flagged');
assert.equal(executor.getHtmlStructureIssue('<div><img src="x.png"><br></div>'), '', 'void elements are not flagged');
assert.ok(/duplicate HTML ids/.test(executor.getHtmlStructureIssue('<div id="page-login"></div><div id="page-login"></div>')), 'duplicated section ids are flagged');
assert.equal(executor.getHtmlStructureIssue('<div id="a"></div><div id="b"></div>'), '', 'unique ids pass');
assert.ok(executor.getStructuralIssueForPath('/script.js', 'function ok() { return 1; }\n}'), 'broken JS is flagged');
assert.equal(executor.getStructuralIssueForPath('/script.js', 'function ok() { return 1; }'), '', 'sound JS passes');
assert.ok(executor.getStructuralIssueForPath('/data.json', '{"a": 1,,}'), 'invalid JSON is flagged');
assert.equal(executor.getStructuralIssueForPath('/notes.md', '# anything'), '', 'markdown is not structure-checked');

// --- sibling context: full content on large-context providers, signals otherwise ---
function createPlanner(expandedReadChars) {
  return global.AIExeAgentPlanner.createAgentPlanner({
    normalizeWorkspacePath,
    getAgentExpandedReadChars: () => expandedReadChars,
    agentMaxToolOutputChars: 8000,
  });
}
const siblingEvents = [
  { tool: 'write_file', ok: true, path: '/index.html', content: '<html><body><div id="app" class="layout"></div></body></html>' },
];
const siblingPlan = { expectedFiles: ['/index.html', '/style.css'] };

const remotePlanner = createPlanner(60000);
const remoteState = remotePlanner.buildAgentProjectStateContext(siblingEvents, siblingPlan, '/style.css');
assert.ok(remoteState.includes('CURRENT /index.html'), 'large-context provider gets full sibling content');
assert.ok(remoteState.includes('<div id="app" class="layout">'), 'full sibling body is present');

const localPlanner = createPlanner(8000);
const localState = localPlanner.buildAgentProjectStateContext(siblingEvents, siblingPlan, '/style.css');
assert.ok(!localState.includes('CURRENT /index.html'), 'small-context provider stays on signals');
assert.ok(localState.includes('SIGNALS /index.html'), 'signals fallback is present');

const excludedState = remotePlanner.buildAgentProjectStateContext(siblingEvents, siblingPlan, '/index.html');
assert.ok(!excludedState.includes('CURRENT /index.html'), 'the target file itself is excluded from sibling context');

// --- verifyAgentDoneCriteria ---
(async () => {
  const editEvents = [
    { tool: 'edit_file', ok: true, path: '/style.css', content: 'body { display: flex; }', originalContent: 'body { display: block; }' },
  ];
  const plan = { doneCriteria: ['Controls and card are laid out horizontally'] };

  const unmetRt = createRuntime('{"unmet":[{"criterion":"Controls and card are laid out horizontally","why":"body has one child; the rule cannot arrange the siblings"}]}');
  const unmetRes = await unmetRt.verifyAgentDoneCriteria('make it horizontal', editEvents, plan);
  assert.equal(unmetRes.ok, false, 'unmet criterion fails the audit');
  assert.equal(unmetRes.unmet.length, 1, 'one unmet item surfaced');
  assert.ok(unmetRes.unmet[0].why.includes('one child'), 'why is carried through');

  const metRt = createRuntime('{"unmet":[]}');
  const metRes = await metRt.verifyAgentDoneCriteria('make it horizontal', editEvents, plan);
  assert.equal(metRes.ok, true, 'empty unmet passes the audit');

  const garbageRt = createRuntime('not json at all');
  const garbageRes = await garbageRt.verifyAgentDoneCriteria('task', editEvents, plan);
  assert.equal(garbageRes.ok, true, 'unparseable output is treated as skipped, never blocks');
  assert.equal(garbageRes.skipped, true, 'garbage output marks the audit skipped');

  const noCriteriaRes = await metRt.verifyAgentDoneCriteria('task', editEvents, { doneCriteria: [] });
  assert.equal(noCriteriaRes.skipped, true, 'no criteria skips the audit');

  // --- reviewAgentProjectCoherence ---
  const reviewRt = createRuntime('{"issues":["/script.js: slider card-scale is 50-150 but the script default is 1"]}');
  const issues = await reviewRt.reviewAgentProjectCoherence({
    '/index.html': '<input id="card-scale" min="50" max="150" value="100">',
    '/script.js': 'const DEFAULTS = { cardScale: 1 };',
  }, 'playing card');
  assert.equal(issues.length, 1, 'coherence review returns advisory issues');
  assert.ok(issues[0].includes('card-scale'), 'issue text passes through');

  const single = await reviewRt.reviewAgentProjectCoherence({ '/only.js': 'x' }, 'task');
  assert.deepEqual(single, [], 'fewer than two files skips the review');

  console.log('Passed 32 change-grounding tests.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
