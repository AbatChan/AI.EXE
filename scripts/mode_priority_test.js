const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'prompt-core.js'));

const repoRoot = path.join(__dirname, '..');
const aiExeJs = fs.readFileSync(path.join(repoRoot, 'ui', 'ai-exe.js'), 'utf8');

function createCore(chat, extraDeps = {}) {
  return global.AIExePromptCore.createPromptCore({
    findChatById: () => chat,
    currentAuthUser: () => ({ username: 'tester' }),
    normalizeUsername: (s) => String(s).toLowerCase(),
    isCanvasModeEnabled: () => false,
    isThinkModeEnabled: () => false,
    shouldInlineNameChatResponse: () => false,
    ...extraDeps,
  });
}

async function buildPrompt(chat, extraDeps = {}, options = {}) {
  const core = createCore(chat, extraDeps);
  return core.buildInferencePrompt(
    'chat_test',
    chat.messages[chat.messages.length - 1]?.text || '',
    options,
  );
}

function extractFunctionSource(source, fnName) {
  const start = source.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `missing function ${fnName}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${fnName}`);
}

const modeSource = extractFunctionSource(aiExeJs, 'inferReplyModeDeterministically');
const modeSandbox = {};
vm.createContext(modeSandbox);
vm.runInContext(`${modeSource}; this.inferReplyModeDeterministically = inferReplyModeDeterministically;`, modeSandbox);

function routeMode(text) {
  return modeSandbox.inferReplyModeDeterministically(text);
}

function assertOrder(prompt, earlier, later) {
  const a = prompt.indexOf(earlier);
  const b = prompt.indexOf(later);
  assert.ok(a >= 0, `missing marker: ${earlier}`);
  assert.ok(b >= 0, `missing marker: ${later}`);
  assert.ok(a < b, `expected "${earlier}" before "${later}"`);
}

async function testPromptCombinations() {
  const baseMessages = [
    { role: 'user', text: 'Create a launch plan for the app.' },
  ];

  const contextPrompt = await buildPrompt({
    messages: baseMessages,
    manualContext: 'Prefer concise sections.',
  });
  assert.ok(contextPrompt.includes('Priority order:'));
  assert.ok(contextPrompt.includes('USER CUSTOM INSTRUCTIONS FROM THE APP UI:'));
  assertOrder(contextPrompt, 'Priority order:', 'USER CUSTOM INSTRUCTIONS FROM THE APP UI:');
  assertOrder(contextPrompt, 'USER CUSTOM INSTRUCTIONS FROM THE APP UI:', '<|im_start|>user');

  const thinkPrompt = await buildPrompt({
    messages: baseMessages,
    thinkMode: true,
  });
  assert.ok(thinkPrompt.includes('THINK_MODE: ON'));
  assert.ok(thinkPrompt.includes('<thinking>...</thinking>'));

  const canvasPrompt = await buildPrompt({
    messages: baseMessages,
    canvasMode: true,
  });
  assert.ok(canvasPrompt.includes('CANVAS_MODE: ON'));
  assert.ok(canvasPrompt.includes('<AIcanvas title="..." type="text|code">'));
  assert.ok(canvasPrompt.includes('[respond using <AIcanvas'));

  const combinedPrompt = await buildPrompt({
    messages: baseMessages,
    canvasMode: true,
    thinkMode: true,
    manualContext: 'Use short sections.',
  });
  assert.ok(combinedPrompt.includes('CRITICAL FORMATTING ORDER FOR COMBINED UI MODES'));
  assert.ok(combinedPrompt.includes('THINK_MODE: ON'));
  assert.ok(combinedPrompt.includes('CANVAS_MODE: ON'));
  assertOrder(combinedPrompt, 'USER CUSTOM INSTRUCTIONS FROM THE APP UI:', 'UI MODE: Canvas mode is enabled');
  assertOrder(combinedPrompt, 'CRITICAL FORMATTING ORDER FOR COMBINED UI MODES', 'THINK_MODE: ON');
  assertOrder(combinedPrompt, 'THINK_MODE: ON', 'CANVAS_MODE: ON');

  const routedChatPrompt = await buildPrompt({
    messages: baseMessages,
    canvasMode: true,
  }, {}, { canvasModeOverride: false });
  assert.ok(routedChatPrompt.includes('routed to normal chat'));
  assert.ok(!routedChatPrompt.includes('CANVAS_MODE: ON'));
  assert.ok(!routedChatPrompt.includes('[respond using <AIcanvas'));
}

function testDeterministicCanvasRouting() {
  const canvasCases = [
    'write a detailed project proposal',
    'create a landing page',
    'build a calculator app',
    'generate a checklist template',
    'draft an email',
  ];
  const chatCases = [
    'thanks',
    'yes that works',
    'explain why that happened',
    'how do I run this',
    'can you summarize this',
    'what is the difference',
  ];

  canvasCases.forEach((text) => assert.equal(routeMode(text), 'canvas', text));
  chatCases.forEach((text) => assert.equal(routeMode(text), 'chat', text));
}

function testAgentCanvasGuard() {
  assert.ok(
    aiExeJs.includes('if (!canvasModeUiEnabled || developerAgentEnabled)'),
    'Agent mode must keep preflight routing active even when Canvas UI is enabled.',
  );
  assert.ok(
    aiExeJs.includes('reason: \'Canvas mode is on, so workspace/tool routing is bypassed for this turn.\''),
    'Canvas-only bypass reason should remain explicit for debug traces.',
  );
}

async function testContextBudgetStress() {
  const huge = (label) => `${label}_START ` + label.repeat(9000) + ` ${label}_END`;
  const messages = [
    { role: 'user', text: huge('OLD_A') },
    { role: 'ai', text: huge('OLD_B') },
    { role: 'user', text: huge('MID_C') },
    { role: 'ai', text: 'RECENT_REPLY keep me' },
    { role: 'user', text: 'LATEST_QUESTION keep latest' },
  ];
  const prompt = await buildPrompt({ messages });
  assert.ok(prompt.length < 24576, `prompt exceeded context budget: ${prompt.length}`);
  assert.ok(!prompt.includes('OLD_A_START'), 'oldest huge message should be dropped');
  assert.ok(prompt.includes('OLD_B_START'), 'newer huge message start should remain');
  assert.ok(!prompt.includes('OLD_B_END'), 'newer huge message should be truncated');
  assert.ok(prompt.includes('MID_C_START'), 'recent huge message start should remain');
  assert.ok(prompt.includes('RECENT_REPLY keep me'));
  assert.ok(prompt.includes('LATEST_QUESTION keep latest'));
}

(async () => {
  await testPromptCombinations();
  testDeterministicCanvasRouting();
  testAgentCanvasGuard();
  await testContextBudgetStress();
  console.log('Mode priority stress tests passed.');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
