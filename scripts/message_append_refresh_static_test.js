const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

assert.match(aiExe, /function safePostMessageRefresh/);
assert.match(aiExe, /post_message_refresh_step_failed/);
assert.match(aiExe, /safePostMessageRefresh\(chatId, `append:\$\{role\}`\)/);

const appendStart = aiExe.indexOf('function appendMessageToChat');
const appendEnd = aiExe.indexOf('\n\nfunction ', appendStart + 1);
const appendFn = aiExe.slice(appendStart, appendEnd);
assert.doesNotMatch(appendFn, /renderHistory\(\);\s*renderSidebarCounts\(\);\s*updateContinueButtonVisibility\(\);/);

const emitStart = aiExe.indexOf('function emitLocalAssistantMessage');
const emitEnd = aiExe.indexOf('\n\nfunction ', emitStart + 1);
const emitFn = aiExe.slice(emitStart, emitEnd);
assert.match(emitFn, /local_command_user_append_failed/);
assert.match(emitFn, /local_command_assistant_append_failed/);
assert.match(emitFn, /appendMessageToChat\(chat\.id, 'ai', assistantText\)/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: message append refresh is guarded so render errors cannot abort assistant append or send flow');
