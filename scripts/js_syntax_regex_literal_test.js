// Syntax-issue scanner: regex literals aren't strings; only a cut-off tail says "append".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-executor.js'), 'utf8');
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(['lineColAt', 'jsRegexCanStart', 'jsRegexLiteralEnd', 'getJsSyntaxIssue', 'jsLooksCutOff'].map(fn).join('\n')
  + '\nthis.api = { getJsSyntaxIssue, jsLooksCutOff };', ctx);
const { getJsSyntaxIssue, jsLooksCutOff } = ctx.api;

// Valid code with quote/bracket chars inside regexes: no issue from the scanner.
const valid = "const esc = (s) => s.replace(/'/g, '&#39;').replace(/[{}()\\]]/g, '');\nconst r = x / 2 / 3;\nfunction f() { return /\"/.test(s); }\n";
assert.equal(getJsSyntaxIssue(valid, ''), '', 'regex literals are not strings or brackets');
assert.equal(jsLooksCutOff(valid), false);

// Complete IIFE, then stray code and a second close: mid-file error, not truncation.
const stray = "(function () {\n  const a = s.replace(/'/g, 'x');\n})();\n  function more() { return 1; }\n})();\n";
assert.match(getJsSyntaxIssue(stray, 'Parser error'), /near line 5/);
assert.equal(jsLooksCutOff(stray), false, 'complete file with a stray closer is not cut off');

// Real truncation still reads as cut off.
assert.equal(jsLooksCutOff("function a() {\n  const s = 'unfinished"), true);
assert.equal(jsLooksCutOff("function a() {\n  if (x) {\n    run();\n"), true);

// Division is still division.
assert.equal(getJsSyntaxIssue('const half = total / 2; const q = (a) / (b);\n', ''), '');

const executor = src;
assert.match(executor, /The file is complete; fix that spot with a targeted edit_file/);
console.log('PASS: regex literals scanned correctly; only a cut-off tail asks the model to append');
