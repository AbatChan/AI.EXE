// Real token usage: every provider's usage block normalises to one shape, the stream
// asks for usage, and the session tally exists before the token ring first renders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const src = ui.slice(ui.indexOf('function normalizeProviderUsage(raw) {'), ui.indexOf('function recordProviderUsage('));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.norm = normalizeProviderUsage;`, ctx);
const norm = (u) => JSON.parse(JSON.stringify(ctx.norm(u)));

// OpenAI chat completions (also Venice, Gemini OpenAI-compat).
assert.deepEqual(norm({ prompt_tokens: 15528, completion_tokens: 210, prompt_tokens_details: { cached_tokens: 8946 }, completion_tokens_details: { reasoning_tokens: 12 } }),
  { input: 15528, cached: 8946, cache_write: 0, output: 210, reasoning: 12 });
// Venice cache writes.
assert.equal(norm({ prompt_tokens: 5000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 4800 } }).cache_write, 4800);
// DeepSeek hit/miss fields.
assert.deepEqual(norm({ prompt_tokens: 9000, completion_tokens: 300, prompt_cache_hit_tokens: 8000, prompt_cache_miss_tokens: 1000 }),
  { input: 9000, cached: 8000, cache_write: 0, output: 300, reasoning: 0 });
// Anthropic: input_tokens excludes cache reads and writes.
assert.deepEqual(norm({ input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 600, output_tokens: 90 }),
  { input: 4650, cached: 4000, cache_write: 600, output: 90, reasoning: 0 });
// Garbage / empty.
assert.equal(ctx.norm(null), null);
assert.equal(ctx.norm({ prompt_tokens: 0, completion_tokens: 0 }), null);
assert.equal(norm({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } }).cached, 10, 'cached never exceeds input');

assert.match(ui, /if \(STREAM_USAGE_PROVIDERS\.has\(provider\)\) req\.stream_options = \{ include_usage: true \};/);
assert.match(ui, /if \(parsed && parsed\.usage && typeof parsed\.usage === 'object'\) streamUsage = parsed\.usage;/);
assert.match(ui, /usage: \(result && result\.usage\) \|\| null,/, 'raw log records real usage');
assert.ok(ui.indexOf('const providerUsageSession') < ui.indexOf('function updateTokenRing()'), 'no boot TDZ ReferenceError');
assert.match(ui, /cache_control: \{ type: 'ephemeral' \}/, 'Claude system prompt marked cacheable');
console.log('PASS: provider usage normalised for OpenAI/Venice/Gemini, DeepSeek, Anthropic');

// Cache-friendly decision prompt: fixed rules first; PLAN + TOOL_RESULTS next; the
// per-step lines (step counter, file tree, clock, pending, task, next action) last.
{
  const md = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompts', 'developer_agent_decision.md'), 'utf8');
  const at = (k) => md.indexOf(k);
  assert.ok(at('{{AGENT_ENVIRONMENT}}') < at('\nPLAN:\n'));
  assert.ok(at('\nPLAN:\n') < at('{{TOOL_RESULTS}}'), 'PLAN before tool results');
  assert.ok(at('{{TOOL_RESULTS}}') < at('Agent step: {{AGENT_STEP}}'), 'step counter after tool results');
  assert.ok(at('Agent step: {{AGENT_STEP}}') < at('{{AGENT_NOW}}') && at('{{AGENT_NOW}}') < at('{{TASK}}'), 'clock in the tail');
  assert.ok(at('{{TASK}}') < at('{{IMMEDIATE_NEXT_ACTION}}'), 'next action still last');
  const planner = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-planner.js'), 'utf8');
  assert.match(planner, /const splitMarker = '\\nPLAN:\\n';/, 'system prompt = fixed rules only');
  assert.match(ui, /const nowLine = kind === 'decision' \? '' :/, 'no minute clock in the cached environment block');
  console.log('PASS: decision prompt keeps its stable prefix first (cache-friendly)');
}

