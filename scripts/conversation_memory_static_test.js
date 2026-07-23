const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'prompt-core.js'));

const rawSecret = 'RAW_FILE_BODY_SHOULD_NOT_LEAK';
const chat = {
  id: 'chat_memory',
  messages: [
    { role: 'user', text: 'Build the story site.' },
    {
      role: 'ai',
      text: 'The story website is ready.',
      webSearchEnabled: true,
      agentActivities: [
        {
          kind: 'checklist',
          title: 'Plan',
          status: 'done',
          items: [{ text: 'Create the comic layout', done: true }],
        },
        {
          kind: 'write',
          title: 'Wrote',
          detail: 'index.html',
          meta: '158 lines',
          status: 'done',
          streamContent: rawSecret,
        },
        {
          kind: 'scan',
          title: 'Checked',
          detail: 'files + app run',
          meta: 'no issues found',
          status: 'done',
        },
      ],
    },
    { role: 'user', text: 'What did you do, and what is in the canvas?' },
  ],
};

const core = global.AIExePromptCore.createPromptCore({
  findChatById: () => chat,
  currentAuthUser: () => null,
  normalizeUsername: (value) => String(value || '').trim(),
  isCanvasModeEnabled: () => false,
  isThinkModeEnabled: () => false,
  isAgentModeEnabled: () => false,
  shouldInlineNameChatResponse: () => false,
  getCanvasContextForChat: () => ({
    name: 'Spidey vs Doom',
    format: 'text',
    content: 'Spider-Man defeats Doctor Doom by turning Doom\'s own trap against him.',
  }),
});

(async () => {
  const prompt = await core.buildInferencePrompt('chat_memory', '', { webSearchActive: true });
  assert.match(prompt, /<agent_work_summary>/, 'normal chat receives compact Agent work memory');
  assert.match(prompt, /Wrote: index\.html/, 'written file is represented in compact memory');
  assert.match(prompt, /Checked: files \+ app run/, 'validation step is represented');
  assert.doesNotMatch(prompt, new RegExp(rawSecret), 'raw generated file bodies never enter memory');
  assert.match(prompt, /CURRENT_CANVAS_CONTEXT/, 'latest Canvas is included');
  assert.match(prompt, /Spider-Man defeats Doctor Doom/, 'Canvas body is readable');
  assert.match(prompt, /Live web search is enabled through Venice/, 'model knows web search is enabled');
  assert.match(prompt, /web_search_context/, 'historical web-enabled response is marked');

  const agentHistory = core.buildAgentHistoryTranscript('chat_memory');
  assert.match(agentHistory, /agent_work_summary/, 'Agent planner receives earlier Agent work memory');
  assert.match(agentHistory, /canvas_context title="Spidey vs Doom"/, 'Agent planner can read latest Canvas');
  assert.doesNotMatch(agentHistory, new RegExp(rawSecret), 'Agent planner memory excludes raw activity streams');
  console.log('PASS: Agent work, Canvas content, and web-search state survive prompt reconstruction.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
