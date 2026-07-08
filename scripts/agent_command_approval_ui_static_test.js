const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const agentLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const aiNativeLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-ai-loop.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.css'), 'utf8');

assert.match(aiExe, /const pendingAgentCommandApprovals = new Map\(\)/);
assert.match(aiExe, /function requestAgentCommandApproval\(chatId, payload = \{\}\)/);
assert.match(aiExe, /kind: 'agent_command_approval'/);
assert.match(aiExe, /mode: 'approve_command'/);
assert.match(aiExe, /mode: 'cancel_command'/);
assert.match(aiExe, /runApprovedAgentCommandOnce\(activeChatId, currentCommand\)/);
assert.match(aiExe, /markAgentCommandApprovalCancelled\(activeChatId, currentCommand\)/);
assert.match(aiExe, /consumedAgentCommandApprovals\.add\(agentCommandApprovalKey\(activeChatId, currentCommand\)\)/);
assert.match(aiExe, /requestAgentCommandApproval,/);

assert.match(agentLoop, /deps\.requestAgentCommandApproval\(chatId,/);
assert.match(aiNativeLoop, /result && result\.permissionRequired/);
assert.match(aiNativeLoop, /deps\.requestAgentCommandApproval\(chatId,/);

assert.match(css, /\.msg-agent-permission-actions\s*\{[\s\S]*display:\s*none/);

console.log('PASS: command approval uses shared composer confirmation UI with approve/cancel and one-time command execution');
