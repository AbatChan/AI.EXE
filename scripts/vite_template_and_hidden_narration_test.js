// Habit Tracker (13.5.3): the Vite package.json template dropped the test setup Luna needed,
// and a guard-blocked (hidden) step left its narration orphaned next to the next note.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const executor = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');
const slice = (a, b) => executor.slice(executor.indexOf(a), executor.indexOf(b, executor.indexOf(a)));
const ctx = {
  deps: { normalizeWorkspacePath: (p) => String(p || ''), deriveProjectNameFromTask: () => 'habit-tracker' },
  getAllPlannedFiles: (plan) => plan.expectedFiles,
};
vm.createContext(ctx);
vm.runInContext(`${slice('const packageJsonSafeVersions = {', 'function hasOwn(')}\n${slice('function buildDeterministicPackageJson(', 'function buildDeterministicTailwindConfig(')}\nthis.build = buildDeterministicPackageJson;`, ctx);

const withTests = JSON.parse(ctx.build('/package.json', 'Vite + React + TypeScript habit tracker', { projectName: 'habit-tracker', expectedFiles: ['/vite.config.ts', '/src/App.tsx', '/src/lib/habits.test.ts'] }));
assert.equal(withTests.scripts.test, 'vitest run', 'planned *.test.ts -> npm test');
assert.equal(withTests.devDependencies.vitest, '^2.1.9', 'vitest 2 matches the template\'s Vite 5');
const noTests = JSON.parse(ctx.build('/package.json', 'Vite + React + TypeScript landing page', { projectName: 'x', expectedFiles: ['/vite.config.ts', '/src/App.tsx'] }));
assert.equal(noTests.scripts.test, undefined);
assert.equal(noTests.devDependencies.vitest, undefined);
console.log('PASS: Vite template adds vitest + npm test only when tests are planned');
// Dating Discovery: planned tailwind/postcss configs but no packages -> build failed on autoprefixer.
const withTw = JSON.parse(ctx.build('/package.json', 'dating platform UI', { projectName: 'x', expectedFiles: ['/vite.config.ts', '/tailwind.config.ts', '/postcss.config.js', '/src/App.tsx'] }));
assert.ok(withTw.devDependencies.tailwindcss && withTw.devDependencies.postcss && withTw.devDependencies.autoprefixer, 'planned Tailwind config -> its packages');
assert.equal(noTests.devDependencies.tailwindcss, undefined, 'no Tailwind planned -> none added');
console.log('PASS: planned Tailwind/PostCSS configs bring their packages');

const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
assert.match(loop, /const toolRow = deps\.buildAgentActivityFromToolResult\(decision, toolResult, toolEvents\);\n\s+if \(!toolRow && toolResult && !toolResult\.ok\) retractStepNarration\(\);/);
assert.match(loop, /if \(card\) appendAgentActivity\(card\);\n\s+else retractStepNarration\(\);/);
assert.match(loop, /stepNarrationDetail = '';\n\s+if \(narration\) appendAgentNarration\(narration\);/, 'reset per step');

const rsrc = fs.readFileSync(path.join(root, 'ui', 'chat-renderer.js'), 'utf8');
assert.match(rsrc, /function retractActiveAgentStreamThought\(chatId, detail\)/);
assert.match(fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8'), /pushActiveAgentStreamActivity,\n\s+retractActiveAgentStreamThought,/, 'loop gets the retract dep');
assert.match(fs.readFileSync(path.join(root, 'ui', 'chat-renderer.js'), 'utf8'), /\(commandErrors \? 'Tests failed' : 'Tests passed'\)/, 'test commands are labelled as tests');
console.log('PASS: a hidden guard step takes its narration with it');
