// Budget dashboard run: Vite run_app dropped `checks` (12 identical builds), App.tsx was
// written before its components (they went unused), and the completion writer
// dropped the agent's own caveat and said VERIFIED.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, 'ui', f), 'utf8');
const executor = read('agent-executor.js');
const ui = read('ai-exe.js');
const core = read('agent-core.js');
const loop = read('agent-loop.js');
const runtime = read('agent-runtime.js');

// Vite: after a passing build the built page is loaded and the model's checks run there.
assert.match(executor, /const runHtmlSmoke = async \(htmlTarget, siteRoot = ''\) => \{/);
assert.match(executor, /const preview = await runHtmlSmoke\('\/dist\/index\.html', '\/dist'\)/);
assert.equal((executor.match(/return withBuiltPreview\(tested \|\| \{/g) || []).length, 2, 'both build-success paths preview');
assert.match(executor, /Then loaded the built app \(dist\/index\.html\) in the preview/);
assert.match(ui, /normalizeWorkspacePath\(siteRoot && siteRoot !== '\/' \? `\$\{siteRoot\}\$\{r\}` : r\)/, '/assets/... resolves under dist/');
assert.match(ui, /if \(moduleScriptsDeclared && moduleScriptsInlined === moduleScriptsDeclared\) usesEsModules = false;/, 'bundled module is not reported as unsupported');
console.log('PASS: Vite builds are previewed with the model\'s checks');

// Write order: root component after the modules it imports; README last.
const rankSrc = core.slice(core.indexOf('const writeRank = (path) => {'), core.indexOf('const nextPath = expectedFiles'));
const writeRank = new Function(`${rankSrc}; return writeRank;`)();
const plan = ['/package.json', '/src/main.tsx', '/src/App.tsx', '/README.md', '/src/styles.css', '/src/components/Chart.tsx', '/src/hooks/useData.ts'];
const order = [...plan].sort((a, b) => writeRank(a) - writeRank(b));
assert.deepEqual(order, ['/package.json', '/src/components/Chart.tsx', '/src/hooks/useData.ts', '/src/App.tsx', '/src/main.tsx', '/src/styles.css', '/README.md']);
console.log('PASS: App/main after their components; stylesheets after everything that uses classes');

// Completion keeps the agent's own caveat.
assert.match(loop, /planSpec\._agentFinalNote = String\(decision\.message\)\.trim\(\)\.slice\(0, 1500\);/);
assert.match(loop, /if \(planSpec\) delete planSpec\._agentFinalNote;/, 'cleared at run start');
assert.match(runtime, /keep every limitation or caveat it states/);
console.log('PASS: completion writer sees the agent\'s closing note');

// The done-criteria review re-runs only after real work (its own nudge doesn't count).
assert.match(loop, /criteriaAuditEventCount === realToolEventCount\(\)/);
assert.match(loop, /!\['final_check', 'criteria_check'\]\.includes/);
console.log('PASS: no identical re-review of an unchanged final');

// A guessed planned file the model read but didn't need to change doesn't block finishing.
global.window = global;
require(path.join(root, 'ui', 'agent-planner.js'));
const norm = (p) => { let s = String(p || '').trim(); if (!s.startsWith('/')) s = `/${s}`; return s.replace(/\/+/g, '/'); };
const planner = global.AIExeAgentPlanner.createAgentPlanner({ normalizeWorkspacePath: norm, isAgentTaskGameLike: () => false, hasReadmeRunInstructions: () => false, isLikelyCompleteReadme: () => false, isExplicitReadmeOrDocsTask: () => false });
const editPlan = { taskKind: 'edit', affectedFiles: ['/src/components/TransactionSection.tsx', '/src/components/AppHeader.tsx'], filesToInspect: [], expectedFiles: [], validationSteps: [] };
const readBoth = { tool: 'read_files', ok: true, paths: ['/src/components/TransactionSection.tsx', '/src/components/AppHeader.tsx'] };
const edit = { tool: 'edit_file', ok: true, path: '/src/components/TransactionSection.tsx', content: 'x' };
const reqs = (events) => planner.buildAgentTaskRequirements('rename the Transactions section to Activity', events, editPlan)
  .filter((r) => /AppHeader/.test(r.label));
assert.equal(reqs([readBoth, edit])[0].met, true, 'read + edited elsewhere = model judged no change needed');
assert.equal(reqs([edit])[0].met, false, 'never looked at it = still pending');
assert.equal(reqs([readBoth])[0].met, false, 'nothing changed yet = still pending');
console.log('PASS: guessed planned files do not force edits the model judged unnecessary');
assert.match(loop, /if \(runErr && runAppFinishNudges < \(checksOnly \? 1 : 2\)\) \{/, 'failed self-checks: one nudge, then the explanation stands');
console.log('PASS: one nudge for failed self-checks');
assert.match(loop, /if \(stillBrokenRun && !onlyChecksFailed\) \{/, 'failed self-checks are not called a startup error');
console.log('PASS: no false "startup error" note');

// Latency: route call runs alongside the mode call (API providers only); Venice list warmed at boot.
const uiNow = read('ai-exe.js');
assert.ok(uiNow.indexOf('const speculativePreflight') < uiNow.indexOf('const turnModes = await decideTurnModes(chatId, promptText, modes);'), 'route call starts before the mode call is awaited');
assert.match(uiNow, /!isVeniceAdapterSelected\(\) && !requestToken\.preflightChoiceResolved/, 'not on the serialized Venice adapter');
assert.match(uiNow, /const preflightDecision = \(speculativePreflight && await speculativePreflight\)/);
assert.match(uiNow, /Warm the Venice list \(uncensored fallback\)/);
console.log('PASS: routers overlap; first chat does not wait on the Venice list');

// Kindred: 38 classes (whole chat window) had no CSS rule; the build + validate passed.
const exSrc = executor.slice(executor.indexOf('    function extractJsxClassNames(source) {'), executor.indexOf('    // After a web build:'));
const extractJsxClassNames = new Function(`${exSrc}; return extractJsxClassNames;`)();
const jsx = `<div className="chat-bubble chat-bubble--mine"><p className={\`row \${mine ? 'row--mine' : ''}\`} />
<b className={mode === 'login' ? 'tab tab--active' : 'tab'} /><i className={cn('icon', open && "icon--open")} /></div>`;
assert.deepEqual(extractJsxClassNames(jsx).sort(), ['chat-bubble', 'chat-bubble--mine', 'icon', 'icon--open', 'row', 'row--mine', 'tab', 'tab--active'].sort(), 'compared values (login) are not classes');
assert.match(executor, /Unstyled classes — used in components but no CSS rule exists in the build/);
assert.match(executor, /const unstyled = await findUnstyledClassNames\(built\.output\);/);
// Tailwind template: no uninstalled plugin; shadcn tokens only when the CSS defines them.
const twSrc = executor.slice(executor.indexOf('    function buildDeterministicTailwindConfig(path, toolEvents = []) {'), executor.indexOf('    // A code file cut mid-statement'));
const buildTw = new Function('deps', `${twSrc}; return buildDeterministicTailwindConfig;`)({ normalizeWorkspacePath: norm });
const plainTw = buildTw('/tailwind.config.ts', [{ ok: true, path: '/src/index.css', content: ':root { --accent: #c64d68; }' }]);
assert.ok(!/require\(/.test(plainTw) && !/--primary/.test(plainTw) && /plugins: \[\]/.test(plainTw), 'no shadcn tokens or plugin without matching CSS');
const shadTw = buildTw('/tailwind.config.ts', [{ ok: true, path: '/src/index.css', content: ':root { --primary: 222.2 47.4% 11.2%; }' }]);
assert.ok(/hsl\(var\(--primary\)\)/.test(shadTw), 'shadcn tokens when the CSS defines them');
console.log('PASS: unstyled-class sensor + consistent Tailwind template');

// A chat's follow-up runs in ITS project when another chat's project is open.
let uiNow2; assert.match(uiNow2 = read('ai-exe.js'), /if \(requestToken && \(requestToken\.isAgentResume \|\| openRootIsOtherChats\)\) \{/);
assert.match(uiNow2, /String\(c\.id\) !== String\(chatId\)/, 'only another chat\'s project triggers the switch');
// Harness internals stay out of the user's feed.
const loopNow = read('agent-loop.js');
assert.ok(!/unblocking'/.test(loopNow) && !/· cached/.test(loopNow), 'no internal read labels');
assert.ok(!/That's already handled — moving to/.test(loopNow), 'harness does not narrate in the model\'s voice');
assert.match(loopNow, /if what the request refers to isn't in this project — finish and say so plainly/);
console.log('PASS: chat reopens its own project; no internal labels in the feed');
assert.match(read('ai-exe.js'), /if \(openRootIsOtherChats\) \{\n\s+const name = String\(binding && binding\.rootName/, 'a failed restore stops instead of running in another chat\'s project');
console.log('PASS: no run in another chat\'s project when its own folder is gone');
assert.match(read('agent-loop.js'), /An install proves nothing about the build/, 'installs do not clear a red build');
console.log('PASS: a clean npm install does not count as a passing build');
let executor2; assert.match(executor2 = read('agent-executor.js'), /Tailwind is configured but no stylesheet loads it/, 'names the missing @tailwind cause');
console.log('PASS: unstyled report names a Tailwind that is never loaded');
