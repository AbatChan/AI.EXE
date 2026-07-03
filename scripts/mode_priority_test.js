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

const customInstructionsMarker = 'USER CUSTOM INSTRUCTIONS FROM THE APP UI';

async function testPromptCombinations() {
  const baseMessages = [
    { role: 'user', text: 'Create a launch plan for the app.' },
  ];

  const contextPrompt = await buildPrompt({
    messages: baseMessages,
    manualContext: 'Prefer concise sections.',
  });
  assert.ok(contextPrompt.includes('Priority order:'));
  assert.ok(contextPrompt.includes(customInstructionsMarker));
  assertOrder(contextPrompt, 'Priority order:', customInstructionsMarker);
  assertOrder(contextPrompt, customInstructionsMarker, '<|im_start|>user');

  const thinkPrompt = await buildPrompt({
    messages: baseMessages,
    thinkMode: true,
  });
  assert.ok(thinkPrompt.includes('THINK_MODE: ON'));
  assert.ok(thinkPrompt.includes('first non-empty output token must be <thinking>'));
  assert.ok(thinkPrompt.includes('If you omit the <thinking> block, the response is malformed'));

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
  assertOrder(combinedPrompt, customInstructionsMarker, 'UI MODE: Canvas mode is enabled');
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

async function testInlineChatNamingOnlyBeforeFirstAssistant() {
  const namingDeps = {
    shouldInlineNameChatResponse: (chat) => Boolean(chat && chat.isNaming),
  };
  const firstTurnPrompt = await buildPrompt({
    isNaming: true,
    messages: [
      { role: 'user', text: 'between 9.9 and 9.11 which is bigger?' },
    ],
  }, namingDeps);
  assert.ok(firstTurnPrompt.includes('CHAT TITLE PREFIX:'));

  const thinkNamingPrompt = await buildPrompt({
    isNaming: true,
    thinkMode: true,
    messages: [
      { role: 'user', text: 'between 9.9 and 9.11 which is bigger?' },
    ],
  }, namingDeps);
  assert.ok(thinkNamingPrompt.includes('THINK_MODE: ON'));
  assert.ok(thinkNamingPrompt.includes('CHAT NAME PREFIX FOR THIS RESPONSE:'));
  assert.ok(!thinkNamingPrompt.includes('First line must be exactly: [[CHAT_NAME: 2-6 word title]]'));
  assertOrder(thinkNamingPrompt, 'THINK_MODE: ON', 'CHAT NAME PREFIX FOR THIS RESPONSE:');

  const laterTurnPrompt = await buildPrompt({
    isNaming: true,
    messages: [
      { role: 'user', text: 'between 9.9 and 9.11 which is bigger?' },
      { role: 'ai', text: 'Between 9.9 and 9.11, 9.11 is bigger.' },
      { role: 'user', text: 'what is the difference?' },
    ],
  }, namingDeps);
  assert.ok(!laterTurnPrompt.includes('CHAT TITLE PREFIX:'));
  assert.ok(!laterTurnPrompt.includes('[[CHAT_NAME: 2-6 word title]]'));
}

function testDeterministicCanvasRouting() {
  // No keyword routing: the model router is primary; the no-model fallback
  // trusts the user's explicit Canvas toggle regardless of phrasing.
  const cases = [
    'write a detailed project proposal',
    'Write a stroy on how AI became famous',
    'thanks',
    'how do I run this',
  ];
  cases.forEach((text) => assert.equal(routeMode(text), 'canvas', text));
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

// All three send layers must gate per-view so other chats can queue while one runs.
function testPerViewSendGating() {
  const keydownSource = extractFunctionSource(aiExeJs, 'handleKey');
  assert.ok(
    keydownSource.includes('pendingInferenceCount > 0 && isCurrentViewInferenceChat()'),
    'composer Enter must be swallowed only in the chat that owns the running op',
  );
  assert.ok(
    !/if \(pendingInferenceCount > 0\) \{\s*\n\s*if \(e\.key === 'Enter'/.test(keydownSource),
    'the old global Enter swallow must not return',
  );
  const sendButtonSource = extractFunctionSource(aiExeJs, 'handleSendButtonClick');
  assert.ok(
    sendButtonSource.includes('pendingInferenceCount > 0 && isCurrentViewInferenceChat()'),
    'send button cancels only when viewing the running chat',
  );
  const sendSource = extractFunctionSource(aiExeJs, 'sendMessage');
  assert.ok(sendSource.includes('queuedSends.push'), 'sends from other chats must queue');
  assert.ok(
    extractFunctionSource(aiExeJs, 'endInferenceRequest').includes('dispatchNextQueuedSend'),
    'queued sends must dispatch when the engine goes idle',
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
  await testInlineChatNamingOnlyBeforeFirstAssistant();
  testDeterministicCanvasRouting();
  testAgentCanvasGuard();
  testPerViewSendGating();
  await testContextBudgetStress();
  console.log('Mode priority stress tests passed.');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
