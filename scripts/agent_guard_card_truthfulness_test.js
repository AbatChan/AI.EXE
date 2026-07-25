// v9.7.3 — a narrated intention must always end in a visible card, and stacked guards
// must never leave the model with no legal move.
//
// Regression: the model said "adding @react-three/drei now", the rewrite guard blocked
// the write with `continue` and no card, and the run showed three promises, no cards, no
// file change — then finalized with the dependency still missing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'ui', 'chat-renderer.js'), 'utf8');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const executor = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');

// ---- 1. Every guard block goes through the carding helper ----
assert.match(loop, /const pushGuardBlock = \(blockedDecision, event\) => \{/, 'pushGuardBlock helper exists');
assert.match(loop, /buildAgentActivityFromToolResult\(blockedDecision, event, toolEvents\)/,
  'the helper renders the block through the normal tool-result card path');

// No guard-block event may be pushed straight onto toolEvents: that is the silent path.
const guardPushes = loop.split('\n').reduce((acc, line, i, lines) => {
  if (!/_guardBlock: true/.test(line)) return acc;
  // Walk back to the call that opened this object literal.
  for (let j = i; j >= 0 && j > i - 8; j -= 1) {
    if (/pushGuardBlock\(/.test(lines[j])) return acc.concat({ line: i + 1, via: 'helper' });
    if (/toolEvents\.push\(\{/.test(lines[j])) return acc.concat({ line: i + 1, via: 'raw' });
  }
  return acc.concat({ line: i + 1, via: 'unknown' });
}, []);
// Anything not routed through the helper (e.g. the read guards that SERVE content back
// as ok:true) must card itself right after the push.
const rawBlocks = guardPushes.filter((g) => g.via !== 'helper');
rawBlocks.forEach((g) => {
  const window = loop.split('\n').slice(g.line - 1, g.line + 26).join('\n');
  assert.match(window, /appendAgentActivity\(/,
    `guard block at agent-loop.js:${g.line} pushes an event with no card — a narrated step would render as silence`);
});
assert.ok(guardPushes.filter((g) => g.via === 'helper').length >= 6,
  `most guard blocks route through pushGuardBlock (got ${guardPushes.filter((g) => g.via === 'helper').length})`);

// ---- 2. A blocked CHANGE reads as blocked, not as a skipped look-up ----
assert.match(renderer, /const guardStoppedWrite = guardSkip && isMutation;/, 'mutation blocks are distinguished');
assert.match(renderer, /guardStoppedWrite \? 'Blocked'/, 'a prevented change is titled "Blocked"');
assert.match(renderer, /full rewrite prevented — targeted edit required/, 'the card states the reason and the way out');
// The card names the guard's OWN reason instead of guessing it from the tool name —
// a duplicate write and a prevented rewrite are different things to the user.
assert.match(renderer, /const guardReasonLabels = \{/, 'guard reasons are declared, not inferred');
assert.match(renderer, /toolResult && toolResult\._guardReason/, 'the reason travels on the event');
const declaredReasons = Object.keys(JSON.parse(`{${renderer
  .slice(renderer.indexOf('const guardReasonLabels = {') + 27, renderer.indexOf('};', renderer.indexOf('const guardReasonLabels = {')))
  .replace(/(\w+):/g, '"$1":').replace(/'([^']*)'/g, (m, v) => JSON.stringify(v)).replace(/,\s*$/, '')}}`));
const usedReasons = [...loop.matchAll(/_guardReason: '([a-z_]+)'/g)].map((m) => m[1]);
assert.ok(usedReasons.length >= 8, `every guard declares a reason (got ${usedReasons.length})`);
usedReasons.forEach((r) => assert.ok(declaredReasons.includes(r), `guard reason "${r}" has no label in the renderer`));

// ---- 3. Deadlock escape ----
assert.match(loop, /const consecutiveGuardBlocksForPath = \(path\) => \{/, 'consecutive per-path blocks are counted');
assert.match(loop, /const breakGuardDeadlock = async \(deadlockedDecision, path, step\) => \{/, 'the escape hatch exists');
assert.match(loop, /consecutiveGuardBlocksForPath\(stuckPath\) >= 2/, 'two consecutive blocks trigger the escape');
assert.match(loop, /_deadlockBreak/, 'the escape is marked so it runs at most once per path');
// It must serve the REAL file, not a remembered copy — the model was told to edit truth.
const escape = loop.slice(loop.indexOf('const breakGuardDeadlock ='), loop.indexOf('const isMinorCrossFileIssue'));
assert.match(escape, /invokeWorkspaceAction\('workspaceReadFile'/, 'the escape reads current on-disk content');
assert.match(escape, /ok: true/, 'the served read is a real success, so the edit gate accepts it');
assert.doesNotMatch(escape, /tool: 'write_file'/, 'the escape opens an EDIT door, it does not rewrite anything');

// ---- 4. Guards block; they never substitute one tool for another on an existing file ----
const coercion = loop.slice(loop.indexOf('// Coerce raw edit_file payloads'), loop.indexOf("if (String(decision.tool || '').toLowerCase() !== 'new_project')"));
assert.match(coercion, /const alreadyWrittenThisRun = toolEvents\.some/, 'the coercion checks whether the file already exists');
assert.match(coercion, /&& !alreadyWrittenThisRun\) \{/, 'an existing file is never edit->write coerced');

// ---- 5. The contract check is visible and acts on what it finds ----
assert.match(loop, /title: 'Checked contracts'/, 'the contract check renders a card');
assert.match(loop, /const reconcileUndeclaredPackages = async \(issues, step\) => \{/, 'undeclared packages are reconciled deterministically');
const reconcile = loop.slice(loop.indexOf('const reconcileUndeclaredPackages'), loop.indexOf('const maybeRunContractCheck'));
assert.match(reconcile, /deps\.reconcilePackageJsonWithImports/, 'reconciliation reuses the pinned trusted table');
assert.doesNotMatch(reconcile, /npm install|run_command/, 'declaring a dependency must not install it');
assert.match(executor, /reconcilePackageJsonWithImports,\n {4}\};/, 'the executor exports the reconciler');
assert.match(aiExe, /reconcilePackageJsonWithImports,/, 'the reconciler is wired to the loop');
// Severity is phase-aware: mid-build, an import of a file a later phase owns is the plan
// working, not a defect — it must not be reported red on a phase going exactly to plan.
assert.match(loop, /const isFinalPhase = !phaseState \|\| phaseState\.activeIndex >= phaseState\.phases\.length - 1;/,
  'the loop knows whether anything is left to build');
assert.match(loop, /deferPlannedImports: !isFinalPhase/, 'planned imports are deferred until the final phase');
assert.match(loop, /plannedFiles,/, 'the plan\'s file list reaches the checker');
assert.match(loop, /later phases will add — on track, nothing to fix/, 'deferred imports read as on-track, not as a problem');
// A merged validate group must name the contract check it swallowed.
assert.match(renderer, /has\('Checked contracts'\)\) parts\.push\('contracts'\)/,
  'the group header names the contract check instead of hiding it under "Checked files"');

// `step` is the for-loop counter; pre-loop helpers must take it as a parameter or their
// debug traces throw a ReferenceError that the surrounding catch silently swallows.
const preLoop = loop.slice(0, loop.indexOf('for (let step = 1; step <= executionStepLimit'));
['maybeRunContractCheck', 'reconcileUndeclaredPackages', 'breakGuardDeadlock'].forEach((name) => {
  const start = preLoop.indexOf(`const ${name} = async (`);
  assert.notEqual(start, -1, `${name} is defined before the step loop`);
  const signature = preLoop.slice(start, preLoop.indexOf('=> {', start));
  assert.match(signature, /\bstep\b/, `${name} must receive step, not close over the loop counter`);
});

// ---- 6. The collector answers "does this file exist" with more than JS/TS ----
const collector = aiExe.slice(aiExe.indexOf('async function collectWorkspaceSourceFiles'), aiExe.indexOf('function getWorkspaceContext'));
assert.match(collector, /const ASSET = /, 'non-module files are collected for existence checks');
assert.match(collector, /return \{ files, assetPaths, truncated \}/, 'the two sets and the truncation flag are reported');
assert.match(collector, /assetPaths\.push/, 'assets are recorded by path');
assert.doesNotMatch(collector.slice(collector.indexOf('} else if (ASSET.test(name))')), /workspaceReadFile/,
  'assets are never read — existence is the whole question');

// ---- 7. A phase cannot silently claim completeness over an open contract gap ----
assert.match(loop, /const contractLimitationNote = \(\) => \{/, 'unresolved contract gaps are disclosed');
const note = loop.slice(loop.indexOf('const contractLimitationNote'), loop.indexOf('const completeActivePhase'));
assert.match(note, /openUndeclaredPackages/, 'the note is driven by real open findings');
assert.ok((loop.match(/contractLimitationNote\(\)/g) || []).length >= 3,
  'the disclosure reaches phase handoffs and the final message');

// ---- 8. Behavioural: the counter only counts an UNBROKEN run of blocks ----
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`
  const norm = (p) => '/' + String(p || '').replace(/^\\/+/, '');
  ${loop.slice(loop.indexOf('const consecutiveGuardBlocksForPath'), loop.indexOf('const breakGuardDeadlock'))
    .replace('const consecutiveGuardBlocksForPath = (path) => {', 'function consecutiveGuardBlocksForPath(path, toolEvents) {')
    .replace(/deps\.normalizeWorkspacePath/g, 'norm')
    .replace(/\};\s*$/, '}')}
  this.api = { consecutiveGuardBlocksForPath };
`, sandbox);
const { consecutiveGuardBlocksForPath: countBlocks } = sandbox.api;
const blocked = (p) => ({ tool: 'write_file', ok: false, _guardBlock: true, path: p });
assert.equal(countBlocks('/package.json', [blocked('/package.json'), blocked('/package.json')]), 2,
  'two consecutive blocks on one path are counted');
assert.equal(countBlocks('/package.json', [blocked('/package.json'), { tool: 'write_file', ok: true, path: '/package.json' }]), 0,
  'a successful write since resets the count — no escape hatch is needed');
assert.equal(countBlocks('/package.json', [blocked('/other.ts'), blocked('/other.ts')]), 0,
  'blocks on a different path do not count');

console.log('PASS: every guard block cards; blocked changes read as blocked; stacked guards always leave one legal move; contract checks are visible, act deterministically, and disclose what they could not fix');

// ---- v9.8.4: a guard skip must be recognised by its FLAG, not its prose ----
// Live: the batch-reread guard's text has no "blocked" in it, so it rendered as a red
// "Failed 2 files · already cached" — a guard skip reading as a real error.
assert.match(renderer, /const guardSkip = !notFound && \(Boolean\(toolResult && \(toolResult\._guardBlock \|\| toolResult\._guardReason\)\)/,
  'guard skips are detected from the structured flag');
assert.match(renderer, /\|\| \/\\bblocked\\b\/i\.test\(observation\)\)/, 'the prose test remains as a fallback');
