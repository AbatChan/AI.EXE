// OpenAI reasoning models count hidden reasoning in max_completion_tokens: a 60-token
// JSON decision came back empty on gpt-6-luna, so "use agent:" silently ran as chat.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const start = ui.indexOf('const OPENAI_MIN_COMPLETION_TOKENS');
const end = ui.indexOf('\n}\n', ui.indexOf('function adaptOpenAiRequest(', start)) + 2;
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${ui.slice(start, end)}; this.adapt = adaptOpenAiRequest;`, ctx);
const small = ctx.adapt('openai', { max_tokens: 60, temperature: 0 });
assert.equal(small.max_completion_tokens, 4096, 'small caps get the reasoning floor');
assert.equal(small.max_tokens, undefined);
assert.equal(small.temperature, undefined);
assert.equal(ctx.adapt('openai', { max_tokens: 16000 }).max_completion_tokens, 16000, 'large caps unchanged');
assert.deepEqual(ctx.adapt('deepseek', { max_tokens: 60 }), { max_tokens: 60 }, 'other providers untouched');
const tools = [{ type: 'function', function: { name: 'agent_step' } }];
assert.equal(ctx.adapt('openai', { model: 'gpt-6-luna', tools, max_tokens: 120 }).reasoning_effort, 'none', 'tools on a reasoning model: reasoning off (API 400 otherwise)');
assert.equal(ctx.adapt('openai', { model: 'gpt-6-luna', max_tokens: 120 }).reasoning_effort, undefined, 'no tools: model default');
assert.equal(ctx.adapt('openai', { model: 'gpt-4o', tools }).reasoning_effort, undefined, 'older models never get the param');
console.log('PASS: OpenAI small completion caps get a reasoning floor; tool calls on reasoning models set reasoning_effort none');

// A provider error after real work keeps the run (rows + reason) in the chat.
{
  const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
  assert.match(loop, /const endPausedRun = async \(text, rawReason\) => \{[\s\S]{0,200}if \(toolEvents\.some\(\(event\) => event && event\.ok\)\) \{\s+deps\.commitAssistantMessage\(chatId, text, text, \{\s+agentActivities,/);
  console.log('PASS: provider errors after work keep the run in the chat');
}

// Think mode reaches Agent calls; DeepSeek reasoning gets room.
{
  assert.match(ui, /\}, Boolean\(thinkActive\)\)\)\),/, 'agent requests no longer hard-code thinking off');
  assert.match(ui, /activeInferenceRequest\.operationKind === 'agent' && inferenceModes\(\)\.think/);
  const a = ui.indexOf('function applyThinkingMode(');
  const b = ui.indexOf('\n}\n', a) + 2;
  const c2 = {};
  vm.createContext(c2);
  vm.runInContext(`${ui.slice(a, b)}; this.apply = applyThinkingMode;`, c2);
  assert.equal(JSON.stringify(c2.apply('deepseek', { max_tokens: 120 }, true)), JSON.stringify({ max_tokens: 8192 + 32768, thinking: { type: 'enabled' } }));
  assert.equal(c2.apply('deepseek', { max_tokens: 16000 }, true).max_tokens, 16000 + 32768, 'file budget keeps its full size plus reasoning room');
  assert.equal(JSON.stringify(c2.apply('deepseek', { max_tokens: 120 }, false)), JSON.stringify({ max_tokens: 120, thinking: { type: 'disabled' } }));
  console.log('PASS: Think mode reaches Agent calls; DeepSeek thinking gets token room');
}

// Agent calls with thinking on must never carry the reasoning into files or decisions.
{
  const pick = (name) => { const a = ui.indexOf(`function ${name}(`); let d = 0; for (let i = ui.indexOf('{', ui.indexOf(')', a)); i < ui.length; i += 1) { if (ui[i] === '{') d += 1; else if (ui[i] === '}' && --d === 0) return ui.slice(a, i + 1); } return ''; };
  const c3 = {};
  vm.createContext(c3);
  let beats = 0;
  c3.markAgentToolProgress = () => { beats += 1; };
  vm.runInContext(`${pick('stripNativeThinking')}\n${pick('makeThinkingDeltaFilter')}; this.strip = stripNativeThinking; this.filter = makeThinkingDeltaFilter;`, c3);
  assert.equal(c3.strip('<native_thinking>plan it</native_thinking>const a = 1;'), 'const a = 1;');
  assert.equal(c3.strip('<native_thinking>cut off mid-thought'), '');
  const seen = [];
  const f = c3.filter((t) => seen.push(t));
  ['<native_thin', 'king>reasoning ', 'more</native_thinking>body{', ' color: red; }'].forEach((c) => f(c));
  // A tag split across chunks passes through as text only if it never completes; here it completes.
  assert.equal(seen.join('').includes('reasoning'), false, 'reasoning never reaches the live file preview');
  assert.match(seen.join(''), /body\{ color: red; \}$/);
  assert.equal(beats, 4, 'every chunk, reasoning included, counts as progress');
  assert.match(ui, /if \(result && agentThink\) result\.output = stripNativeThinking\(result\.output\);/);
  console.log('PASS: agent thinking is stripped from streamed files and decisions');
}

// A stalled step may be retried; the duplicate-failure guard no longer blocks it.
{
  const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
  assert.match(loop, /toolTimedOut: Boolean\(toolResult && toolResult\._toolTimedOut\),/);
  assert.match(loop, /if \(lastEvent\.toolTimedOut\) return '';/);
  console.log('PASS: a stalled write can be retried once');
}

// Paused runs speak plainly: what's written, why it paused, what next — no canned "provider said".
{
  const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
  assert.doesNotMatch(loop, /I started the workspace changes, but the agent/);
  assert.doesNotMatch(loop, /The provider said:/);
  const helper = loop.slice(loop.indexOf('const pausedRunText = (why) => {'), loop.indexOf('// Work already happened: keep it in the chat; otherwise'));
  const ctx = {};
  vm.createContext(ctx);
  const make = (events) => vm.runInContext(`(() => { const toolEvents = ${JSON.stringify(events)}; ${helper}; return pausedRunText; })()`, ctx);
  const w = (p) => ({ tool: 'write_file', ok: true, path: p });
  assert.equal(make([w('/index.html'), w('/css/style.css'), w('/js/formula.js'), w('/js/app.js')])('the model took too long.'),
    "I've written index.html, style.css, formula.js and app.js, but the model took too long.");
  assert.equal(make([w('/a.js')])('x.'), "I've written a.js, but x.");
  assert.equal(make([])('x.'), 'I got started, but x.');
  assert.match(ui, /isVeniceAdapterSelected\(\) \|\| Boolean\(inferenceModes\(\)\.think\) \? AGENT_STEP_TIMEOUT_ADAPTER_MS/);
  console.log('PASS: paused runs say what was written and what to do next; Think gets the long step limit');
}
