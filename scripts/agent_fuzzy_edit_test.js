// Unit tests for the layered fuzzy anchor matcher in applyAgentEditProgram
// (agent-core.js). A weak model often produces an anchor that is correct in
// substance but wrong in whitespace/indentation or off by a stray character.
// The matcher resolves those near-misses (exact -> whitespace-normalized line
// block -> similarity >= 0.9) so the edit lands, instead of returning
// "no edits were applied". These tests pin the three tiers AND the safety
// boundary: a genuinely-absent anchor must still be rejected (never guess).
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));

const core = global.AIExeAgentCore.createAgentCore({});
const { applyAgentEditProgram } = core;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`PASS: ${name}`);
  passed += 1;
}

const CSS = [
  '#search-clear {',
  '    position: absolute;',
  '    width: 40px;',
  '    height: 40px;',
  '}',
  '',
  '.movie-card {',
  '    border-radius: 4px;',
  '}',
].join('\n');

// Tier 1: exact anchor still works and is NOT counted as fuzzy.
{
  const r = applyAgentEditProgram(CSS, {
    edits: [{ op: 'replace', find: '    width: 40px;', replace: '    width: 16px;' }],
  });
  ok('exact replace applies', r.appliedCount === 1 && r.output.includes('width: 16px;'));
  ok('exact replace not flagged fuzzy', r.fuzzyCount === 0);
}

// Tier 2: whitespace-normalized block match. Model indented with the wrong
// amount and used a tab — exact includes() would miss; the block still matches.
{
  const r = applyAgentEditProgram(CSS, {
    edits: [{
      op: 'replace',
      // Contiguous block, but every line indented with the wrong whitespace
      // (a tab, then 2 spaces, then 3 spaces) — exact includes() would miss it.
      find: '#search-clear {\n\tposition: absolute;\n  width: 40px;\n   height: 40px;\n}',
      replace: '#search-clear {\n    position: absolute;\n    width: 16px;\n    height: 16px;\n}',
    }],
  });
  ok('whitespace-tolerant block replaces', r.appliedCount === 1 && r.fuzzyCount === 1
    && r.output.includes('width: 16px;') && r.output.includes('height: 16px;'));
  // The original oversized lines are gone and the absolute/positioning line survives.
  ok('whitespace block preserves surrounding lines', r.output.includes('position: absolute;')
    && !r.output.includes('width: 40px;'));
}

// Tier 3: a single stray character in the anchor (>=0.9 similar) still resolves.
{
  const r = applyAgentEditProgram(CSS, {
    edits: [{ op: 'replace', find: '.movie-cards {', replace: '.movie-card {\n    box-shadow: 0 2px 8px rgba(0,0,0,.1);' }],
  });
  ok('near-miss anchor resolves via similarity', r.appliedCount === 1 && r.fuzzyCount === 1
    && r.output.includes('box-shadow'));
}

// Safety: a genuinely-absent anchor must NOT match anything (no false splice).
{
  const r = applyAgentEditProgram(CSS, {
    edits: [{ op: 'replace', find: '.totally-unrelated-selector-xyz { color: red; }', replace: 'WRECKED' }],
  });
  ok('absent anchor is rejected', r.appliedCount === 0 && r.output === CSS && !r.output.includes('WRECKED'));
}

// insert_after resolves its anchor fuzzily too.
{
  const r = applyAgentEditProgram(CSS, {
    edits: [{ op: 'insert_after', find: '.movie-card {', text: '\n    cursor: pointer;' }],
  });
  ok('insert_after applies on exact anchor', r.appliedCount === 1 && r.output.includes('cursor: pointer;'));
}

// replace_all stays exact when the literal is present (global, multi-hit).
{
  const src = 'a 40px b\nc 40px d';
  const r = applyAgentEditProgram(src, { edits: [{ op: 'replace_all', find: '40px', replace: '16px' }] });
  ok('replace_all replaces every literal hit', r.appliedCount === 1
    && r.output === 'a 16px b\nc 16px d' && r.fuzzyCount === 0);
}

console.log(`\n${passed} passed`);
