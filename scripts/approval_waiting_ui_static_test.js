const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const aiNativeLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-ai-loop.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat-renderer.js'), 'utf8');

assert.match(agentLoop, /toolResult && toolResult\.permissionRequired/);
assert.match(agentLoop, /waitingForApproval:\s*true/);
assert.match(agentLoop, /completedAt:\s*0/);
assert.doesNotMatch(
  agentLoop.match(/toolResult && toolResult\.permissionRequired[\s\S]*?return true;/)?.[0] || '',
  /completedAt:\s*Date\.now\(\)/
);

assert.match(aiNativeLoop, /result && result\.permissionRequired/);
assert.match(aiNativeLoop, /waitingForApproval:\s*true/);
assert.match(aiNativeLoop, /completedAt:\s*0/);

assert.match(renderer, /meta\.waitingForApproval === true/);
assert.match(renderer, /Waiting for approval/);
assert.match(renderer, /Final message/);
assert.match(renderer, /normalizedAgentMeta\.completedAt \|\| normalizedAgentMeta\.waitingForApproval/);

console.log('PASS: approval-required agent messages render as waiting for approval, not final completion');
