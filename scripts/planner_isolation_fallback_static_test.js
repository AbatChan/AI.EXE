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

// Venice thread hygiene: internal calls REUSE one stable scratch thread per chat
// (no per-call timestamp/random ids → no sidebar flood, no delete sweeps), the
// adapter never renames internal threads, renames get ONE attempt (no Chrome
// restore/park retry loop), and cleanup never deletes the stable scratch threads.
const adapter = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'venice_adapter_server.py'), 'utf8');
assert.match(aiExe, /return `internal:chat:\$\{String\(activeChatId \|\| 'shared'\)\}`/);
assert.doesNotMatch(aiExe, /internal:\$\{cleanScope\}:\$\{nowTs\(\)/);
assert.match(adapter, /not _chat_key\.startswith\("id:internal:"\)/);
assert.match(adapter, /key\.startswith\("id:internal:"\)/);
assert.match(adapter, /not k\.startswith\("id:internal:chat:"\)/);

// Agent images upload ONCE per persistent scratch thread (dedup by chat +
// attachment id, released if the carrying call fails) — the old 3x-per-run
// cap re-piled the same image into the thread on every run.
assert.match(aiExe, /agentAdapterUploadedAttachmentIds/);
assert.match(aiExe, /function releaseAgentAdapterForwardedAttachments/);
assert.doesNotMatch(aiExe, /agentAdapterAttachmentsSentCount/);

// Model catalog: the picker renders only a curated slice, so the scraper must
// sweep the search box (full-catalog discovery) and persist the swept flag.
assert.match(adapter, /def _aiexe_sweep_models_by_search/);
assert.match(adapter, /"swept": bool\(AIEXE_LAST_SCRAPE_SWEPT\)/);
assert.match(adapter, /swept_cache_fresh/);

console.log('PASS: planner calls are isolated, router-shaped plan JSON is rejected, Vite React fallback is preserved, Venice scratch threads are stable per chat, and version is synced');
