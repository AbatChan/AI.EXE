// run_app inlining must survive '$' in sources; check_code must parse before guessing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = (f) => fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
const app = ui('ai-exe.js');
const exec = ui('agent-executor.js');

// The bug: a string replacement expands $' into the rest of the page.
const page = '<body><script src="a.js"></script><p>after</p></body>';
const tag = '<script src="a.js"></script>';
const js = "return '$' + n.toFixed(2);";
assert.notEqual(page.replace(tag, `<script>${js}</script>`), `<body><script>${js}</script><p>after</p></body>`);
assert.equal(page.replace(tag, () => `<script>${js}</script>`), `<body><script>${js}</script><p>after</p></body>`);

assert.match(app, /html\.replace\(match\[0\], \(\) => `<script>/, 'script inlining must use a function replacement');
assert.match(app, /html\.replace\(match\[0\], \(\) => `<style>/, 'style inlining must use a function replacement');

// A word "export" in a comment must not skip the real parser.
assert.doesNotMatch(exec, /isPlainJs = [^\n]*\\b\(import\|export\)\\b/, 'plain-JS detection must not match prose');
assert.match(exec, /Only real module statements excuse a parse failure/);
console.log('PASS: inliner keeps $ literal; check_code parses first');
