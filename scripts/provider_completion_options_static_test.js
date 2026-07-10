const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const backendModels = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'models.py'), 'utf8');
const backendUsage = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'routers', 'usage.py'), 'utf8');
const adapterServer = fs.readFileSync(path.join(__dirname, '..', 'backend', 'app', 'venice_adapter_server.py'), 'utf8');
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

assert.match(backendModels, /structured_output: bool = False/);
assert.match(backendModels, /max_output_chars: int = 0/);
assert.match(backendUsage, /body\["aiexe_structured_output"\] = True/);
assert.match(adapterServer, /AIEXE_STRUCTURED output exceeded/);
assert.match(adapterServer, /structured output limit/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: provider options, adapter isolation/cancellation, and structured-output bounds are wired correctly');
