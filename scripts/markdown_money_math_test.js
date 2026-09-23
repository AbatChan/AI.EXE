// Dollar amounts in chat must stay text; real $…$ math must still render.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const win = { katex: { renderToString: (s) => `[MATH:${s}]` }, markdownit: () => ({ renderer: { rules: {} }, render: (t) => t }) };
vm.runInContext(fs.readFileSync('ui/markdown-renderer.js', 'utf8'),
  vm.createContext({ window: win, document: { createElement: () => ({}) }, console, navigator: {} }));
const r = win.AIExeMarkdownRenderer.createMarkdownRenderer({ escapeHtml: (s) => String(s) });
const isMath = (t) => /\[MATH:/.test(r.renderMarkdownHtml(t));

for (const money of ['balance at $999.80 — P&L flat at **$-0.20** (fees)', 'P&L flat at **-$0.10** so far',
  'AVAX at $-0.10 and ARB at $-0.10', 'costs $5 - $3 = $2']) assert.ok(!isMath(money), money);
for (const math of ['the formula $x^2 + y$ here', 'energy $E = mc^2$.']) assert.ok(isMath(math), math);
console.log('markdown money/math test: ok');
