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

const keyFn = sliceBalancedFunction(aiExe, 'function handleKey');
const buttonFn = sliceBalancedFunction(aiExe, 'function handleSendButtonClick');
const submitFn = sliceBalancedFunction(aiExe, 'function submitComposerMessage');

assert.match(keyFn, /submitComposerPermissionSelection\(\)/, 'permission approval Enter behavior must remain');
assert.match(keyFn, /submitComposerMessage\(/, 'normal Enter must delegate to the shared send path');
assert.match(keyFn, /composer_handle_key_enter_send_button|composer_enter_submit/, 'Enter path should be traceable');
assert.doesNotMatch(keyFn, /cancelActiveInference/, 'Enter must never stop a running op');
assert.doesNotMatch(keyFn, /sendMessage\(\)/, 'Enter must not bypass the shared send path');

// Enter = send-or-swallow. Stopping belongs ONLY to Esc and the stop-state button.
assert.match(submitFn, /pendingInferenceCount > 0 && isCurrentViewInferenceChat\(\)/, 'Enter is swallowed while this chat owns the running op');
assert.doesNotMatch(submitFn, /cancelActiveInference/, 'the Enter path must never cancel');
assert.match(submitFn, /sendMessage\(\)/, 'Enter still sends (or queues from other chats)');

assert.match(buttonFn, /cancelActiveInference\(\)/, 'send button still owns stop behavior');
assert.match(buttonFn, /sendMessage\(\)/, 'send button still owns send behavior');

// Do not reintroduce the failed unified/focus patch.
assert.doesNotMatch(aiExe, /function submitComposerAction/);
assert.doesNotMatch(aiExe, /function focusComposerInputSoon/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: Enter delegates to the shared send path; only Esc/stop button cancel a run');
