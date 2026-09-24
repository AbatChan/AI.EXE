// Technical network errors shown to users must read as plain words.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const start = src.indexOf('function friendlyErrorText');
let depth = 0;
let end = src.indexOf('{', start);
for (; end < src.length; end += 1) {
  if (src[end] === '{') depth += 1;
  else if (src[end] === '}') { depth -= 1; if (!depth) break; }
}
// eslint-disable-next-line no-eval
const friendlyErrorText = eval(`(${src.slice(start, end + 1)})`);

const cases = [
  ['BAC: <urlopen error _ssl.c:1063: The handshake operation timed out>', 'BAC: the price service timed out'],
  ['ETH: ETH: <urlopen error _ssl.c:1063: The handshake operation timed out>', 'ETH: the price service timed out'],
  ['Network error calling provider: The read operation timed out', 'the AI provider timed out'],
  ['ZZZZ: <urlopen error [Errno 8] nodename nor servname provided, or not known>', 'ZZZZ: no internet connection'],
  ['HTTP Error 429: Too Many Requests', 'the price service is busy right now'],
  ['ETH, SOL: the price service timed out', 'ETH, SOL: the price service timed out'],
  ['Close open positions before changing the budget.', 'Close open positions before changing the budget.'],
];
for (const [input, want] of cases) assert.equal(friendlyErrorText(input), want, input);
for (const [input] of cases) assert.doesNotMatch(friendlyErrorText(input), /urlopen|_ssl|Errno|</);
assert.match(src, /friendlyErrorText\(session\.last_error\)/, 'daily-check notice must translate its error');
assert.match(src, /tone === 'error' \? friendlyErrorText\(detail\)/, 'error notes must translate their detail');
console.log('PASS: technical errors become plain words; normal messages are untouched');
