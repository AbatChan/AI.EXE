const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const listener = source.slice(source.indexOf("document.addEventListener('click', (evt) => {"));

assert.match(listener, /closest\('a\[href\]'\)/, 'chat click handler recognizes rendered links');
assert.match(listener, /openExternalUrl\(externalLink\.href\)/, 'chat links use the native external-browser bridge');

console.log('PASS: external chat links open through the native bridge.');
