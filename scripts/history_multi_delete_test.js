// Recent list multi-select: tick chats, Delete twice, all removed through the one delete path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'ui', 'chat-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'ui', 'ai-exe.html'), 'utf8');

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name);
}

const names = ['deleteChatsByIds', 'isHistorySelecting', 'isChatSelectedInHistory', 'startHistorySelection',
  'endHistorySelection', 'toggleHistorySelection', 'selectAllHistory', 'deleteSelectedHistoryChats'];
const deletedFromDb = [];
let cancelled = 0;
const ctx = {
  chats: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  artifacts: [{ chatId: 'a' }, { chatId: 'c' }],
  debugTraceEntries: [{ chatId: 'b' }, { chatId: 'c' }],
  queuedSends: [{ chatId: 'a' }, { chatId: 'c' }],
  activeChatId: 'a',
  inNewChatMode: false,
  artifactDetailKey: 'x',
  activeInferenceRequest: { chatId: 'a', cancelled: false },
  thinkingStartedByChatId: new Map(),
  historySelection: null,
  historyDeleteArmed: false,
  findChatById: (id) => ctx.chats.find((c) => String(c.id) === String(id)) || null,
  recordChatDeletion: (id) => deletedFromDb.push(id),
  cancelActiveInference: () => { cancelled += 1; },
  clearTypingIndicator() {}, setThinkingStatus() {}, saveChats() {}, flushNativeUiStorageBackup: async () => {},
  saveArtifacts() {}, scheduleAttachmentMediaPrune() {}, renderArtifacts() {}, renderHistory() {},
  renderSidebarCounts() {}, renderActiveChat() {}, syncSidebarNavState() {}, renderHistorySelectBar() {},
  recordDebugTrace() {}, buildRuntimeStateSnapshot() { return {}; },
  window: { setTimeout },
};
vm.createContext(ctx);
vm.runInContext(`${names.map((n) => fn(ui, n)).join('\n')}
this.api = { ${names.join(', ')} };
this.state = () => ({ chats, artifacts, debugTraceEntries, activeChatId, inNewChatMode, historySelection, historyDeleteArmed });`, ctx);
const { api } = ctx;

api.startHistorySelection();
api.toggleHistorySelection('a');
api.toggleHistorySelection('b');
api.toggleHistorySelection('b');
api.toggleHistorySelection('c');
assert.deepEqual([...ctx.state().historySelection], ['a', 'c']);
api.deleteSelectedHistoryChats();
assert.equal(ctx.state().chats.length, 3, 'first Delete only arms');
assert.equal(ctx.state().historyDeleteArmed, true);
api.deleteSelectedHistoryChats();
const st = ctx.state();
assert.deepEqual(st.chats.map((c) => c.id), ['b']);
assert.deepEqual(deletedFromDb, ['a', 'c'], 'removed from the durable store');
assert.deepEqual(st.artifacts, []);
assert.deepEqual(st.debugTraceEntries.map((e) => e.chatId), ['b']);
assert.equal(ctx.queuedSends.length, 0, 'queued messages of deleted chats are dropped');
assert.equal(cancelled, 1, 'a running reply in a deleted chat is stopped');
assert.equal(st.activeChatId, 'b');
assert.equal(st.historySelection, null, 'selection mode ends after delete');

// Select all toggles; toggling a chat disarms a pending delete.
api.startHistorySelection();
api.selectAllHistory();
assert.deepEqual([...ctx.state().historySelection], ['b']);
api.deleteSelectedHistoryChats();
api.toggleHistorySelection('b');
assert.equal(ctx.state().historyDeleteArmed, false);
api.endHistorySelection();
assert.equal(ctx.state().historySelection, null);

// Wiring: list renders checkboxes, Cmd/Ctrl-click selects, modal uses the same delete path.
assert.match(shell, /evt\.metaKey \|\| evt\.ctrlKey/);
assert.match(shell, /check\.className = 'hi-check'/);
assert.match(fn(ui, 'deleteChatFromModal'), /deleteChatsByIds\(\[deletedChatId\]\)/);
assert.match(html, /id="historySelectBar" hidden/);
console.log('PASS: multi-select delete removes exactly the ticked chats (two-step confirm, queue + running reply handled)');
