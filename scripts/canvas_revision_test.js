// Canvas: same title in the same chat = new version, not "Title (2)"; every current doc reaches the prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'ui', 'prompt-core.js'), 'utf8');

function fn(name) {
  const start = ui.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = ui.indexOf('{', ui.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < ui.length; i += 1) {
    if (ui[i] === '{') depth += 1;
    else if (ui[i] === '}' && --depth === 0) return ui.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let clock = 1000;
const sandbox = {
  artifacts: [],
  maxArtifactContentChars: 100000,
  nowTs: () => (clock += 10),
  formatBytes: (n) => `${n} B`,
  estimateTextBytes: (t) => String(t).length,
  saveArtifacts: () => {},
  renderArtifacts: () => {},
  setCanvasPanelContent: () => {},
};
vm.createContext(sandbox);
vm.runInContext([
  fn('isCurrentArtifact'), fn('addCanvasArtifacts'), fn('getCanvasDocumentsForChat'), fn('getCanvasContextForChat'),
  'this.api = { addCanvasArtifacts, getCanvasDocumentsForChat, getCanvasContextForChat };',
].join('\n'), sandbox);
const api = sandbox.api;

// Two docs, one reply.
api.addCanvasArtifacts('chat-a', [
  { name: 'Lagos Traffic Article', content: 'ARTICLE v1', format: 'text' },
  { name: 'Commute Survival Checklist', content: '1\n2\n3\n4\n5\n6', format: 'text' },
], 100);
// Next reply revises only the second (title reused, different case).
const rev = api.addCanvasArtifacts('chat-a', [{ name: 'commute survival checklist', content: '1\n2\n3', format: 'text' }], 200);
assert.equal(rev[0].name, 'Commute Survival Checklist', 'revision keeps the original title, no "(2)"');
assert.equal(rev[0].revision, 2);

const all = sandbox.artifacts;
assert.equal(all.length, 3, 'old version kept for its own message');
assert.equal(all.filter((a) => !a.superseded).length, 2, 'only two current documents');
assert.equal(all.find((a) => a.messageTs === 100 && a.name === 'Commute Survival Checklist').superseded, true);
assert.equal(all.find((a) => a.name === 'Lagos Traffic Article').content, 'ARTICLE v1', 'untouched doc unchanged');

const docs = api.getCanvasDocumentsForChat('chat-a');
assert.deepEqual(Array.from(docs, (d) => d.name), ['Lagos Traffic Article', 'Commute Survival Checklist'], 'every current doc, oldest first');
assert.equal(docs[1].content, '1\n2\n3', 'context carries the latest version');

// Same title in another chat is a separate document.
api.addCanvasArtifacts('chat-b', [{ name: 'Lagos Traffic Article', content: 'OTHER', format: 'text' }], 300);
assert.equal(sandbox.artifacts.find((a) => a.chatId === 'chat-b').revision, 1);
assert.equal(api.getCanvasDocumentsForChat('chat-a').length, 2);

// Same title twice inside one reply keeps one card with the last draft.
api.addCanvasArtifacts('chat-c', [
  { name: 'Plan', content: 'draft', format: 'text' },
  { name: 'Plan', content: 'final', format: 'text' },
], 400);
const planRows = sandbox.artifacts.filter((a) => a.chatId === 'chat-c');
assert.equal(planRows.length, 1);
assert.equal(planRows[0].content, 'final');

// Prompt side: all docs + the revision contract.
assert.match(core, /deps\.getCanvasDocumentsForChat/);
assert.match(core, /CANVAS_DOCUMENTS \(/);
assert.match(core, /EXACT same title — that saves it as a new version/);
assert.match(ui, /revision: Number\(item\.revision\) \|\| 1,\n\s+superseded: Boolean\(item\.superseded\)/, 'load keeps version fields');

console.log('PASS: canvas revisions keep one title, older versions leave lists/context, all docs reach the prompt');
