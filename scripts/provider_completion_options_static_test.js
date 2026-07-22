const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const backendModels = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'models.py'), 'utf8');
const backendUsage = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'routers', 'usage.py'), 'utf8');
const providerUsage = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'provider_usage.py'), 'utf8');
const adapterServer = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'venice_adapter_server.py'), 'utf8');
const agentLoop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const agentRuntime = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-runtime.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

function sliceFrom(name) {
  const start = aiExe.indexOf(name);
  assert.ok(start >= 0, `missing ${name}`);
  const end = aiExe.indexOf('\n\nasync function ', start + name.length);
  const altEnd = aiExe.indexOf('\n\nfunction ', start + name.length);
  const finalEnd = [end, altEnd].filter((n) => n > start).sort((a, b) => a - b)[0] || start + 6000;
  return aiExe.slice(start, finalEnd);
}

const streamFn = sliceFrom('async function streamOpenAiCompatibleChatCompletion');
assert.match(streamFn, /const controller = options\.abortController instanceof AbortController/);
assert.doesNotMatch(streamFn, /completionOptions\.abortController/);

const remoteFn = sliceFrom('async function requestRemoteTextCompletionForCapability');
assert.match(remoteFn, /const completionOptions = \{ \.\.\.\(options \|\| \{\}\) \}/);
assert.match(remoteFn, /completionOptions\.abortController\.signal/);
assert.doesNotMatch(remoteFn, /const abortSignal = options && completionOptions\.abortController/);
assert.match(remoteFn, /completionOptions\.isolatedAdapterChat \? \{ isolatedAdapterChat: true \}/);
assert.match(remoteFn, /completionOptions\.adapterChatScope \? \{ adapterChatScope: completionOptions\.adapterChatScope \}/);
assert.match(remoteFn, /completionOptions\.abortController instanceof AbortController \? \{ abortController: completionOptions\.abortController \}/);

const ollamaOneShot = sliceFrom('async function requestOllamaChatCompletion');
assert.match(ollamaOneShot, /signal: extra\.abortController instanceof AbortController \? extra\.abortController\.signal : undefined/);
assert.doesNotMatch(ollamaOneShot, /options\.maxOutputChars|options\.stopOnCompleteJson/);

const ollamaStream = sliceFrom('async function streamOllamaChatCompletion');
assert.match(ollamaStream, /stopOnCompleteJson/);
assert.match(ollamaStream, /maxOutputChars/);
assert.match(ollamaStream, /Adapter response exceeded the structured-output limit/);

const plannerFn = sliceFrom('async function requestAgentPlannerInferenceInner');
assert.match(plannerFn, /preferStreaming: true/);
assert.match(plannerFn, /stopOnCompleteJson: true/);
assert.match(plannerFn, /requestedPlannerTokens <= 1200/);
assert.match(plannerFn, /\? 3500/);
assert.match(plannerFn, /Math\.min\(24000/);

const selectedRemoteFn = sliceFrom('async function requestSelectedRemoteTextCompletion');
assert.match(selectedRemoteFn, /const owningChatId = String\(\(activeInferenceRequest && activeInferenceRequest\.chatId\)/);
assert.match(selectedRemoteFn, /owningChatId && !requestExtra\.isolatedAdapterChat/);
assert.match(selectedRemoteFn, /requestExtra\.adapterChatId = owningChatId/);
assert.doesNotMatch(selectedRemoteFn, /delete requestExtra\.isolatedAdapterChat/);

const preflightRouteFn = sliceFrom('async function requestPreflightRouteModelDecision');
assert.match(preflightRouteFn, /isolatedAdapterChat:\s*true/);
assert.match(preflightRouteFn, /adapterChatScope:\s*'preflight-router'/);

assert.match(backendModels, /structured_output: bool = False/);
assert.match(backendModels, /max_output_chars: int = 0/);
assert.match(backendUsage, /body\["aiexe_structured_output"\] = True/);
assert.match(adapterServer, /AIEXE_STRUCTURED output exceeded/);
assert.match(adapterServer, /structured output limit/);
assert.match(adapterServer, /"uncensored_models": sorted\(AIEXE_UNCENSORED_MODELS\)/);
assert.match(providerUsage, /out\["uncensored_models"\]/);
assert.match(backendModels, /uncensored_models: List\[str\]/);
assert.match(aiExe, /data-tier="uncensored"|isProviderModelUncensored/);
assert.match(adapterServer, /if not _aiexe_generation_running\(driver\):\s+_stable \+= 1/);
assert.match(adapterServer, /_aiexe_stop_generation\(driver, "stream boundary cleanup"\)/);
assert.match(adapterServer, /_rotate_slow = bool\(_chat_key and _chat_key in AIEXE_THREAD_SLOW\)/);
assert.match(agentRuntime, /isolatedAdapterChat:\s*true,\s*adapterChatScope:\s*'agent-file'/);
assert.match(agentRuntime, /runRawAgentFileInference\(continuationPrompt, null,/);
assert.doesNotMatch(adapterServer, /AIEXE_MODEL_CACHE_TTL|_aiexe_schedule_model_refresh/);
assert.doesNotMatch(aiExe, /setInterval\(refreshComposerModelsFromProvider/);
assert.match(agentLoop, /incompleteJsonNudges/);
assert.match(agentLoop, /agent_incomplete_json_recovered/);
assert.match(agentLoop, /Continue from the saved tool results/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: provider options, adapter isolation/cancellation, and structured-output bounds are wired correctly');
