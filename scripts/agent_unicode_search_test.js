// Regression: a model emitted a 30KB pipe-delimited emoji inventory. The old
// ASCII-only needle builder reduced it to the identifier "emoji", so literal
// icons in JSX were invisible and the model repeated the same search.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));

const executor = global.AIExeAgentExecutor.createAgentExecutor({
  normalizeWorkspacePath: (value) => String(value || ''),
});
const { buildSearchNeedles, lineMatchesNeedle } = executor;

const runaway = `emoji|${'😀|💖|🚀|✨|'.repeat(3000)}`;
const needles = buildSearchNeedles(runaway);
assert.ok(needles.includes('__aiexe_any_emoji__'), 'emoji intent should add the Unicode sentinel');
assert.ok(needles.length <= 24, 'search needles remain bounded');
assert.ok(lineMatchesNeedle('const badge = "💖";', '__aiexe_any_emoji__'), 'literal emoji is found');
assert.ok(!lineMatchesNeedle('const badge = "heart";', '__aiexe_any_emoji__'), 'plain text is not a false emoji match');

const ordinary = buildSearchNeedles('renderProfileCard active state');
assert.ok(ordinary.includes('renderprofilecard'));
assert.ok(!ordinary.includes('__aiexe_any_emoji__'), 'ordinary searches keep their existing behavior');

console.log('PASS: Unicode emoji searches are literal-aware and runaway queries stay bounded');
