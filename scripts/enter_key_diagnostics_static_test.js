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

assert.match(aiExe, /function setupComposerKeyboardDiagnostics/);
assert.match(aiExe, /composer_keydown_capture_enter/);
assert.match(aiExe, /composer_beforeinput_linebreak/);
assert.match(aiExe, /composer_keyup_capture_enter/);
assert.match(aiExe, /function buildComposerKeyboardDiagnosticSnapshot/);
assert.match(aiExe, /activeIsMainInput/);
assert.match(aiExe, /targetIsMainInput/);
assert.match(aiExe, /mainInputConnected/);
assert.match(aiExe, /pendingInferenceCount/);

const keyFn = sliceBalancedFunction(aiExe, 'function handleKey');
assert.match(keyFn, /composer_handle_key_enter_start/);
assert.match(keyFn, /composer_handle_key_enter_send_button/);
assert.match(keyFn, /submitComposerMessage\(/);
assert.doesNotMatch(keyFn, /cancelActiveInference/, 'Enter must never stop a running op');

const sendButtonFn = sliceBalancedFunction(aiExe, 'function handleSendButtonClick');
assert.match(sendButtonFn, /composer_send_button_click/);
assert.match(sendButtonFn, /sendMessage\(\)/);

const sendFn = sliceBalancedFunction(aiExe, 'async function sendMessage');
assert.match(sendFn, /send_message_start_keyboard_state/);

const completeFn = sliceBalancedFunction(aiExe, 'function completeInferenceRequest');
assert.match(completeFn, /inference_complete_keyboard_state/);

assert.match(aiExe, /setupComposerKeyboardDiagnostics\(\)/);
assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: Enter key diagnostics capture document, inline handler, send, button, and completion state');
