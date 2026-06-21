// Unit tests for live phase sub-task progress. File-grounded phase tasks can tick
// as soon as their write/edit succeeds, without marking plan.md's source-of-truth
// checkbox done.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-loop.js'));

function normalizeWorkspacePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

const loop = global.AIExeAgentLoop;
assert.ok(loop, 'agent loop exports test helpers');

assert.deepEqual(
  loop.extractFileLikeTaskPaths('/index.html hero+nav+trust-bar', normalizeWorkspacePath),
  ['/index.html'],
  'extracts leading root-relative HTML task path',
);
assert.deepEqual(
  loop.extractFileLikeTaskPaths('css/design-tokens.css ; js/components.js', normalizeWorkspacePath),
  ['/css/design-tokens.css', '/js/components.js'],
  'extracts slashless nested file task paths',
);

const phaseState = {
  activeIndex: 0,
  phases: [
    {
      title: 'Runnable core',
      tasks: [
        { text: '/index.html hero+nav+trust-bar', done: false },
        { text: '/css/design-tokens.css', done: false },
        { text: '/css/style.css', done: false },
        { text: 'brand feels polished', done: false },
      ],
    },
    { title: 'More pages', tasks: [{ text: '/features.html', done: false }] },
  ],
};

assert.equal(
  loop.markPhaseTaskLiveProgressForPath(phaseState, 'css/style.css', normalizeWorkspacePath),
  1,
  'marks one matching active-phase file task live-done',
);
assert.equal(phaseState.phases[0].tasks[2].liveDone, true, 'sets liveDone on the matching task');
assert.equal(phaseState.phases[0].tasks[2].done, false, 'does not mutate source-of-truth done');

assert.equal(
  loop.markPhaseTaskLiveProgressForPath(phaseState, '/features.html', normalizeWorkspacePath),
  0,
  'does not mark tasks from inactive phases',
);
assert.equal(
  loop.markPhaseTaskLiveProgressForPath(phaseState, '/README.md', normalizeWorkspacePath),
  0,
  'does not mark semantic or unrelated tasks',
);

assert.deepEqual(
  loop.activePhaseFilePaths(phaseState, normalizeWorkspacePath),
  ['/index.html', '/css/design-tokens.css', '/css/style.css'],
  'derives active phase file paths only',
);
assert.deepEqual(
  loop.getActivePhaseFileTaskGaps(phaseState, normalizeWorkspacePath).map((gap) => gap.path),
  ['/index.html', '/css/design-tokens.css'],
  'reports active phase file tasks that are not done or live-done',
);

assert.equal(
  loop.shouldSuppressAgentNarration("I'll start by creating the HTML skeleton.", '', []),
  false,
  'allows an initial startup narration before file writes',
);
assert.equal(
  loop.shouldSuppressAgentNarration("I'll start by creating the HTML skeleton.", '', [
    { tool: 'write_file', path: '/index.html', ok: true },
  ]),
  true,
  'suppresses stale startup narration after a file has already been written',
);
assert.equal(
  loop.shouldSuppressAgentNarration('There it is — the CSS import is missing, fixing it now.', '', [
    { tool: 'write_file', path: '/index.html', ok: true },
  ]),
  false,
  'keeps concrete found/fixing narration after a file write',
);

console.log('Passed phase live progress tests.');
