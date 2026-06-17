const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));
require(path.join(__dirname, '..', 'ui', 'agent-planner.js'));
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));

function normalizeWorkspaceName(raw) {
  return String(raw || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeWorkspaceComparableName(raw) {
  return normalizeWorkspaceName(raw).toLowerCase().replace(/\s*\(\d+\)\s*$/g, '').replace(/[^a-z0-9]+/g, '');
}

const rootName = 'chatgpt clone ui';
function normalizeWorkspacePath(raw) {
  const value = String(raw || '/').replace(/\\/g, '/').trim();
  let parts = value.split('/').filter((part) => part && part !== '.');
  if (parts.length > 0) {
    const currentRoot = normalizeWorkspaceComparableName(rootName);
    const firstPart = normalizeWorkspaceComparableName(parts[0]);
    if (currentRoot && firstPart === currentRoot) parts = parts.slice(1);
  }
  const clean = [];
  parts.forEach((part) => { if (part !== '..') clean.push(part); });
  return clean.length > 0 ? `/${clean.join('/')}` : '/';
}

const core = global.AIExeAgentCore.createAgentCore({
  normalizeWorkspaceName,
  normalizeWorkspacePath,
  getWorkspaceContext: () => ({ workspaceRootName: rootName, currentPath: '/' }),
  getActiveChatId: () => 'chat_write_repair',
  chatHasPriorAgentWorkspaceWork: () => false,
});

const planner = global.AIExeAgentPlanner.createAgentPlanner({
  normalizeWorkspacePath,
  isAgentTaskGameLike: core.isAgentTaskGameLike,
  hasReadmeRunInstructions: core.hasReadmeRunInstructions,
  isLikelyCompleteReadme: core.isLikelyCompleteReadme,
  isExplicitReadmeOrDocsTask: core.isExplicitReadmeOrDocsTask,
  isDocsOnlyTask: core.isDocsOnlyTask,
  buildFallbackAgentPlanSpec: core.buildFallbackAgentPlanSpec,
  buildAgentFileGenerationHints: core.buildAgentFileGenerationHints,
  getWorkspaceContext: () => ({ workspaceRootName: rootName, currentPath: '/' }),
  deriveProjectNameFromTask: core.deriveProjectNameFromTask,
});

const taskText = `Create a responsive ChatGPT-inspired chat interface using HTML, CSS, and JavaScript only.
Do not use any backend, API, OpenAI integration, or external AI service. All assistant replies should be mocked locally.
Deliver the finished prototype with separate index.html, style.css, and script.js files.`;

const planSpec = {
  taskKind: 'project',
  projectName: rootName,
  expectedFiles: ['/index.html', '/style.css', '/script.js'],
  needsReadme: false,
  finalRequiresRealFiles: true,
};

function parentWorkspacePath(candidate) {
  const full = normalizeWorkspacePath(candidate);
  if (full === '/' || !full.includes('/')) return '/';
  const idx = full.lastIndexOf('/');
  return idx <= 0 ? '/' : full.slice(0, idx);
}

function workspaceBaseName(candidate) {
  const parts = normalizeWorkspacePath(candidate).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function makeExecutor(generator) {
  const writes = [];
  const traces = [];
  const executor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    deriveProjectNameFromTask: core.deriveProjectNameFromTask,
    invokeWorkspaceAction: async (action, data) => {
      if (action === 'workspaceWriteFile') {
        writes.push({ path: data.path, content: data.content });
        return { ok: true };
      }
      if (action === 'workspaceMkdir') return { ok: true };
      if (action === 'workspaceReadFile') return { ok: true, output: '' };
      return { ok: true };
    },
    getWorkspaceRootName: () => rootName,
    getWorkspaceTreeState: () => new Map([['/', { children: [] }]]),
    getWorkspaceContext: () => ({ workspaceRootName: rootName, currentPath: '/' }),
    requestWorkspaceStatusSnapshot: async () => ({ ok: true, rootName, currentPath: '/' }),
    chatHasPriorAgentWorkspaceWork: () => false,
    recordDebugTrace: (kind, summary) => traces.push({ kind, summary }),
    debugPreview: (value, max = 200) => String(value || '').slice(0, max),
    syncFileTabFromWorkspaceWrite: () => {},
    workspaceBaseName,
    agentMaxToolOutputChars: 26000,
    isLikelyNewAgentFileTarget: () => true,
    setActiveAgentStreamStatus: () => {},
    isAgentGeneratedContentTarget: core.isAgentGeneratedContentTarget,
    generateAgentWriteFileContent: generator,
    isAgentTaskSoftwareProject: core.isAgentTaskSoftwareProject,
    isAgentTaskGameLike: core.isAgentTaskGameLike,
    isExplicitReadmeOrDocsTask: core.isExplicitReadmeOrDocsTask,
    isExistingProjectMutationRequest: core.isExistingProjectMutationRequest,
    getLatestSuccessfulAgentSourceWrite: planner.getLatestSuccessfulAgentSourceWrite,
    isLikelyCompleteReadme: core.isLikelyCompleteReadme,
    isLikelyCompletePythonGameSource: core.isLikelyCompletePythonGameSource,
    isLikelyCompletePrimarySource: planner.isLikelyCompletePrimarySource,
    parentWorkspacePath,
    setWorkspaceSelection: () => {},
    upsertWorkspaceTreeEntry: () => {},
    estimateTextBytes: (content) => Buffer.byteLength(String(content || '')),
    nowTs: () => Date.now(),
    parseAgentEditProgram: core.parseAgentEditProgram,
    generateAgentEditFileProgram: async () => '',
    generateAgentRewriteExistingFileContent: async () => '',
    applyAgentEditProgram: core.applyAgentEditProgram,
    removeWorkspaceTreeEntry: () => {},
    guessWorkspaceTargetKind: () => 'file',
    syncMovedFileTab: () => {},
    removeWorkspaceTab: () => {},
    reviewAgentProjectCoherence: async () => [],
    runWorkspaceAppSmokeTest: async () => null,
  });
  return { executor, writes, traces };
}

const brokenScript = [
  "document.addEventListener('DOMContentLoaded', () => {",
  "  const messages = [];",
  "  function render() { document.body.dataset.count = String(messages.length); }",
  "  function update() { messages.push({ role: 'assistant', text: 'Mock response' }); render(); }",
  "  document.addEventListener('click', update);",
  '  render();',
  '});',
  '\\oops = 1;',
].join('\n');

const repairedScript = [
  "document.addEventListener('DOMContentLoaded', () => {",
  "  const messages = [];",
  "  function render() { document.body.dataset.count = String(messages.length); }",
  "  function update() { messages.push({ role: 'assistant', text: 'Mock response' }); render(); }",
  "  document.addEventListener('click', update);",
  '  render();',
  '});',
].join('\n');

(async () => {
  const calls = [];
  const { executor, writes, traces } = makeExecutor(async (_task, _events, candidatePath, prior) => {
    calls.push({ path: normalizeWorkspacePath(candidatePath), prior: String(prior || '') });
    return calls.length === 1 ? brokenScript : repairedScript;
  });

  const repaired = await executor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'write_file', path: '/script.js', content: '' },
    taskText,
    [],
    planSpec
  );

  assert.equal(repaired.ok, true, 'broken generated JS is repaired and saved');
  assert.equal(calls.length, 2, 'syntax repair uses one targeted follow-up generation');
  assert.match(calls[1].prior, /failed structural validation/i, 'repair prompt includes validation failure');
  assert.match(calls[1].prior, /BROKEN_CONTENT/, 'repair prompt includes failed content');
  assert.equal(writes.length, 1, 'only the repaired file is written');
  assert.equal(writes[0].content, repairedScript, 'written content is the repaired script');
  assert.ok(traces.some((entry) => entry.kind === 'agent_write_structural_repair_attempt'), 'repair attempt is traced');
  console.log('PASS: generated JS syntax failure is repaired before save');

  const validInline = [
    "document.addEventListener('DOMContentLoaded', () => {",
    "  const state = { messages: [] };",
    "  function render() { document.body.dataset.ready = 'true'; }",
    "  document.addEventListener('click', render);",
    '  render();',
    '});',
  ].join('\n');
  const inlineCalls = [];
  const { executor: inlineExecutor, writes: inlineWrites } = makeExecutor(async (_task, _events, candidatePath, prior) => {
    inlineCalls.push({ path: normalizeWorkspacePath(candidatePath), prior: String(prior || '') });
    return brokenScript;
  });

  const inlineSaved = await inlineExecutor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'write_file', path: '/chatgpt clone ui/script.js', content: validInline },
    taskText,
    [],
    planSpec
  );

  assert.equal(normalizeWorkspacePath('/chatgpt clone ui/script.js'), '/script.js', 'workspace root is stripped from paths');
  assert.equal(inlineSaved.ok, true, 'valid inline script is saved');
  assert.equal(inlineCalls.length, 0, 'valid inline script does not invoke generator');
  assert.equal(inlineWrites.length, 1, 'inline script is written once');
  assert.equal(inlineWrites[0].content, validInline, 'inline content is preserved exactly');
  console.log('PASS: valid inline planner content is not discarded');
})();
