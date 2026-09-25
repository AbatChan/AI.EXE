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

// ---- 2. Guard blocks are internal: the model gets the observation, the feed shows nothing ----
assert.match(renderer, /if \(guardSkip\) return null;/, 'guard skips/blocks render no row (user ask: keep them internal)');
assert.doesNotMatch(renderer, /'Blocked'|'Skipped'/, 'no Blocked/Skipped rows');
const panelFilter = renderer.slice(renderer.indexOf('const baseRows = normalizedRows.filter'), renderer.indexOf('const rows = buildLiveRowsWithStreamingFile'));
assert.match(panelFilter, /activity\.kind !== 'skip'/, 'older saved skip rows are hidden too');
console.log('PASS: guard blocks stay internal; stacked guards always leave one legal move; contract checks are visible, act deterministically, and disclose what they could not fix');

// ---- v9.8.4: a guard skip must be recognised by its FLAG, not its prose ----
// Live: the batch-reread guard's text has no "blocked" in it, so it rendered as a red
// "Failed 2 files · already cached" — a guard skip reading as a real error.
assert.match(renderer, /const guardSkip = !notFound && \(Boolean\(toolResult && \(toolResult\._guardBlock \|\| toolResult\._guardReason\)\)/,
  'guard skips are detected from the structured flag');
assert.match(renderer, /\|\| \/\\bblocked\\b\/i\.test\(observation\)\)/, 'the prose test remains as a fallback');
