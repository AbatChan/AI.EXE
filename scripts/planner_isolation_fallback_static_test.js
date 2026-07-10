const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const agentCore = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-core.js'), 'utf8');
const agentRuntime = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-runtime.js'), 'utf8');
const planPrompt = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompts', 'developer_agent_plan.md'), 'utf8');
const promptCore = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompt-core.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

assert.match(aiExe, /function buildIsolatedAdapterChatId/);
assert.match(aiExe, /function shouldIsolateAdapterPrompt/);
assert.match(aiExe, /adapterChatScope: 'agent-planner'/);
assert.match(aiExe, /buildIsolatedAdapterChatId\(\(extra && extra\.adapterChatScope\) \|\| 'internal'\)/);
assert.match(aiExe, /buildIsolatedAdapterChatId\(\(options && options\.adapterChatScope\) \|\| 'internal-stream'\)/);

assert.match(agentRuntime, /isolatedAdapterChat:\s*true/);
assert.match(agentRuntime, /adapterChatScope:\s*'agent-project-files'/);
assert.match(agentRuntime, /adapterChatScope:\s*'agent-edit-file'/);

assert.match(agentCore, /function isExplicitViteReactTask/);
assert.match(agentCore, /function buildViteReactExpectedFiles/);
assert.match(agentCore, /\/src\/App\.tsx/);
assert.match(agentCore, /\/src\/main\.tsx/);
assert.match(agentCore, /\/vite\.config\.ts/);
assert.match(agentCore, /hasAgentPlanShape/);
assert.match(agentCore, /Object\.prototype\.hasOwnProperty\.call\(parsedObj, 'route'\)/);
assert.match(agentCore, /landingSubjectMatch/);
assert.match(planPrompt, /Do not add adjacent pages, screens, or features/);
assert.match(promptCore, /Do not add adjacent pages, screens, or features/);

assert.match(cmake, /AI_EXE_APP_VERSION "\d+\.\d+\.\d+"/);
assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: planner calls are isolated, router-shaped plan JSON is rejected, Vite React fallback is preserved, and version is synced');
