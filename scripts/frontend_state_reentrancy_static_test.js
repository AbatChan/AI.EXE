const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

assert.match(aiExe, /const scheduledInterruptedAgentCommandApprovals = new Set\(\)/);
assert.match(aiExe, /function scheduleAgentCommandApprovalInterrupted/);
assert.match(aiExe, /Do not mutate chats\/render from a getter/);

const getter = aiExe.match(/function getPendingAgentCommandApproval\(chatId\) \{[\s\S]*?\n\}/)?.[0] || '';
assert.match(getter, /scheduleAgentCommandApprovalInterrupted\(key, persisted\)/);
assert.doesNotMatch(getter, /markAgentCommandApprovalInterrupted\(key, persisted\)/);

const deleteFn = aiExe.match(/function deleteChatFromModal\(\) \{[\s\S]*?\n\}/)?.[0] || '';
assert.match(deleteFn, /closeChatActionModal\(\);\s*saveChats\(\);/);
assert.match(deleteFn, /const refreshSteps = \[/);
assert.match(deleteFn, /\['renderArtifacts', \(\) => renderArtifacts\(\)\]/);
assert.match(deleteFn, /refreshSteps\.forEach/);
assert.match(deleteFn, /try \{\s*fn\(\);/);
assert.match(deleteFn, /chat_delete_refresh_step_failed/);
assert.doesNotMatch(aiExe, /The chat was removed, but the sidebar refresh hit a UI error/);
assert.match(deleteFn, /chat_delete_refresh_step_failed/);

const composerPermission = aiExe.match(/function getActiveComposerPermissionRequest\(\) \{[\s\S]*?const pending = getComposerPendingPreflightConfirmation/)?.[0] || '';
assert.match(composerPermission, /markAgentCommandApprovalCancelled\(activeChatId, currentCommand\)/);
assert.doesNotMatch(composerPermission, /cancelAgentCommandApproval\(activeChatId, currentCommand\)/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: frontend approval recovery is deferred, delete modal closes before rerender, and version is synced');
