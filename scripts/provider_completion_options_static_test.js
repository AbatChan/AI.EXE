const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

function sliceFrom(name) {
  const start = aiExe.indexOf(name);
  assert.ok(start >= 0, `missing ${name}`);
  const end = aiExe.indexOf('\n\nasync function ', start + name.length);
  const altEnd = aiExe.indexOf('\n\nfunction ', start + name.length);
  const finalEnd = [end, altEnd].filter((n) => n > start).sort((a, b) => a - b)[0] || start + 6000;
  return aiExe.slice(start, finalEnd);
}

const streamFn = sliceFrom('async function streamOpenAiCompatibleChatCompletion');
assert.match(streamFn, /const controller = options\.abortController instanceof AbortController/);
assert.doesNotMatch(streamFn, /completionOptions\.abortController/);

const remoteFn = sliceFrom('async function requestRemoteTextCompletionForCapability');
assert.match(remoteFn, /const completionOptions = \{ \.\.\.\(options \|\| \{\}\) \}/);
assert.match(remoteFn, /completionOptions\.abortController\.signal/);
assert.doesNotMatch(remoteFn, /const abortSignal = options && completionOptions\.abortController/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: provider stream/completion option variables are scoped correctly');
