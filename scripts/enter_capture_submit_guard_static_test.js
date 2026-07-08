const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

function sliceBalancedFunction(source, name) {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace > start, `missing opening brace for ${name}`);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`missing closing brace for ${name}`);
}

const shouldFn = sliceBalancedFunction(aiExe, 'function shouldComposerEnterCaptureSubmit');
const setupFn = sliceBalancedFunction(aiExe, 'function setupComposerEnterCaptureSubmitGuard');

assert.match(shouldFn, /evt\.key !== 'Enter'/);
assert.match(shouldFn, /evt\.shiftKey/);
assert.match(shouldFn, /evt\.isComposing/);
assert.match(shouldFn, /document\.getElementById\('mainInput'\)/);
assert.match(shouldFn, /target === liveInput \|\| active === liveInput/);
assert.match(shouldFn, /getActiveComposerPermissionRequest/);

assert.match(setupFn, /document\.addEventListener\('keydown'/);
assert.match(setupFn, /true\)/, 'listener must run in capture phase');
assert.match(setupFn, /evt\.preventDefault\(\)/);
assert.match(setupFn, /evt\.stopPropagation\(\)/);
assert.match(setupFn, /stopImmediatePropagation/);
assert.match(setupFn, /composer_enter_capture_submit_guard/);
assert.match(setupFn, /submitComposerMessage\(/, 'capture guard delegates to the send-only path');
assert.doesNotMatch(setupFn, /handleSendButtonClick\(\)/, 'capture guard must not reach the cancel-capable button handler');

assert.match(aiExe, /setupComposerKeyboardDiagnostics\(\);\s*setupComposerEnterCaptureSubmitGuard\(\);/);

const keyFn = sliceBalancedFunction(aiExe, 'function handleKey');
assert.match(keyFn, /submitComposerMessage\(/, 'existing inline handler should still delegate to the send-only path');

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: Enter capture guard prevents textarea newline and delegates to the send-only path');
