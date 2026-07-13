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
    name: 'explicit Python desktop stack rejects planner-added HTML preview files',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/main.py|/requirements.txt',
    }, 'Build a Python desktop app using CustomTkinter. File structure: main.py, requirements.txt. Build with pyinstaller.', { forceProjectScope: true }),
    expect: (spec) => {
      assert.equal(spec.primaryStack, 'python');
      assert.deepEqual(spec.expectedFiles, ['/main.py', '/requirements.txt']);
      assert.match(spec.projectContract, /Python project contract/);
      assert.doesNotMatch(spec.projectContract, /Web project contract/);
    },
  },
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
    name: 'edit plan falls back to its named expected files when affected files are omitted',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'edit',
      expected_files: '/template.html|/site.py',
      affected_files: '',
    }, 'add an AI opponent to the existing game', opts),
    expect: (spec) => {
      assert.equal(spec.taskKind, 'edit');
      assert.deepEqual(spec.affectedFiles, ['/template.html', '/site.py']);
    },
  },
  {
    name: 'nested edit targets remain the inspection targets',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'edit',
      affected_files: '/src/components/Landing/Hero.tsx|/src/components/Landing/Features.tsx',
      files_to_inspect: '',
    }, 'replace the icons on the existing landing page', opts),
    expect: (spec) => {
      assert.deepEqual(spec.filesToInspect, [
        '/src/components/Landing/Hero.tsx',
        '/src/components/Landing/Features.tsx',
      ], 'nested affected files must not be replaced by unrelated root config files');
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
  {
    name: 'multi-page web plans preserve pages plus shared source-of-truth files',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/product.html|/pricing.html|/about.html|/contact.html|/css/style.css|/js/components.js|/js/script.js',
    }, 'build a five-page SaaS website', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      assert.equal(spec.taskKind, 'project');
      assert.equal(spec.expectedFiles.length, 8, 'expectedFiles should keep pages plus shared assets');
      assert.ok(spec.expectedFiles.includes('/js/components.js'), 'shared components file must survive normalization');
      assert.ok(spec.expectedFiles.includes('/contact.html'), 'later pages must survive normalization');
    },
  },
  {
    name: 'web phases are structure-first: entry HTML before CSS/JS',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/css/style.css|/css/motion-system.css|/js/components.js|/js/script.js|/product.html|/pricing.html|/about.html|/contact.html',
      phases: 'Runnable core :: index.html hero+nav ; css/style.css ; js/components.js ; js/script.js | Branding & Design System :: brand identity ; visual design system ; motion system | Product Pages :: product.html ; pricing.html ; about.html ; contact.html',
    }, 'build a five-page SaaS website with brand strategy, visual identity, typography, design system, motion system, CRO, SEO, and implementation guide', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      const phaseTitles = spec.phases.map((phase) => phase.title);
      assert.ok(!phaseTitles.some((title) => /branding\s*&\s*design system/i.test(title)),
        'semantic branding phase should not survive as a separate implementation phase');
      // Assert the structure-first PRINCIPLE by file type, not by literal names —
      // the model picks project-appropriate names; we only direct the ordering.
      const firstTasks = spec.phases[0].tasks.map((task) => task.text);
      const firstHtml = firstTasks.findIndex((t) => /\.html?$/i.test(t));
      const firstCss = firstTasks.findIndex((t) => /\.(css|scss|sass|less)$/i.test(t));
      const firstJs = firstTasks.findIndex((t) => /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(t));
      assert.equal(firstHtml, 0, 'entry HTML should be the first file in Phase 1 (structure-first)');
      assert.ok(firstCss > firstHtml, 'CSS should be ordered after the HTML it styles');
      assert.ok(firstJs > firstCss, 'JS should be ordered after the CSS');
      assert.ok(spec.phases.slice(1).some((phase) => (phase.tasks || []).some((task) => /\.html?$/i.test(task.text))),
        'remaining pages should land in a later phase');
      assert.ok(/css\/motion-system\.css/.test(spec.projectContract),
        'project contract should mention all planned CSS files so extra CSS is not orphaned');
    },
  },
  {
    name: 'Next App Router plans drop phantom index.html and start with a runnable slice',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/package.json|/tsconfig.json|/next.config.ts|/postcss.config.mjs|/tailwind.config.ts|/components.json|/app/layout.tsx|/app/page.tsx|/app/globals.css|/app/transactions/page.tsx|/README.md',
      phases: 'Foundation :: /package.json ; /tsconfig.json ; /next.config.ts ; /postcss.config.mjs ; /tailwind.config.ts ; /components.json ; /index.html | Dashboard :: /app/layout.tsx ; /app/page.tsx ; /app/globals.css | Transactions :: /app/transactions/page.tsx | Documentation :: /README.md',
    }, 'Build a Next.js 15 App Router finance dashboard with Tailwind and shadcn/ui.', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      assert.ok(!spec.expectedFiles.includes('/index.html'), 'Next App Router must not inherit a static index.html');
      const firstTasks = spec.phases[0].tasks.map((task) => task.text);
      assert.ok(firstTasks.includes('app/layout.tsx'), 'first phase includes the App Router layout');
      assert.ok(firstTasks.includes('app/page.tsx'), 'first phase includes a runnable route');
      assert.ok(firstTasks.includes('app/globals.css'), 'first phase includes global styling');
      assert.ok(firstTasks.includes('tailwind.config.ts'), 'first phase includes required Tailwind config');
      assert.ok(!firstTasks.includes('README.md'), 'README remains a final-phase deliverable');
    },
  },
  {
    name: 'large Next plans retain support modules and synthesize phases when the model omits them',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: [
        '/package.json', '/tsconfig.json', '/next.config.ts', '/postcss.config.mjs', '/tailwind.config.ts', '/components.json',
        '/src/app/layout.tsx', '/src/app/page.tsx', '/src/app/globals.css', '/src/app/transactions/page.tsx',
        '/src/app/budgets/page.tsx', '/src/app/insights/page.tsx', '/src/app/settings/page.tsx',
        '/src/lib/db.ts', '/src/lib/types.ts', '/src/lib/ai-insights.ts', '/src/lib/csv-parser.ts', '/src/lib/categories.ts',
        '/src/store/use-store.ts', '/src/components/sidebar.tsx', '/src/components/mobile-nav.tsx',
        '/src/components/command-palette.tsx', '/src/components/theme-toggle.tsx', '/src/components/count-up.tsx',
        '/src/components/skeleton-card.tsx', '/src/components/transaction-form.tsx', '/src/components/transaction-table.tsx',
        '/src/components/budget-ring.tsx', '/src/components/dashboard-charts.tsx', '/src/components/insight-card.tsx',
        '/src/components/providers.tsx', '/README.md',
      ].join('|'),
      phases: '',
    }, 'Build a Next.js 15 App Router finance dashboard with Zustand, Recharts, Dexie, Tailwind and shadcn/ui.', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      assert.equal(spec.expectedFiles.length, 32, 'the plan must not be clipped to the old 16-file ceiling');
      assert.ok(spec.expectedFiles.includes('/src/store/use-store.ts'));
      assert.ok(spec.expectedFiles.includes('/src/components/providers.tsx'));
      assert.ok(spec.phases.length >= 3, 'large Next builds should be split into resumable phases');
      const phaseFiles = spec.phases.flatMap((phase) => phase.tasks.map((task) => normalizeWorkspacePath(task.text)));
      assert.equal(new Set(phaseFiles).size, spec.expectedFiles.length, 'each planned file appears in exactly one synthesized phase');
    },
  },
  {
    name: 'single-page web apps keep semantic feature phases',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/css/style.css|/js/script.js',
      phases: 'Runnable skeleton :: index.html layout ; css/style.css ; js/script.js | Core workflow :: create records ; update status ; filter list | Extras :: import/export ; saved views',
    }, 'build a single-page workflow tracker web app', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      assert.equal(spec.phases.length, 3, 'single-page app feature phases should be preserved');
      assert.ok(spec.phases[1].tasks.some((task) => /create records/i.test(task.text)),
        'semantic app workflow task should survive');
    },
  },
  {
    name: 'requested page count caps accidental extra public HTML pages',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/product.html|/pricing.html|/about.html|/contact.html|/css/style.css|/js/components.js|/js/script.js|/brand-strategy.html|/visual-identity.html|/typography.html|/design-system.html|/motion-system.html|/extra-conversion-map.html',
      phases: 'Runnable core :: index.html ; css/style.css ; js/components.js ; js/script.js | Product pages :: product.html ; pricing.html ; about.html ; contact.html | Project notes :: brand-strategy.html ; visual-identity.html ; typography.html ; design-system.html ; motion-system.html ; extra-conversion-map.html',
    }, 'build a five-page SaaS website with brand strategy, visual identity, typography, design system, motion system, CRO, SEO, and implementation guide', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      const htmlFiles = spec.expectedFiles.filter((file) => /\.html?$/.test(file));
      assert.deepEqual(htmlFiles, ['/index.html', '/product.html', '/pricing.html', '/about.html', '/contact.html'],
        'public HTML files must stay capped to the requested five pages');
      assert.ok(spec.expectedFiles.includes('/README.md'), 'written strategy notes should be redirected to README');
      assert.ok(spec.phases.some((phase) => (phase.tasks || []).some((task) => /README\.md/.test(String(task.text || task)))),
        'phase tasks should be redirected to README instead of surplus public pages');
    },
  },
  {
    name: 'explicitly requested design documentation pages are preserved',
    run: () => core.normalizeAgentPlanSpec({
      task_kind: 'project',
      primary_stack: 'web',
      expected_files: '/index.html|/typography.html|/design-system.html|/motion-system.html|/css/style.css',
    }, 'create a design system documentation website with public pages for typography, design system, and motion system', { chatId: 'chat_owns_ws', forceProjectScope: true }),
    expect: (spec) => {
      assert.ok(spec.expectedFiles.includes('/typography.html'), 'explicit typography page should survive');
      assert.ok(spec.expectedFiles.includes('/design-system.html'), 'explicit design-system page should survive');
      assert.ok(spec.expectedFiles.includes('/motion-system.html'), 'explicit motion-system page should survive');
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
