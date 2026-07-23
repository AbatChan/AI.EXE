// Unit tests for live phase sub-task progress. File-grounded phase tasks can tick
// as soon as their write/edit succeeds. Active work stays live until validation;
// an early future-phase file is durably credited to its owning phase.
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
  loop.extractFileLikeTaskPaths('css/style.css ; js/components.js', normalizeWorkspacePath),
  ['/css/style.css', '/js/components.js'],
  'extracts slashless nested file task paths',
);
assert.deepEqual(
  loop.extractFileLikeTaskPaths('/src/pages/DashboardPage.tsx.', normalizeWorkspacePath),
  ['/src/pages/DashboardPage.tsx'],
  'sentence-ending period after the extension does not defeat the match',
);
assert.deepEqual(
  loop.extractFileLikeTaskPaths('backup at file.tsx.bak stays whole', normalizeWorkspacePath),
  [],
  'mid-word dots are untouched — no false /file.tsx match out of file.tsx.bak',
);

const phaseState = {
  activeIndex: 0,
  phases: [
    {
      title: 'Runnable core',
      tasks: [
        { text: '/index.html hero+nav+trust-bar', done: false },
        { text: '/js/script.js', done: false },
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

const windowsCasePhase = {
  activeIndex: 0,
  phases: [{ title: 'Layout', tasks: [{ text: '/Src/app/layout.tsx', done: false }] }],
};
assert.equal(
  loop.markPhaseTaskLiveProgressForPath(windowsCasePhase, '/src/app/layout.tsx', normalizeWorkspacePath),
  1,
  'Windows path casing differences do not create a duplicate phase deliverable',
);
assert.deepEqual(
  loop.getActivePhaseFileTaskGaps(
    { activeIndex: 0, phases: [{ title: 'Layout', tasks: [{ text: '/Src/app/layout.tsx', done: false }] }] },
    normalizeWorkspacePath,
    (candidate) => candidate.toLowerCase() === '/src/app/layout.tsx',
  ),
  [],
  'case-insensitive filesystem evidence satisfies a differently-cased phase path',
);

assert.equal(
  loop.markPhaseTaskLiveProgressForPath(phaseState, '/features.html', normalizeWorkspacePath),
  1,
  'credits an early-created file to its owning future phase',
);
assert.equal(phaseState.phases[1].tasks[0].liveDone, true, 'future task updates in the live tracker');
assert.equal(phaseState.phases[1].tasks[0].done, true, 'future task is durable so it is not regenerated later');
assert.equal(
  loop.markPhaseTaskLiveProgressForPath(phaseState, '/README.md', normalizeWorkspacePath),
  0,
  'does not mark semantic or unrelated tasks',
);

assert.deepEqual(
  loop.activePhaseFilePaths(phaseState, normalizeWorkspacePath),
  ['/index.html', '/js/script.js', '/css/style.css'],
  'derives active phase file paths only',
);
assert.deepEqual(
  loop.getActivePhaseFileTaskGaps(phaseState, normalizeWorkspacePath).map((gap) => gap.path),
  ['/index.html', '/js/script.js'],
  'reports active phase file tasks that are not done or live-done',
);

assert.equal(
  loop.shouldForcePhaseValidation({ action: 'final', tool: 'none' }, phaseState, [], null, false),
  true,
  'a phased final with complete files deterministically runs validation instead of re-prompting the model',
);
assert.equal(
  loop.shouldForcePhaseValidation({ action: 'final', tool: 'none' }, phaseState, [], null, true),
  false,
  'a phase with fresh passing validation may finish normally',
);
const finalPhaseState = {
  activeIndex: 1,
  phases: [
    { title: 'Foundation', tasks: [{ text: '/src/app/page.tsx', done: true }] },
    { title: 'Integration', tasks: [{ text: '/src/components/Scene.tsx', done: true }] },
  ],
};
const runnableWebPlan = {
  taskKind: 'project',
  primaryStack: 'web',
  expectedFiles: ['/package.json', '/src/app/page.tsx', '/src/components/Scene.tsx'],
};
assert.equal(
  loop.shouldForceProjectRuntimeProof(
    { action: 'final', tool: 'none' },
    finalPhaseState,
    runnableWebPlan,
    true,
    false,
    normalizeWorkspacePath,
  ),
  true,
  'the final runnable phase requires a clean stack-aware runtime proof',
);
assert.equal(
  loop.shouldForceProjectRuntimeProof(
    { action: 'final', tool: 'none' },
    phaseState,
    runnableWebPlan,
    true,
    false,
    normalizeWorkspacePath,
  ),
  false,
  'an intermediate phase never installs or runs the incomplete project',
);
assert.equal(
  loop.shouldForceProjectRuntimeProof(
    { action: 'final', tool: 'none' },
    finalPhaseState,
    runnableWebPlan,
    true,
    true,
    normalizeWorkspacePath,
  ),
  false,
  'one clean runtime proof after the latest mutation allows finalization',
);
assert.equal(
  loop.planHasRunnableFiles(
    { taskKind: 'project', expectedFiles: ['/README.md'] },
    normalizeWorkspacePath,
  ),
  false,
  'documentation-only work does not trigger a fake application run',
);
for (const file of ['/main.py', '/src/Main.java', '/src/main.cpp', '/src/main.go', '/src/main.rs']) {
  assert.equal(
    loop.planHasRunnableFiles({ taskKind: 'project', expectedFiles: [file] }, normalizeWorkspacePath),
    true,
    `${file} is recognized as a runnable project source without task-word heuristics`,
  );
}

const durablePhases = [
  { title: 'Foundation', tasks: [{ text: '/src/app/page.tsx', done: true }] },
  { title: 'Documentation', tasks: [{ text: '/README.md', done: false }] },
  { title: 'Integration', tasks: [{ text: '/src/components/Scene.tsx', done: false }] },
];
assert.equal(
  loop.planTargetsUnfinishedPhaseFiles(
    { expectedFiles: ['/README.md'] },
    durablePhases,
    normalizeWorkspacePath,
  ),
  true,
  'a focused README follow-up reconnects to its unfinished durable phase without text keywords',
);
assert.equal(
  loop.planTargetsUnfinishedPhaseFiles(
    { expectedFiles: ['/notes.md'] },
    durablePhases,
    normalizeWorkspacePath,
  ),
  false,
  'an unrelated file edit does not resurrect the phased build',
);
assert.equal(
  loop.planTargetsUnfinishedPhaseFiles(
    { expectedFiles: ['/src/app/page.tsx'] },
    durablePhases,
    normalizeWorkspacePath,
  ),
  false,
  'a file owned only by a completed phase does not resume that phase',
);

assert.equal(
  loop.activePhaseFileDeliverablesAreGrounded(
    {
      activeIndex: 1,
      phases: durablePhases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => ({ ...task })),
      })),
    },
    normalizeWorkspacePath,
  ),
  false,
  'an unfinished phase is not considered grounded merely because its file is planned',
);
const recoveredDocumentation = {
  activeIndex: 1,
  phases: durablePhases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => ({ ...task })),
  })),
};
recoveredDocumentation.phases[1].tasks[0].liveDone = true;
assert.equal(
  loop.activePhaseFileDeliverablesAreGrounded(recoveredDocumentation, normalizeWorkspacePath),
  true,
  'a disk-recovered README can complete its phase without a pointless rewrite',
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
