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

console.log('PASS: broken phased project flags all six contract classes; valid unrelated project is clean; no false positives on type-only/wildcard/disjoint-store');