// GPT-6 cache control: explicit mode (no auto writes) on agent calls, one breakpoint on
// the step-decision system prompt, and a clean fallback if the endpoint rejects the fields.
{
  const pick = (name, end) => ui.slice(ui.indexOf(name), ui.indexOf(end, ui.indexOf(name)));
  const code = `${pick('function openAiExplicitCaching(', '// Claude caches only')}\nthis.api = { openAiExplicitCaching, applyOpenAiAgentCacheControl, stripOpenAiCacheControl, CACHE_FIELD_REJECTION };`;
  const c2 = {};
  vm.createContext(c2);
  vm.runInContext(code, c2);
  const { openAiExplicitCaching, applyOpenAiAgentCacheControl, stripOpenAiCacheControl, CACHE_FIELD_REJECTION } = c2.api;
  assert.equal(openAiExplicitCaching('openai', 'gpt-6-luna'), true);
  assert.equal(openAiExplicitCaching('openai', 'gpt-5.6-mini'), true);
  assert.equal(openAiExplicitCaching('openai', 'gpt-4o'), false, 'older models keep automatic caching');
  assert.equal(openAiExplicitCaching('deepseek', 'gpt-6-luna'), false);
  const step = applyOpenAiAgentCacheControl('openai', 'gpt-6-luna', { messages: [{ role: 'system', content: 'RULES' }, { role: 'user', content: 'x' }] }, { breakpointOnSystem: true });
  assert.deepEqual(JSON.parse(JSON.stringify(step)), {
    messages: [{ role: 'system', content: [{ type: 'text', text: 'RULES', prompt_cache_breakpoint: { mode: 'explicit' } }] }, { role: 'user', content: 'x' }],
    prompt_cache_options: { mode: 'explicit' },
  });
  const oneOff = applyOpenAiAgentCacheControl('openai', 'gpt-6-luna', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(JSON.stringify(oneOff.prompt_cache_options), '{"mode":"explicit"}', 'one-off calls write nothing');
  const back = stripOpenAiCacheControl(JSON.parse(JSON.stringify({ ...step, prompt_cache_key: 'k', stream_options: {} })));
  assert.deepEqual(JSON.parse(JSON.stringify(back)), { messages: [{ role: 'system', content: 'RULES' }, { role: 'user', content: 'x' }] }, 'fallback restores a plain request');
  assert.ok(CACHE_FIELD_REJECTION.test("Unrecognized request argument supplied: prompt_cache_options"));
  assert.match(ui, /agentCall: true,\n\s+\.\.\.\(completionOptions\.serviceTier \? \{ serviceTier: completionOptions\.serviceTier \} : \{\}\),\n\s+maxTokens: Math\.max\(1, Number\(maxTokens\) \|\| 64\),/, 'streamed agent calls are marked and carry the tier');
  console.log('PASS: GPT-6 agent calls use explicit cache mode; step system prompt is the one breakpoint');
}

// OpenAI Flex: labelled Agent/internal calls follow the setting, chat/router stay Standard,
// a Flex 429 retries once on Standard, the served tier is recorded, and spend prices tiers.
{
  const pick = (name, end) => ui.slice(ui.indexOf(name), ui.indexOf(end, ui.indexOf(name)));
  const c3 = { appSettings: { agentServiceTier: 'flex' } };
  vm.createContext(c3);
  vm.runInContext(`${pick('function openAiServiceTierFor(', '// Claude caches only')}\n${pick('function normalizeServiceTier(', 'function recordProviderUsage(')}\nthis.f = openAiServiceTierFor; this.nt = normalizeServiceTier;`, c3);
  assert.equal(c3.f('openai', 'step_decision'), 'flex');
  assert.equal(c3.f('openai', 'unlabeled'), '', 'the chat router stays Standard');
  assert.equal(c3.f('openai', ''), '', 'chat replies stay Standard');
  assert.equal(c3.f('deepseek', 'step_decision'), '', 'Flex is OpenAI-only');
  c3.appSettings.agentServiceTier = 'fast';
  assert.equal(c3.f('openai', 'step_decision'), 'priority', 'Fast mode uses the priority tier');
  c3.appSettings.agentServiceTier = 'standard';
  assert.equal(c3.f('openai', 'step_decision'), '');
  assert.equal(c3.nt('default'), 'standard'); assert.equal(c3.nt('flex'), 'flex'); assert.equal(c3.nt('priority'), 'fast'); assert.equal(c3.nt('x<y'), 'standard');
  assert.equal((ui.match(/if \(!response\.ok && response\.status === 429 && req\.service_tier === 'flex'\) \{\n\s+delete req\.service_tier;\n\s+response = await send\(\);/g) || []).length, 2, 'both OpenAI paths fall back from Flex once');
  assert.match(ui, /recordProviderUsage\(provider, model, streamUsage, usageChatId, streamServiceTier\)/);

  const rates = pick('const CREDIT_COST_RATES = {', 'const CREDIT_PRICE_URLS');
  const est = pick('const SERVICE_TIER_PRICE_FACTOR', 'function renderEstimatedProviderCost(');
  const c4 = {};
  vm.createContext(c4);
  vm.runInContext(`${rates}\n${est}\nthis.cost = estimateModelUsageCost; this.saved = estimateFlexSavings;`, c4);
  const M = 1000000;
  assert.equal(c4.cost('openai', 'gpt-6-luna', { input: M, output: M }, '2026-09').toFixed(4), '0.6000', 'untiered = Standard');
  const mixed = { input: 2 * M, output: 2 * M, tiers: { flex: { calls: 1, input: M, output: M }, standard: { calls: 1, input: M, output: M } } };
  assert.equal(c4.cost('openai', 'gpt-6-luna', mixed, '2026-09').toFixed(4), '0.9000', 'Flex half + Standard full');
  assert.equal(c4.saved('openai', 'gpt-6-luna', mixed).toFixed(4), '0.3000');
  const partlyOld = { input: 2 * M, output: 0, tiers: { flex: { calls: 1, input: M, output: 0 } } };
  assert.equal(c4.cost('openai', 'gpt-6-luna', partlyOld, '2026-09').toFixed(4), '0.1500', 'pre-tier calls priced as Standard');
  // Live prices (backend's daily list) win over the built-in table, with the tier's own rates.
  vm.runInContext("liveModelPrices = { openai: { 'gpt-6-luna': { input: .2, cached: .02, write: .25, output: 1, tiers: { flex: { input: .04, cached: .004, output: .2 } } } } };", c4);
  assert.equal(c4.cost('openai', 'gpt-6-luna', { input: M, output: M }, '2026-09').toFixed(4), '1.2000', 'live standard rate used');
  assert.equal(c4.cost('openai', 'gpt-6-luna', { input: M, output: M, tiers: { flex: { calls: 1, input: M, output: M } } }, '2026-09').toFixed(4), '0.2400', 'live flex rate used');
  assert.equal(c4.saved('openai', 'gpt-6-luna', { tiers: { flex: { calls: 1, input: M, output: M } } }).toFixed(4), '0.9600');
  vm.runInContext('liveModelPrices = null;', c4);
  assert.equal(c4.cost('openai', 'gpt-6-luna', { input: M, output: M }, '2026-09').toFixed(4), '0.6000', 'offline = built-in table');
  console.log('PASS: Flex tier routing, 429 fallback, served-tier recording and tier-aware spend');
}

{
  const ex = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-executor.js'), 'utf8');
  const list = ex.slice(ex.indexOf('const PY_STDLIB = new Set(`'), ex.indexOf('.split(', ex.indexOf('const PY_STDLIB = new Set(`')));
  ['__future__', 'zoneinfo', 'ast', 'decimal', 'unittest'].forEach((m) => assert.ok(new RegExp(`\\s${m}\\s`).test(` ${list.replace(/`/g, ' ')} `), `${m} is stdlib`));
  assert.match(ui, /title: chatTitle && chatTitle !== 'New Chat' \? chatTitle : 'Reply ready',/, 'finish toast is titled with the chat name');
  console.log('PASS: stdlib list covers __future__; finish toast uses the chat name; Fast mode tier');
}
