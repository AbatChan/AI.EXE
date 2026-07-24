const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const executor = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');
const cmake = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const safeVersionsBlock = sliceBetween(executor, 'const packageJsonSafeVersions = {', 'function hasOwn(');
const dependencyBlock = sliceBetween(executor, 'function hasOwn(', 'function scrubTsconfigBuildBreakers(');

// Source-level guarantees: no unknown → "latest", unknown packages surfaced for review.
assert.doesNotMatch(dependencyBlock, /packageJsonSafeVersions\[name\]\s*\|\|\s*['"]latest['"]/, 'unknown deps must never fall back to "latest"');
assert.match(dependencyBlock, /unknown\.push\(\{ name, importers \}\)/, 'unknown packages must be returned for review');
assert.match(executor, /Skipped unverified imported packages; they were NOT added automatically/, 'user must be told unknown deps were blocked');
assert.match(executor, /Inspect these names for typos\/hallucinations before installing anything/, 'post-failure advisory must flag unknown imports');

// Execute the REAL helpers out of the source (they are closure-scoped, not exported).
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${safeVersionsBlock}\n${dependencyBlock}\nthis.api = { isMangledPackageVersion, collectMissingAppDependencies, reconcilePackageJsonWithImports, repairPackageJsonDependencyVersions };`, sandbox);
const api = sandbox.api;

const plain = (v) => JSON.parse(JSON.stringify(v));
const names = (list) => plain(list).map((d) => d.name).sort();

// A typo import (framer-motoin) and a real one (framer-motion) are both DETECTED,
// node: builtins and @/ aliases excluded, already-declared react excluded.
const missing = api.collectMissingAppDependencies(
  [{
    tool: 'write_file', ok: true, path: '/src/components/Card.tsx',
    content: [
      'import { motion } from "framer-motion";',
      'import bad from "framer-motoin";',
      'import fs from "node:fs";',
      'import local from "@/components/local";',
      'import React from "react";',
    ].join('\n'),
  }],
  JSON.stringify({ dependencies: { react: '^18.3.1' } }),
);
assert.deepEqual(names(missing), ['framer-motion', 'framer-motoin'], 'both real and typo imports are detected as missing');

// Reconcile: known framer-motion is PINNED; typo framer-motoin is flagged unknown, NEVER written.
const reconciled = plain(api.reconcilePackageJsonWithImports(JSON.stringify({ dependencies: { react: '^18.3.1' } }, null, 2), missing));
const reconciledPkg = JSON.parse(reconciled.content);
assert.equal(reconciledPkg.dependencies['framer-motion'], '^11.5.4', 'known dep pinned from the table');
assert.equal(reconciledPkg.dependencies['framer-motoin'], undefined, 'typo dep must NOT be written');
assert.deepEqual(reconciled.unknown.map((d) => d.name), ['framer-motoin'], 'typo dep returned as unknown');
assert.ok(reconciled.unknown[0].importers.includes('/src/components/Card.tsx'), 'unknown dep carries its importing file');

// Known Venice corruption is repaired; unknown corruption is left + reported (not "latest").
const knownRepair = plain(api.repairPackageJsonDependencyVersions(JSON.stringify({ dependencies: { 'framer-motion': '^1^.5.4' } })));
assert.equal(knownRepair.repaired, true);
assert.deepEqual(knownRepair.remainingBad, []);
assert.equal(JSON.parse(knownRepair.content).dependencies['framer-motion'], '^11.5.4');

const unknownRepair = plain(api.repairPackageJsonDependencyVersions(JSON.stringify({ dependencies: { 'framer-motoin': '^1^.5.4' } })));
assert.equal(unknownRepair.repaired, false, 'unknown corrupted dep is not silently repaired');
assert.equal(JSON.parse(unknownRepair.content).dependencies['framer-motoin'], '^1^.5.4', 'unknown corrupted version left untouched');
assert.ok(unknownRepair.remainingBad.some((e) => e.includes('framer-motoin')), 'unknown corruption is reported');

// Valid non-numeric specs must NOT be mistaken for corruption.
['workspace:*', 'file:../shared', 'link:../shared', 'npm:react@18.3.1', 'git+https://github.com/x/y.git', 'beta', 'canary', 'latest', '^18.3.1', '~5.0.0', '*']
  .forEach((v) => assert.equal(api.isMangledPackageVersion(v), false, `${v} must be treated as valid`));
// Real corruption must still be caught.
['^2^.114.0', '.27.0', '.169.0', '^1^.5.4'].forEach((v) => assert.equal(api.isMangledPackageVersion(v), true, `${v} must be flagged corrupt`));

// Version sources stay synchronized.
const cmakeVersion = (cmake.match(/set\(AI_EXE_APP_VERSION "([^"]+)"/) || [])[1];
assert.equal(packageJson.version, cmakeVersion, 'package.json version must match CMake AI_EXE_APP_VERSION');
assert.equal(packageJson.version, '9.6.6', 'this patch ships as v9.6.6');

console.log('PASS: known deps pinned, unknown/typo imports blocked (never "latest"), valid specs preserved, versions synced');
