const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const start = source.indexOf('function stripChatStorageHeavyFields');
const end = source.indexOf('\nfunction normalizeStoredPendingPreflightConfirmation', start);
assert.ok(start >= 0 && end > start, 'chat persistence functions should be discoverable');

const preview = Array.from({ length: 72 }, (_, index) => ({
  type: index % 3 === 0 ? 'add' : 'context',
  oldLine: index,
  newLine: index + 1,
  text: `preview row ${index} ${'x'.repeat(180)}`,
}));
const userMessage = { role: 'user', text: 'Please fix and narrate the work', ts: 1 };
const assistantMessage = {
  role: 'ai',
  text: 'Finished: the final response must survive relaunch.',
  ts: 2,
  agentActivities: [{
    kind: 'edit',
    title: 'Edited',
    detail: 'Updated persistence',
    streamContent: 's'.repeat(380000),
    diffPreview: preview,
  }],
  agentMeta: {
    startedAt: 1,
    completedAt: 2,
    revert: {
      files: [{
        path: 'ui/ai-exe.js',
        content: 'f'.repeat(380000),
        diffPreview: preview,
      }],
    },
  },
};
const thread = {
  id: 'thread-active',
  messages: [userMessage, assistantMessage],
  branchLinks: [],
  needsContinue: false,
};
const chat = {
  id: 'chat-active',
  updatedAt: 2,
  activeThreadId: thread.id,
  threads: [thread],
  // Runtime mirror: this used to double the serialized weight.
  messages: thread.messages,
  branchLinks: [],
  pendingAttachments: [],
};

let stored = '';
let attempts = 0;
const quotaBytes = 180000;
const context = {
  chats: [chat],
  chatsStoragePrefix: 'ai_exe_chats_v1',
  scopedStorageKey: (value) => value,
  ensureChatThreadState: () => thread,
  sortChatsInPlace: () => {},
  normalizeMessageAttachmentList: (value) => (Array.isArray(value) ? value : []),
  normalizePendingAttachmentList: (value) => (Array.isArray(value) ? value : []),
  persistActiveChatId: () => {},
  recordDebugTrace: () => {},
  localStorage: {
    setItem: (_key, value) => {
      attempts += 1;
      if (Buffer.byteLength(value, 'utf8') > quotaBytes) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      stored = value;
    },
  },
  console,
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.__saveChats = saveChats;`, context);
context.__saveChats();

assert.ok(attempts >= 3, 'test must exercise storage-pressure fallbacks');
assert.ok(stored, 'a quota fallback must still persist the conversation');
const persisted = JSON.parse(stored);
assert.equal(persisted.length, 1);
assert.deepEqual(persisted[0].messages, [], 'active-thread runtime mirror must not be serialized twice');
const savedMessages = persisted[0].threads[0].messages;
assert.equal(savedMessages.at(-1).text, assistantMessage.text, 'newest final assistant message must survive');
assert.equal(savedMessages.at(-1).agentActivities[0].detail, 'Updated persistence', 'tool summary must survive');
assert.ok(savedMessages.at(-1).agentActivities[0].diffPreview.length > 0, 'newest diff drawer must survive');
assert.equal(savedMessages.at(-1).agentActivities[0].streamContent, '', 'heavy live stream body should be removed');
assert.equal(savedMessages.at(-1).agentMeta.revert.files[0].content, '', 'full revert snapshot should be removed');

console.log('Passed final-reply quota persistence test.');
