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

function makeExecutor(generator, options = {}) {
  const writes = [];
  const traces = [];
  const files = options.files || {};
  const executor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    deriveProjectNameFromTask: core.deriveProjectNameFromTask,
    invokeWorkspaceAction: async (action, data) => {
      if (action === 'workspaceWriteFile') {
        writes.push({ path: data.path, content: data.content });
        files[data.path] = data.content;
        return { ok: true };
      }
      if (action === 'workspaceMkdir') return { ok: true };
      if (action === 'workspaceReadFile') return { ok: true, output: files[data.path] || '' };
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
    isLikelyNewAgentFileTarget: options.isLikelyNewAgentFileTarget || (() => true),
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
    generateAgentEditFileProgram: options.generateAgentEditFileProgram || (async () => ''),
    generateAgentRewriteExistingFileContent: options.generateAgentRewriteExistingFileContent || (async () => ''),
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
  const batchFiles = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `/source-${index + 1}.tsx`,
    `export const source${index + 1} = ${JSON.stringify('x'.repeat(5000))};`,
  ]));
  const { executor: batchExecutor } = makeExecutor(async () => '', { files: batchFiles });
  const batchRead = await batchExecutor.executeDeveloperToolCall(
    'chat_batch_preview',
    { action: 'tool', tool: 'read_files', paths: Object.keys(batchFiles) },
    'Inspect the existing source files.',
    [],
    { taskKind: 'edit', expectedFiles: Object.keys(batchFiles) }
  );
  assert.equal(batchRead.ok, true);
  assert.equal(batchRead.readFilesResult.length, 6);
  assert.equal(batchRead.readFilesResult[0].previewClipped, true);
  assert.equal(batchRead.readFilesResult[0].content, batchFiles['/source-1.tsx'], 'full source remains available separately from its display preview');
  assert.match(batchRead.observation, /batched HEAD \+ TAIL excerpt/);
  assert.match(batchRead.observation, /the text immediately above is the REAL END OF THE FILE/);
  console.log('PASS: batch reads label clipped display previews without treating source files as truncated');

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

  assert.equal(repaired.ok, true, 'incomplete generated JS is preserved for a focused follow-up');
  assert.equal(calls.length, 1, 'initial generation is not restarted as a second full-file rewrite');
  assert.equal(writes.length, 1, 'the generated prefix is saved once');
  assert.equal(writes[0].content, brokenScript, 'the exact generated prefix remains available for append repair');
  assert.match(repaired.observation, /Continue it from where it ends by APPENDING the rest with edit_file/i);
  assert.equal(repaired.structuralIssue.length > 0, true, 'structural issue is returned to steer the next agent step');
  assert.ok(!traces.some((entry) => entry.kind === 'agent_write_structural_repair_attempt'), 'no redundant full-file repair is launched');
  console.log('PASS: generated JS syntax failure is saved once and delegated to append repair');

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

  const leakedHtmlPreview = [
    'Return only the file contents. No markdown fences. No explanation.',
    '- If this is README.md, include setup or run instructions.',
    '- If this is a main source file, include the core functionality requested by the task.',
    '',
    '```html',
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><title>Personal Finance Dashboard</title></head>',
    '<body><div id="root"></div></body>',
    '</html>',
  ].join('\n');
  const cleanedHtmlPreview = planner.sanitizeAgentGeneratedFileContent(leakedHtmlPreview, '/index.html');
  assert.ok(cleanedHtmlPreview.startsWith('<!DOCTYPE html>'), 'HTML scaffold prompt lines are stripped from generated file content');
  assert.doesNotMatch(cleanedHtmlPreview, /Return only the file contents|If this is README|```/);
  console.log('PASS: echoed file-generation scaffold is stripped from HTML content');

  const deterministicPackageCalls = [];
  const { executor: deterministicPackageExecutor, writes: deterministicPackageWrites } = makeExecutor(async (...args) => {
    deterministicPackageCalls.push(args);
    return '{"name":"bad","dependencies":{"react":"^1^.3.1"}}';
  });
  const deterministicPackageSaved = await deterministicPackageExecutor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'write_file', path: '/package.json', content: '' },
    'Create a Vite React TypeScript personal finance dashboard.',
    [],
    {
      ...planSpec,
      projectName: 'personal finance dashboard',
      expectedFiles: ['/package.json', '/vite.config.ts', '/src/main.tsx', '/src/App.tsx'],
    }
  );

  assert.equal(deterministicPackageSaved.ok, true, 'empty package.json for Vite React scaffold is generated locally');
  assert.equal(deterministicPackageCalls.length, 0, 'deterministic package.json does not call the model generator');
  assert.equal(deterministicPackageWrites.length, 1, 'deterministic package.json is written once');
  const deterministicPackage = JSON.parse(deterministicPackageWrites[0].content);
  assert.equal(deterministicPackage.name, 'personal-finance-dashboard');
  assert.equal(deterministicPackage.scripts.build, 'tsc -b && vite build');
  assert.equal(deterministicPackage.dependencies.react, '^18.3.1');
  assert.equal(deterministicPackage.devDependencies.vite, '^5.4.3');
  assert.match(deterministicPackageSaved.observation, /deterministic Vite React package\.json/);
  console.log('PASS: Vite React package.json is generated deterministically without model repair');

  const { executor: nextPackageExecutor, writes: nextPackageWrites } = makeExecutor(async () => '');
  const nextPackageSaved = await nextPackageExecutor.executeDeveloperToolCall(
    'chat_next_package',
    { action: 'tool', tool: 'write_file', path: '/package.json', content: '' },
    'Build a Next.js 15 App Router dashboard using Tailwind, Zustand, Recharts, Dexie, Framer Motion, and shadcn/ui.',
    [],
    {
      ...planSpec,
      projectName: 'vault-finance-dashboard',
      expectedFiles: ['/package.json', '/next.config.ts', '/src/app/layout.tsx', '/src/app/page.tsx', '/src/store/use-store.ts'],
    }
  );
  assert.equal(nextPackageSaved.ok, true);
  const nextPackage = JSON.parse(nextPackageWrites[0].content);
  assert.equal(nextPackage.scripts.dev, 'next dev');
  assert.equal(nextPackage.scripts.build, 'next build');
  assert.equal(nextPackage.dependencies.next, 'latest');
  assert.ok(nextPackage.dependencies.zustand);
  assert.ok(nextPackage.dependencies.recharts);
  assert.ok(nextPackage.dependencies.dexie);
  assert.equal(nextPackage.devDependencies.vite, undefined, 'Next scaffolds must never be rewritten as Vite');
  assert.match(nextPackageSaved.observation, /deterministic Next\.js package\.json/);
  console.log('PASS: Next App Router package.json preserves the requested runtime and libraries');

  const tailwindGeneratorCalls = [];
  const { executor: tailwindExecutor, writes: tailwindWrites, traces: tailwindTraces } = makeExecutor(async (...args) => {
    tailwindGeneratorCalls.push(args);
    return 'export default { theme: { extend: { colors: { repeated: {'.repeat(900);
  });
  const tailwindSaved = await tailwindExecutor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'write_file', path: '/tailwind.config.ts', content: '' },
    'Create a Next.js 15 App Router finance dashboard using Tailwind and shadcn/ui.',
    [],
    { ...planSpec, expectedFiles: ['/tailwind.config.ts', '/app/layout.tsx', '/app/page.tsx'] }
  );

  assert.equal(tailwindSaved.ok, true, `empty Tailwind config is generated deterministically: ${tailwindSaved.observation}; issue=${tailwindSaved.structuralIssue || ''}; traces=${JSON.stringify(tailwindTraces.slice(-2))}`);
  assert.equal(tailwindGeneratorCalls.length, 0, 'Tailwind config does not spend a separate generation pass');
  assert.equal(tailwindWrites.length, 1, 'Tailwind config is written atomically once');
  assert.ok(tailwindWrites[0].content.length < 8000, 'Tailwind config stays within the hard config budget');
  assert.match(tailwindWrites[0].content, /export default config;/);
  assert.match(tailwindWrites[0].content, /\.\/app\/\*\*\/\*\.\{ts,tsx\}/);
  assert.equal((tailwindWrites[0].content.match(/export default config;/g) || []).length, 1, 'Tailwind config has no duplicated tail');
  console.log('PASS: Tailwind config is bounded and deterministic');

  const corruptedTailwind = `${'const repeated = { theme: { extend: {} } };\n'.repeat(700)}export default {`;
  const recoveryFiles = { '/tailwind.config.ts': corruptedTailwind };
  const { executor: tailwindRecoveryExecutor, writes: tailwindRecoveryWrites } = makeExecutor(
    async () => '',
    { files: recoveryFiles, isLikelyNewAgentFileTarget: () => false }
  );
  const tailwindRecovered = await tailwindRecoveryExecutor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'edit_file', path: '/tailwind.config.ts', content: '' },
    'Repair the Tailwind configuration.',
    [{ tool: 'read_file', ok: true, path: '/tailwind.config.ts', content: corruptedTailwind }],
    { ...planSpec, expectedFiles: ['/tailwind.config.ts'] }
  );
  assert.equal(tailwindRecovered.ok, true, 'oversized broken Tailwind config is recoverable');
  assert.equal(tailwindRecoveryWrites.length, 1, 'recovery is one atomic replacement');
  assert.ok(tailwindRecoveryWrites[0].content.length < 8000);
  assert.match(tailwindRecovered.observation, /atomically replaced/i);
  console.log('PASS: oversized broken Tailwind config escapes the edit/rewrite deadlock');

  const phasedPlan = {
    ...planSpec,
    needsReadme: true,
    needsRunInstructions: true,
    expectedFiles: ['/tailwind.config.ts', '/app/page.tsx', '/README.md'],
    _activePhase: {
      number: 1,
      total: 3,
      title: 'Foundation',
      tasks: ['tailwind.config.ts', 'app/page.tsx'],
    },
  };
  const pendingPhase = planner.summarizeAgentPendingRequirements(
    'Create a Next.js dashboard.',
    [{ tool: 'write_file', ok: true, path: '/tailwind.config.ts', structuralIssue: 'looks truncated' }],
    phasedPlan
  );
  assert.match(pendingPhase, /tailwind\.config\.ts/, 'a structurally broken saved config remains pending');
  assert.doesNotMatch(pendingPhase, /README\.md|run instructions/i, 'future-phase README cannot block the current phase');
  const nextAction = planner.buildImmediateNextAction('Create a Next.js dashboard.', [], phasedPlan, 9);
  assert.match(nextAction, /Execution budget: 7 tool steps remain/);
  assert.match(nextAction, /NOW: create \/tailwind\.config\.ts/i, 'the next phase task is repeated at the prompt tail');
  console.log('PASS: phased prompt focus excludes future docs and names the immediate task plus remaining budget');

  const brokenPackageJson = JSON.stringify({
    name: 'amora-dating-platform',
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'tsc -b && vite build' },
    dependencies: {
      react: '^1^.3.1',
      'react-dom': '^1^.3.1',
      'react-router-dom': '^2^.26.0',
      'lucide-react': '.439.0',
      clsx: '^3^.1.1',
      'framer-motion': '^4^.5.4',
      zustand: '^6^.5.5',
    },
    devDependencies: {
      '@types/react': '^1^.3.3',
      '@types/react-dom': '^1^.3.0',
      '@vitejs/plugin-react': '^6^.3.1',
      autoprefixer: '^7^.4.20',
      postcss: '^8^.4.45',
      tailwindcss: '^5^.4.10',
      typescript: '^9^.5.4',
      vite: '^9^.4.3',
    },
  }, null, 2);

  const packageGeneratorCalls = [];
  const { executor: packageExecutor, writes: packageWrites, traces: packageTraces } = makeExecutor(async (...args) => {
    packageGeneratorCalls.push(args);
    return '';
  });
  const packageSaved = await packageExecutor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'write_file', path: '/package.json', content: brokenPackageJson },
    'Create a React TypeScript Tailwind dating platform.',
    [],
    { ...planSpec, expectedFiles: ['/package.json'] }
  );

  assert.equal(packageSaved.ok, true, 'mangled package.json versions are repaired and saved');
  assert.equal(packageGeneratorCalls.length, 0, 'inline package.json is repaired locally without regenerating');
  assert.equal(packageWrites.length, 1, 'package.json is written once after deterministic repair');
  const repairedPackage = JSON.parse(packageWrites[0].content);
  assert.equal(repairedPackage.dependencies.react, '^18.3.1');
  assert.equal(repairedPackage.dependencies['react-router-dom'], '^6.26.2');
  assert.equal(repairedPackage.dependencies['lucide-react'], '^0.468.0');
  assert.equal(repairedPackage.devDependencies.tailwindcss, '^3.4.10');
  assert.equal(repairedPackage.devDependencies.typescript, '^5.5.4');
  assert.ok(packageTraces.some((entry) => entry.kind === 'agent_package_json_versions_repaired'), 'package repair is traced');
  console.log('PASS: mangled package.json dependency versions are repaired before save');

  const jsxWithConstProps = [
    "import type { Card, ColumnId } from '../types'",
    "import CardItem from './Card'",
    '',
    'export default function Column({ cards, columnOrder }: { cards: Card[], columnOrder: ColumnId[] }) {',
    "  const columnIndex = columnOrder.indexOf('todo')",
    '  const isFirst = columnIndex === 0',
    '  const isLast = columnIndex === columnOrder.length - 1',
    '  return (',
    '    <section className="column">',
    '      {cards.map(card => (',
    '        <CardItem key={card.id} card={card} isFirst={isFirst} isLast={isLast} />',
    '      ))}',
    '    </section>',
    '  )',
    '}',
  ].join('\n');
  assert.equal(packageExecutor.getJsReassignedConstIssue(jsxWithConstProps), '', 'JSX props like isFirst={isFirst} are not const reassignments');
  assert.match(
    packageExecutor.getJsReassignedConstIssue('const isFirst = true;\nisFirst = false;'),
    /reassigns the const variable `isFirst`/,
    'real const reassignment is still flagged'
  );
  console.log('PASS: JSX props do not trip const reassignment guard');

  let rewriteCalls = 0;
  const currentChessFile = 'function exportFen() {\n  return ${placement} ${turn};\n}\n';
  const { executor: syntaxGuardExecutor, writes: syntaxGuardWrites } = makeExecutor(
    async () => '',
    {
      files: { '/script.js': currentChessFile },
      isLikelyNewAgentFileTarget: () => false,
      generateAgentEditFileProgram: async () => '',
      generateAgentRewriteExistingFileContent: async () => {
        rewriteCalls += 1;
        return 'const replaced = true;';
      },
    }
  );
  const syntaxGuard = await syntaxGuardExecutor.executeDeveloperToolCall(
    'chat_write_repair',
    { action: 'tool', tool: 'edit_file', path: '/script.js', content: '' },
    'Repair the syntax error in the chess app.',
    [
      { tool: 'read_file', ok: true, path: '/script.js', content: currentChessFile },
      { tool: 'validate_files', ok: true, observation: '/script.js: JavaScript syntax error: Unexpected token (line 2:10).' },
    ],
    planSpec
  );
  assert.equal(syntaxGuard.ok, false, 'missing localized edit program blocks the repair safely');
  assert.equal(rewriteCalls, 0, 'localized syntax repair never falls back to a full-file rewrite');
  assert.equal(syntaxGuardWrites.length, 0, 'original file is left untouched');
  assert.match(syntaxGuard.observation, /kept intact|kept the current file/i, 'response asks for an exact edit');
  console.log('PASS: syntax repair cannot trigger a destructive full-file rewrite');
})();
