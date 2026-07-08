const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const agentLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const aiNativeLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-ai-loop.js'), 'utf8');

assert.match(aiExe, /if \(dismissComposerPermission\(\)\) \{/);
assert.match(aiExe, /cancelActiveInference\(\)/);
assert.match(aiExe, /endInferenceRequest\(\)/);
assert.match(aiExe, /setThinkingStatus\(''\)/);
assert.match(aiExe, /clearTypingIndicator\(\)/);

assert.match(agentLoop, /toolResult && toolResult\.permissionRequired/);
assert.match(agentLoop, /Waiting for approval\./);
assert.match(agentLoop, /buildAgentActivityFromToolResult\(decision, toolResult, toolEvents\)/);
assert.match(agentLoop, /agent_command_permission_requested/);
assert.match(agentLoop, /forceNeedsContinue:\s*false/);

console.log('PASS: confirmation lifecycle clears cancel state and hard-stops ask-first command permission');

assert.match(aiNativeLoop, /result && result\.permissionRequired/);
assert.match(aiNativeLoop, /deps\.requestAgentCommandApproval\(chatId,/);
