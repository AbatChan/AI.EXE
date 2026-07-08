const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

assert.match(aiExe, /function buildRuntimeStateSnapshot/);
assert.match(aiExe, /function resetStaleInferenceRuntime/);
assert.match(aiExe, /stale_inference_runtime_reset/);
assert.match(aiExe, /window_error/);
assert.match(aiExe, /window_unhandled_rejection/);
assert.match(aiExe, /:debug state/);
assert.match(aiExe, /:debug recover/);
assert.match(aiExe, /resetStaleInferenceRuntime\('sendMessage:start'\)/);
assert.match(aiExe, /send_request_failed/);
assert.match(aiExe, /chat_delete_refresh_step_failed/);
assert.doesNotMatch(aiExe, /The chat was removed, but the sidebar refresh hit a UI error/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);
console.log('PASS: stale send state recovery, debug state dump, runtime error monitor, and delete refresh guard are present');
