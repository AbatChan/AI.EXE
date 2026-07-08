const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

function sliceFunction(name, max = 8000) {
  const start = aiExe.indexOf(name);
  assert.ok(start >= 0, `missing ${name}`);
  const nextFunction = aiExe.indexOf('\n\nfunction ', start + name.length);
  const nextAsync = aiExe.indexOf('\n\nasync function ', start + name.length);
  const ends = [nextFunction, nextAsync].filter((n) => n > start).sort((a, b) => a - b);
  const end = ends[0] || start + max;
  return aiExe.slice(start, Math.min(end, start + max));
}

const helperFn = sliceFunction('function requestTypingIndicatorAfterUserAppend');
assert.match(helperFn, /window\.setTimeout/);
assert.match(helperFn, /try\s*\{/);
assert.match(helperFn, /showTypingIndicator\(key, Date\.now\(\)\)/);
assert.match(helperFn, /typing_indicator_requested_after_user_append/);
assert.match(helperFn, /typing_indicator_after_user_append_failed/);

const sendFn = sliceFunction('async function sendMessage');
assert.match(sendFn, /appendMessageToChat\(chat\.id, 'user'/);
assert.match(sendFn, /if \(!operationRunning\) \{\s*requestTypingIndicatorAfterUserAppend\(chat\.id, 'sendMessage:user-appended'\);\s*\}/);

// Keep the rollback behavior: this patch must not reintroduce composer submit unification/focus.
assert.doesNotMatch(aiExe, /function submitComposerAction/);
assert.doesNotMatch(aiExe, /function focusComposerInputSoon/);
assert.doesNotMatch(aiExe, /submitComposerAction\('keyboard'\)/);
assert.doesNotMatch(aiExe, /submitComposerAction\('button'\)/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: immediate loader is requested asynchronously and cannot block sending');
