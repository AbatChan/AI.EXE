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

// Venice thread hygiene: internal calls reuse one stable AI.EXE scope, while Venice
// itself is Temporary-only and has no saved-thread mapping/sidebar machinery.
const adapter = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'venice_adapter_server.py'), 'utf8');
assert.match(aiExe, /return `internal:chat:\$\{String\(activeChatId \|\| 'shared'\)\}`/);
assert.doesNotMatch(aiExe, /internal:\$\{cleanScope\}:\$\{nowTs\(\)/);
assert.match(adapter, /def _aiexe_ensure_temporary_chat_mode/);
assert.match(adapter, /def _aiexe_start_fresh_temp_chat/);
assert.doesNotMatch(adapter, /AIEXE_CHAT_URLS/);
assert.doesNotMatch(adapter, /_aiexe_(rename|delete)_chat/);
assert.doesNotMatch(adapter, /sidebar_debug/);
assert.match(aiExe, /agentAdapterUploadedAttachmentIds\.delete\(String\(chatId \|\| ''\)\)/);

// Agent images upload ONCE per persistent scratch thread (dedup by chat +
// attachment id, released if the carrying call fails) — the old 3x-per-run
// cap re-piled the same image into the thread on every run.
assert.match(aiExe, /agentAdapterUploadedAttachmentIds/);
assert.match(aiExe, /function releaseAgentAdapterForwardedAttachments/);
assert.doesNotMatch(aiExe, /agentAdapterAttachmentsSentCount/);

// A decision that inlines a whole file overflows the structured-output cap —
// the loop must steer the model to a small decision shape, not kill the run.
const agentLoopSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const agentExecutorSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-executor.js'), 'utf8');
assert.match(aiExe, /outputLimitExceeded: true/);
assert.match(agentLoopSrc, /outputLimitNudges/);
assert.match(agentLoopSrc, /agent_decision_output_limit_recovered/);
// ...and the planner failure return must PROPAGATE the flag to the loop
// (it rebuilds the object — dropping the flag silently disabled the recovery).
assert.match(aiExe, /outputLimitExceeded: Boolean\(remote && remote\.outputLimitExceeded\)/);

// Continue is bound to the workspace created by this chat. A missing global/native
// root must restore that binding, never create a suffixed replacement project.
assert.match(aiExe, /agentWorkspace/);
assert.match(aiExe, /agent_resume_workspace_restored/);
assert.match(aiExe, /workspaceRestoreRoot/);
assert.match(agentLoopSrc, /isAgentResume: Boolean\(requestToken && requestToken\.isAgentResume\)/);
assert.match(agentLoopSrc, /syncWorkspaceStateFromNative\('new_project_created'/);
assert.match(agentExecutorSrc, /if \(runOptions\.isAgentResume\)/);
assert.match(agentExecutorSrc, /Continue must resume this chat/);
// Prevention lives in the decision prompt, template and fallback in sync.
const decisionMd = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompts', 'developer_agent_decision.md'), 'utf8');
const decisionRepairMd = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompts', 'developer_agent_decision_repair.md'), 'utf8');
['NEVER inline a whole file in `content`'].forEach((marker) => {
  assert.ok(decisionMd.includes(marker), 'decision md has the no-whole-file rule');
  assert.ok(decisionRepairMd.includes(marker), 'decision repair md has the no-whole-file rule');
  assert.ok(promptCore.includes(marker), 'prompt-core fallback has the no-whole-file rule');
});

// Model catalog: the picker renders only a curated slice, so the scraper must
// sweep the search box (full-catalog discovery) and persist the swept flag.
assert.match(adapter, /def _aiexe_sweep_models_by_search/);
assert.match(adapter, /"swept": bool\(AIEXE_LAST_SCRAPE_SWEPT\)/);
assert.doesNotMatch(adapter, /swept_cache_fresh|AIEXE_MODEL_CACHE_TTL|_aiexe_schedule_model_refresh/);
assert.match(adapter, /live launch discovery failed; reused cached catalog/);

console.log('PASS: planner calls are isolated, router-shaped plan JSON is rejected, Temporary Chat resets through SPA without history cleanup, and version is synced');
