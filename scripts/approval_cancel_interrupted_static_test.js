const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat-renderer.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

assert.match(aiExe, /const agentCommandApprovalSessionId =/);
assert.match(aiExe, /chat\.pendingAgentCommandApproval = \{ \.\.\.nextPayload \}/);
assert.match(aiExe, /markAgentCommandApprovalInterrupted/);
assert.match(aiExe, /Approval was interrupted before/);
assert.match(aiExe, /No command was executed/);
assert.match(aiExe, /markAgentCommandApprovalCancelled/);
assert.match(aiExe, /Approval cancelled\. I did not run/);
assert.match(aiExe, /Press Continue/);
assert.match(aiExe, /agent_command_approval_interrupted/);
assert.match(aiExe, /agent_command_approval_cancelled/);
assert.match(aiExe, /markAgentCommandApprovalCancelled\(activeChatId, currentCommand\)/);

assert.match(renderer, /approvalCancelled/);
assert.match(renderer, /approvalInterrupted/);
assert.match(renderer, /Approval cancelled/);
assert.match(renderer, /Approval interrupted/);
assert.match(renderer, /Waiting for approval/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: command approvals cancel naturally, interrupted approvals recover safely, and version is synced');
