// Every chat action card maps to the right autopilot request and "no change" state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
function grab(name) {
  const start = src.indexOf(name);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}
const risks = src.slice(src.indexOf('const AUTOPILOT_RISKS'), src.indexOf(';', src.indexOf('const AUTOPILOT_RISKS')) + 1);
const chatCardMoney = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
const chatCardSigned = (c) => `${Number(c) >= 0 ? '+' : '-'}${chatCardMoney(Math.abs(Number(c)))}`;
// eslint-disable-next-line no-eval
const describe = eval(`(() => { ${risks}; return ${grab('function describeAutopilotAction')}; })()`);

const idle = { running: false, risk: 'careful', budget_cents: 100000, equity_cents: 100148, cash_cents: 100148, positions: [], pinned: [], watchlist: [{ symbol: 'SOL' }] };
const live = { ...idle, running: true, positions: [{ symbol: 'ARB', pnl_cents: 359 }], pinned: ['DOGE'], cash_cents: 90000 };
const plan = (verb, parts, state) => describe(verb, parts, state);

assert.deepEqual(plan('watch', ['sol'], live).call, { path: 'watch', body: { symbol: 'SOL', watch: true } });
assert.match(plan('watch', ['SOL'], live).detail, /already scanned/i);
assert.equal(plan('watch', ['DOGE'], live).done, 'Already pinned');
assert.deepEqual(plan('unwatch', ['doge'], live).call, { path: 'watch', body: { symbol: 'DOGE', watch: false } });
assert.equal(plan('unwatch', ['XRP'], live).done, 'Not pinned');
assert.deepEqual(plan('buy', ['eth'], live).call, { path: 'buy', body: { symbol: 'ETH' } });
assert.equal(plan('buy', ['ARB'], live).done, 'Already holding ARB');
assert.equal(plan('buy', ['ETH'], { ...idle, budget_cents: 0 }).done, 'Start the autopilot first');
assert.deepEqual(plan('sell', ['arb'], live).call, { path: 'sell', body: { symbol: 'ARB' } });
assert.equal(plan('sell', ['SOL'], live).done, 'Not holding SOL');
assert.deepEqual(plan('sell-all', [], live).call, { path: 'stop', body: { close_positions: true } });
assert.deepEqual(plan('start', ['2000', 'balanced'], idle).call, { path: 'start', body: { budget_cents: 200000, risk: 'balanced' } });
assert.deepEqual(plan('start', ['$1,500'], idle).call.body, { budget_cents: 150000, risk: 'careful' });
assert.equal(plan('start', [], live).done, 'Already running');
assert.deepEqual(plan('stop', [], live).call, { path: 'stop', body: { close_positions: false } });
assert.equal(plan('stop', [], idle).done, 'Already off');
assert.deepEqual(plan('risk', ['BOLD'], live).call, { path: 'risk', body: { risk: 'bold' } });
assert.equal(plan('risk', ['careful'], live).done, 'Already Careful');
assert.equal(plan('risk', ['yolo'], live).done, 'Unknown risk level');
assert.deepEqual(plan('clear', [], live).call, { path: 'clear-activity', body: {} });
assert.equal(plan('reset', [], live).done, 'Pause it first');
assert.equal(plan('reset', [], { ...idle, positions: [{ symbol: 'ARB' }] }).done, 'Sell open trades first');
assert.deepEqual(plan('reset', [], idle).call, { path: 'reset', body: {} });
assert.equal(plan('launch-rocket', [], live), null);
console.log('PASS: all 10 action verbs map to the right request and no-change states');

assert.match(src, /const seenActions = new Set\(\);[\s\S]{0,400}container\.querySelectorAll\('p, li'\)/, 'dedupe is per render pass');
assert.match(src, /if \(seenActions\.has\(key\)\) return;/);
assert.match(src, /Write each action card at most once per reply/);
assert.match(src, /cannot add to a coin already held/);
assert.match(src, /each card updates live and becomes ready once the step before it is applied/);
assert.match(src, /Pinned coins: \$\{\(snap\.pinned \|\| \[\]\)\.join\(', '\) \|\| 'none'\}/);
console.log('PASS: one card per action per message; every verb explained to the model; pinned state always stated');
assert.match(src, /JSON\.stringify\(\{ at: new Date\(\)\.toISOString\(\), detail: plan\.detail \|\| '' \}\)/, 'applied card keeps its detail');
assert.match(src, /showTypingIndicator\(chatId, replyStartedAt\)/, 'refusal check continues the same timer');
console.log('PASS: applied cards keep their text (no layout shift); refusal check keeps one timer');
