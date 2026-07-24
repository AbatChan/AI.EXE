const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// Wiring: the checker is a real function and its advisory formatter exists.
assert.match(planner, /function runCrossPhaseContractCheck\(files, options/, 'contract checker exists');
assert.match(planner, /function buildContractCheckAdvisory\(result\)/, 'advisory formatter exists');
// It must NOT hardcode any app-specific name.
['SWARM', 'drone', 'ReactCurrentOwner', 'showStore', 'useRobotStore', 'framer-motion', 'zustand'].forEach((needle) => {
  const engine = sliceBetween(planner, 'function runCrossPhaseContractCheck(', 'function buildContractCheckAdvisory(');
  assert.doesNotMatch(engine, new RegExp(needle, 'i'), `engine must not hardcode "${needle}"`);
});

const block = sliceBetween(planner, 'function runCrossPhaseContractCheck(', 'async function buildAgentDecisionPrompt(');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.api = { runCrossPhaseContractCheck, buildContractCheckAdvisory };`, sandbox);
const { runCrossPhaseContractCheck: check, buildContractCheckAdvisory: advisory } = sandbox.api;

const kinds = (r) => r.issues.map((i) => i.kind).sort();

// ---- Fixture A: a BROKEN phased project (SWARM regression shape, generic names) ----
const broken = {
  '/package.json': JSON.stringify({ dependencies: { react: '^18', 'react-dom': '^18', three: '^0.169', zustand: '^4', '@react-three/fiber': '^8' } }),
  '/src/store/useStore.ts': `import { create } from 'zustand';
interface State { mode: string; isPlaying: boolean; keyframes: number[]; setMode: () => void; }
export const useStore = create<State>((set) => ({ mode: 'fk', isPlaying: false, keyframes: [], setMode: () => set({}) }));`,
  '/src/store/showStore.ts': `import { create } from 'zustand';
export const useShowStore = create((set) => ({ isPlaying: false, keyframes: [], drones: [], setDrones: () => set({}) }));`,
  '/src/app/page.tsx': `import { Scene } from '@/components/Scene';
import { useStore } from '@/store/useStore';
export default function Page() { const m = useStore((s) => s.mode); return null; }`,
  '/src/components/Scene.tsx': `import { useShowStore } from '@/store/showStore';
import { Drone } from './Drone';
import { motion } from 'framer-motion';
import { Missing } from './Nope';
export function Scene() {
  const rec = useShowStore((s) => s.recording);
  return null;
}`,
  '/src/components/Drone.tsx': `export function DroneMesh() { return null; }`,
};
const depsOf = (files) => Object.keys(JSON.parse(files['/package.json']).dependencies || {});
const rBroken = check(broken, { dependencies: depsOf(broken) });

assert.equal(rBroken.ok, false, 'broken project is flagged');
const ks = kinds(rBroken);
['unresolved-import', 'undeclared-package', 'missing-export', 'duplicate-store', 'unknown-store-property'].forEach((k) => {
  assert.ok(ks.includes(k), `broken project reports ${k} (got: ${ks.join(', ')})`);
});
// Precise evidence for each finding.
assert.ok(rBroken.issues.some((i) => i.kind === 'unresolved-import' && /Nope/.test(i.target || i.message)), './Nope is the unresolved import');
assert.ok(rBroken.issues.some((i) => i.kind === 'undeclared-package' && i.symbol === 'framer-motion'), 'framer-motion is the undeclared package');
assert.ok(rBroken.issues.some((i) => i.kind === 'missing-export' && i.symbol === 'Drone'), 'Drone is the missing named export');
assert.ok(rBroken.issues.some((i) => i.kind === 'duplicate-store'), 'the two overlapping stores are flagged');
assert.ok(rBroken.issues.some((i) => i.kind === 'unknown-store-property' && i.symbol === 'recording'), 'recording is the unknown store property');
// One batched result.
assert.ok(Array.isArray(rBroken.issues) && rBroken.issues.length >= 5, 'all issues batched into one result');
assert.match(advisory(rBroken), /CROSS-PHASE CONTRACT ISSUES/);
assert.match(advisory(rBroken), /do NOT auto-create adapter stores or install unknown packages/);

// ---- Fixture B: a VALID, unrelated project (recipes app) — must be CLEAN ----
const valid = {
  '/package.json': JSON.stringify({ dependencies: { react: '^18', 'react-dom': '^18', zustand: '^4' } }),
  '/src/store/useRecipes.ts': `import { create } from 'zustand';
export const useRecipes = create((set) => ({ recipes: [], filter: '', setFilter: (v) => set({ filter: v }) }));`,
  '/src/app/page.tsx': `import { RecipeList } from '@/components/RecipeList';
import { useRecipes } from '@/store/useRecipes';
export default function Page() { const r = useRecipes((s) => s.recipes); return null; }`,
  '/src/components/RecipeList.tsx': `import * as React from 'react';
import { useRecipes } from '@/store/useRecipes';
export function RecipeList() { const f = useRecipes((s) => s.filter); return null; }`,
};
const rValid = check(valid, { dependencies: depsOf(valid) });
assert.equal(rValid.issues.length, 0, `valid unrelated project is clean (got: ${JSON.stringify(rValid.issues)})`);
assert.equal(rValid.ok, true, 'valid project passes');
assert.equal(advisory(rValid), '', 'no advisory for a clean project');

// ---- No-false-positive guards ----
// type-only import of a symbol the target doesn't value-export must NOT be flagged.
const typeOnly = check({
  '/a.ts': `import type { Foo } from './b';\nexport const x = 1;`,
  '/b.ts': `export const y = 2;`,
}, { dependencies: [] });
assert.equal(typeOnly.issues.filter((i) => i.kind === 'missing-export').length, 0, 'type-only imports are not export-checked');
// a wildcard re-export target suppresses missing-export false positives.
const wildcard = check({
  '/a.ts': `import { Anything } from './barrel';\nexport const x = 1;`,
  '/barrel.ts': `export * from './impl';\nexport const known = 1;`,
}, { dependencies: [] });
assert.equal(wildcard.issues.filter((i) => i.kind === 'missing-export').length, 0, 'wildcard re-exports are not falsely flagged');
// two stores with DISJOINT responsibilities are not "duplicate ownership".
const twoDomains = check({
  '/package.json': JSON.stringify({ dependencies: { zustand: '^4' } }),
  '/src/cart.ts': `import { create } from 'zustand';\nexport const useCart = create((set) => ({ items: [], addItem: () => set({}) }));`,
  '/src/theme.ts': `import { create } from 'zustand';\nexport const useTheme = create((set) => ({ dark: false, toggle: () => set({}) }));`,
  '/src/app.tsx': `import { useCart } from './cart';\nimport { useTheme } from './theme';\nexport const A = () => { useCart((s) => s.items); useTheme((s) => s.dark); return null; };`,
}, { dependencies: ['zustand'] });
assert.equal(twoDomains.issues.filter((i) => i.kind === 'duplicate-store').length, 0, 'disjoint domain stores are not flagged as duplicates');

// ---- Asset imports: a CSS/image import is not a module, but it IS a real file ----
// Regression: only JS/TS were collected, so `import "./globals.css"` read as missing.
const withAssets = {
  '/src/app/layout.tsx': `import './globals.css';\nimport logo from '../assets/logo.svg';\nexport default function L() { return null; }`,
};
const assetPaths = ['/src/app/globals.css', '/src/assets/logo.svg'];
const rAssets = check(withAssets, { dependencies: [], assetPaths });
assert.equal(rAssets.issues.filter((i) => i.kind === 'unresolved-import').length, 0,
  `existing css/svg imports are resolved, not flagged (got: ${JSON.stringify(rAssets.issues)})`);
// A genuinely absent asset is still reported.
const rMissingAsset = check(withAssets, { dependencies: [], assetPaths: ['/src/assets/logo.svg'] });
assert.ok(rMissingAsset.issues.some((i) => i.kind === 'unresolved-import' && /globals\.css/.test(i.target || i.message)),
  'an asset that really is missing is still flagged');
// Bundler query suffixes are not part of the path.
const rQuery = check({ '/src/a.ts': `import u from './pic.png?url';\nexport const x = 1;` },
  { dependencies: [], assetPaths: ['/src/pic.png'] });
assert.equal(rQuery.issues.length, 0, '?url suffix resolves to the real asset');

// ---- Truncated walk: a partial view must never claim a file is missing ----
const rTruncated = check(withAssets, { dependencies: [], assetPaths: [], truncated: true });
assert.equal(rTruncated.issues.filter((i) => i.kind === 'unresolved-import').length, 0,
  'a capped workspace walk cannot prove absence, so it claims none');
// Truncation must NOT silence the checks that need no directory listing.
const rTruncatedPkg = check({
  '/package.json': JSON.stringify({ dependencies: { react: '^18' } }),
  '/src/a.tsx': `import { motion } from 'framer-motion';\nexport const A = () => null;`,
}, { dependencies: ['react'], truncated: true });
assert.ok(rTruncatedPkg.issues.some((i) => i.kind === 'undeclared-package' && i.symbol === 'framer-motion'),
  'undeclared packages are still reported when the walk was truncated');

// ---- Phase awareness: a planned file a later phase writes is scheduled, not broken ----
// Regression: Phase 1 wrote page.tsx importing components Phase 2/3 own, and the check
// reported 5 red "no matching file exists" issues on a phase that was going exactly to plan.
const phase1 = {
  '/package.json': JSON.stringify({ dependencies: { react: '^18' } }),
  '/src/app/page.tsx': `import { ControlDock } from '@/components/ControlDock';
import { useSwarmStore } from '@/store/useSwarmStore';
import { Ghost } from '@/components/NotInThePlan';
export default function Page() { return null; }`,
};
const planned = ['/src/components/ControlDock.tsx', '/src/store/useSwarmStore.ts', '/src/app/page.tsx'];
const rMidBuild = check(phase1, { dependencies: ['react'], plannedFiles: planned, deferPlannedImports: true });
assert.equal(rMidBuild.issues.filter((i) => i.kind === 'unresolved-import' && /ControlDock|useSwarmStore/.test(i.target || '')).length, 0,
  'planned-but-unbuilt imports are not issues mid-build');
assert.equal(rMidBuild.deferred.length, 2, 'they are reported separately as scheduled work');
assert.ok(rMidBuild.deferred.every((d) => d.kind === 'planned-import'), 'deferred entries are typed');
// An import NOT in the plan is still a real defect, even mid-build.
assert.ok(rMidBuild.issues.some((i) => i.kind === 'unresolved-import' && /NotInThePlan/.test(i.target || '')),
  'an unplanned missing import is still flagged mid-build');

// In the FINAL phase nothing is left to build, so the same imports ARE defects.
const rFinal = check(phase1, { dependencies: ['react'], plannedFiles: planned, deferPlannedImports: false });
assert.equal(rFinal.issues.filter((i) => i.kind === 'unresolved-import').length, 3,
  'the final phase reports every missing file, planned or not');
assert.equal(rFinal.deferred.length, 0, 'nothing is deferred once there are no later phases');
// Deferral needs a plan: without one, nothing is silently excused.
const rNoPlan = check(phase1, { dependencies: ['react'], deferPlannedImports: true });
assert.equal(rNoPlan.issues.filter((i) => i.kind === 'unresolved-import').length, 3, 'no plan means no deferral');

console.log('PASS: broken phased project flags all six contract classes; valid unrelated project is clean; no false positives on type-only/wildcard/disjoint-store/asset-imports/truncated-walk; planned later-phase imports defer mid-build and surface in the final phase');
