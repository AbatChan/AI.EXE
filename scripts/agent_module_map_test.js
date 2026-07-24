// v9.7.5 — files generated in one run must agree on where the shared modules live.
//
// Regression (SWARM Phase 3): the batch generator got NO project context, and the
// single-file prompt's sibling CONTENT is budget-driven, so the store and types modules
// were starved by big engine files. Each batch then invented its own path —
// "@/store/showStore", "../store/swarmStore", "@/formations/types" — producing 44
// unresolved imports in one phase and burning the whole step budget on repair.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');

// ---- Wiring ----
assert.match(planner, /function buildAgentModuleMap\(toolEvents = \[\], options = \{\}\)/, 'the module map exists');
assert.match(planner, /const moduleMap = buildAgentModuleMap\(toolEvents, \{ excludePath: normalizedExclude, plannedFiles: expectedFiles \}\);/,
  'single-file prompts get the map, including the plan\'s canonical paths');
// It must sit BEFORE the budget-driven sibling content, or a starved budget drops it too.
const stateFn = planner.slice(planner.indexOf('function buildAgentProjectStateContext'), planner.indexOf('async function loadDesignFoundationFor'));
const mapAt = stateFn.indexOf('buildAgentModuleMap(toolEvents');
const budgetAt = stateFn.indexOf('fullContentBudget');
assert.ok(mapAt > -1 && budgetAt > -1 && mapAt < budgetAt, 'the map is emitted ahead of the content budget');
assert.match(runtime, /deps\.buildAgentModuleMap\(toolEvents, \{/, 'the BATCH generator gets the map');
assert.match(runtime, /plannedFiles: Array\.isArray\(planSpec && planSpec\.expectedFiles\)/, 'the batch map carries the plan\'s canonical paths');
const batchStart = runtime.indexOf('async function generateAgentBatchFileContents');
const batchFn = runtime.slice(batchStart, runtime.indexOf('const budget = Math.max(1', batchStart));
assert.ok(batchFn.indexOf('moduleMap ?') > -1, 'the batch prompt actually includes it');
assert.match(planner, /\n {6}buildAgentModuleMap,\n/, 'the planner exports it');
assert.match(aiExe, /\n {4}buildAgentModuleMap,\n/, 'it is wired into the runtime deps');

// ---- Behaviour ----
const start = planner.indexOf('function buildAgentModuleMap(');
const end = planner.indexOf('function buildAgentProjectStateContext(');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`
  function normalizeWorkspacePath(p) { return '/' + String(p || '').replace(/^\\/+/, '').replace(/\\/+/g, '/'); }
  ${planner.slice(start, end)}
  this.api = { buildAgentModuleMap };
`, sandbox);
const { buildAgentModuleMap: buildMap } = sandbox.api;

const events = [
  { tool: 'write_file', ok: true, path: '/src/store/useSwarmStore.ts', content: `import { create } from 'zustand';\nexport const useSwarmStore = create(() => ({}));` },
  { tool: 'write_file', ok: true, path: '/src/types/index.ts', content: `export interface Drone { id: number }\nexport type FormationType = 'sphere';\nexport { helper } from './helper';` },
  // A batch write reports its extra files under autoWrittenFiles, not as separate events.
  { tool: 'write_files', ok: true, path: '/src/components/ColorPanel.tsx', content: `import { useSwarmStore } from '@/store/useSwarmStore';\nexport default function ColorPanel() { return null; }`,
    autoWrittenFiles: [{ path: '/src/components/SlidersPanel.tsx', content: `export function SlidersPanel() { return null; }` }] },
  { tool: 'write_file', ok: false, path: '/src/never.ts', content: `export const nope = 1;` },
  { tool: 'write_file', ok: true, path: '/src/app/globals.css', content: `.glass { color: red }` },
];
const map = buildMap(events);

assert.match(map, /\/src\/store\/useSwarmStore\.ts → useSwarmStore/, 'the store path and export name are both stated');
assert.match(map, /\/src\/types\/index\.ts → .*Drone/, 'type exports are listed');
assert.match(map, /FormationType/, 'type aliases count as exports');
assert.match(map, /helper/, 're-exported names are listed');
assert.match(map, /\/src\/components\/ColorPanel\.tsx → default/, 'a default export is named');
assert.match(map, /SlidersPanel\.tsx/, 'files written inside a batch appear in the map');
assert.doesNotMatch(map, /never\.ts/, 'a FAILED write is not advertised as existing');
assert.doesNotMatch(map, /globals\.css/, 'non-modules are not module-map entries');
assert.match(map, /Do NOT invent a different path/, 'the instruction is explicit about not inventing paths');

// The alias line appears only when the project actually uses "@/".
assert.match(map, /"@\/" alias resolves to "\/src\/"/, 'the alias is explained when the project uses it');
const noAlias = buildMap([{ tool: 'write_file', ok: true, path: '/src/a.ts', content: `import x from './b';\nexport const a = 1;` }]);
assert.doesNotMatch(noAlias, /alias resolves/, 'no alias note for a project that does not use one');
// tsconfig defines the alias before any file has imported through it.
const aliasFromConfig = buildMap([
  { tool: 'write_file', ok: true, path: '/tsconfig.json', content: `{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}` },
  { tool: 'write_file', ok: true, path: '/src/store/useSwarmStore.ts', content: `export const useSwarmStore = 1;` },
]);
assert.match(aliasFromConfig, /alias resolves/, 'the tsconfig paths entry is enough to state the alias');

// The file being written is excluded — it does not exist yet.
const excluded = buildMap(events, { excludePath: '/src/types/index.ts' });
assert.doesNotMatch(excluded, /\/src\/types\/index\.ts/, 'the target file is not listed as an existing module');
assert.match(excluded, /useSwarmStore/, 'its siblings still are');

// ---- Planned-but-unwritten modules get a canonical path BEFORE anyone invents one ----
// Regression: Phase 2 built the UI before the store existed, invented "@/lib/store", and
// every later phase inherited that broken path (51 contract issues by Phase 4).
const planned = buildMap(
  [{ tool: 'write_file', ok: true, path: '/src/components/ControlDock.tsx', content: `export function ControlDock() { return null; }` }],
  { plannedFiles: ['/src/store/useSwarmStore.ts', '/src/types/index.ts', '/src/app/globals.css', '/src/components/ControlDock.tsx'] },
);
assert.match(planned, /PLANNED MODULES/, 'planned-but-unbuilt modules are named');
assert.match(planned, /- \/src\/store\/useSwarmStore\.ts/, 'the store has a canonical path before it exists');
assert.doesNotMatch(planned, /PLANNED MODULES[\s\S]*globals\.css/, 'non-modules are not planned module entries');
// A file that already exists belongs in the EXISTING section, never twice.
assert.equal((planned.match(/ControlDock\.tsx/g) || []).length, 1, 'an existing file is not also listed as planned');
assert.match(planned, /never invent a different one/, 'the instruction says not to invent an alternative');

// ---- Repeated identical failure escalates instead of repeating ----
assert.match(loop, /This is the SECOND time this exact rejection came back/, 'a repeated rejection is escalated');
assert.match(loop, /const sameFailureBefore = toolEvents\.some/, 'the repeat is detected from real history');
assert.match(loop, /agent_repeated_failure_escalated/, 'the escalation is traced');
const escalation = loop.slice(loop.indexOf('if (!toolResult.ok && clippedObservation)'), loop.indexOf('toolEvents.push({\n          tool: decision.tool,'));
assert.match(escalation, /every place this change touches/, 'it names the widened-edit route');
assert.match(escalation, /write_file with the corrected complete content/, 'it names the whole-file route');
assert.ok(loop.indexOf('let clippedObservation') > -1, 'the observation is mutable so the escalation reaches the model');
assert.match(loop, /observation: clippedObservation,/, 'the escalated text is what gets stored');

console.log('PASS: every file generation — batch included — sees the real module paths and export names before it writes; a repeated identical rejection escalates to a shape that can land');
