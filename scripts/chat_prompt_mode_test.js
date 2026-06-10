// Unit tests for normal chat mode instructions.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'prompt-core.js'));

const promptCore = global.AIExePromptCore.createPromptCore({
  findChatById: () => ({
    id: 'chat_test',
    messages: [
      { role: 'user', text: 'create snake game' },
    ],
  }),
  currentAuthUser: () => null,
  normalizeUsername: (value) => String(value || '').trim(),
  isCanvasModeEnabled: () => false,
  isThinkModeEnabled: () => false,
  isAgentModeEnabled: () => false,
  shouldInlineNameChatResponse: () => false,
});

(async () => {
  const prompt = await promptCore.buildInferencePrompt('chat_test', 'sure', {});
  assert.ok(prompt.includes('Agent mode is OFF for this turn'), 'prompt states Agent mode is off');
  assert.ok(prompt.includes('never say you will create/write/place files now'), 'prompt blocks fake file creation promises');
  console.log('Passed chat prompt mode tests.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
