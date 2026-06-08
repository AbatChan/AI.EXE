// Unit tests for agent plan classification (agent-core.js).
//
// These test the CODE logic, not the planner model: the key invariant is that an
// open workspace is treated as inspection CONTEXT, never as an automatic mutation
// scope. Even if the model misclassifies a question as task_kind="edit", the code
// must not fabricate affected/expected files from the root listing.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));

function normalizeWorkspacePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s) return '/';
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

// A chat that owns an open "markdown-site" workspace with two root files.
const openWorkspaceContext = {
  workspaceRootName: 'markdown-site',
  rootEntryCount: 2,
  rootLoaded: true,
  currentPath: '/',
  rootEntries: [
    { name: 'site.py', kind: 'file', path: '/site.py' },
    { name: 'template.html', kind: 'file', path: '/template.html' },
  ],
};

const core = global.AIExeAgentCore.createAgentCore({
  normalizeWorkspaceName: (s) => String(s || '').trim(),
  normalizeWorkspacePath,
  getWorkspaceContext: () => openWorkspaceContext,
  getActiveChatId: () => 'chat_owns_ws',
  chatHasPriorAgentWorkspaceWork: () => true, // => sameChatWorkspaceFollowup = true
  looksLikePlaceholderImplementation: () => false,
});

const opts = { chatId: 'chat_owns_ws' };

const cases = [
  {
    name: 'question misclassified as edit does NOT fabricate mutation targets',
    run: () => core.normalizeAgentPlanSpec({ task_kind: 'edit', affected_files: '' }, 'so how do i run to test?', opts),
    expect: (spec) => {
      assert.deepEqual(spec.affectedFiles, [], 'affectedFiles must be empty (no fabrication from root files)');
      assert.deepEqual(spec.expectedFiles, [], 'expectedFiles must be empty (no fabrication from root files)');
    },
  },
  {
    name: 'question classified as analysis stays analysis with no mutation scope',
    run: () => core.normalizeAgentPlanSpec({ task_kind: 'analysis', affected_files: '' }, 'how do i run this?', opts),
    expect: (spec) => {
      assert.equal(spec.taskKind, 'analysis');
      assert.deepEqual(spec.affectedFiles, []);
    },
  },
  {
    name: 'real edit preserves the model-named affected files',
    run: () => core.normalizeAgentPlanSpec({ task_kind: 'edit', affected_files: '/site.py' }, 'fix the title extraction in site.py', opts),
    expect: (spec) => {
      assert.equal(spec.taskKind, 'edit');
      assert.deepEqual(spec.affectedFiles, ['/site.py']);
    },
  },
  {
    name: 'fallback plan for an edit follow-up does not fabricate mutation targets',
    run: () => core.buildFallbackAgentPlanSpec('how do i run to test?', opts),
    expect: (spec) => {
      assert.deepEqual(spec.affectedFiles, [], 'fallback affectedFiles must be empty for edit/analysis');
    },
  },
  {
    name: 'forceProjectScope yields a COHERENT project plan (not an empty-project-is-done plan)',
    run: () => core.normalizeAgentPlanSpec(
      { task_kind: 'analysis', affected_files: '' },
      'write me a playable snake thing in python',
      { chatId: 'chat_owns_ws', forceProjectScope: true },
    ),
    expect: (spec) => {
      assert.equal(spec.taskKind, 'project', 'taskKind must be project');
      assert.equal(spec.finalRequiresRealFiles, true, 'finalRequiresRealFiles must be true so it cannot finish after only new_project');
      assert.ok(Array.isArray(spec.expectedFiles) && spec.expectedFiles.length > 0, 'expectedFiles must be populated');
    },
  },
  {
    name: 'forceProjectScope on the fallback plan is also coherent',
    run: () => core.buildFallbackAgentPlanSpec('write me a playable snake thing in python', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      assert.equal(spec.taskKind, 'project');
      assert.equal(spec.finalRequiresRealFiles, true);
      assert.ok(Array.isArray(spec.expectedFiles) && spec.expectedFiles.length > 0, 'expectedFiles must be populated');
    },
  },
];

let failures = 0;
for (const testCase of cases) {
  try {
    const spec = testCase.run();
    testCase.expect(spec);
    console.log(`PASS: ${testCase.name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${testCase.name}`);
    console.error(`  ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} agent plan classification test(s) failed.`);
  process.exit(1);
}
console.log(`\nPassed ${cases.length} agent plan classification tests.`);
