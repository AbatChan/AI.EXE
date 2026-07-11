const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const macHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui_main_mac_web.mm'), 'utf8');
const agentLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');

assert.match(aiExe, /function flushNativeUiStorageBackup\(\)/, 'native state can be flushed immediately');
assert.match(aiExe, /saveChats\(\);\s*void flushNativeUiStorageBackup\(\);\s*saveArtifacts\(\);/, 'chat deletion flushes its new state before reload');
assert.doesNotMatch(macHost, /oldChats\.concat\(newChats\)/, 'native restore never unions deleted chats back in');
assert.match(agentLoop, /const shouldSummarizeReadOnlyRun = \(\) => agentHasUsefulInspectionEvidence\(\)\s*&& isVerificationOnlyTask\(\);/, 'ordinary edit runs cannot auto-finish after only inspection');

console.log('PASS: chat deletion is authoritative and edit runs require a mutation.');
