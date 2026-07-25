// v9.9.0 — a full localStorage must never cost the user a conversation.
//
// Root cause found live: WebKit caps localStorage at 5 MB/origin; the store was at
// 5.13 MB, so every save failed. saveChats' fallback ladder then sliced the chat LIST
// (30 -> 12 -> 4), permanently deleting conversations. 10 chats were lost that way.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'backend', 'app', 'chatstore.py'), 'utf8');
const main = fs.readFileSync(path.join(root, 'backend', 'app', 'main.py'), 'utf8');

const saveStart = aiExe.indexOf('function saveChats()');
const saveFn = aiExe.slice(saveStart, aiExe.indexOf('function normalizeStoredPendingPreflightConfirmation'));

// ---- The ladder must never drop chats ----
assert.doesNotMatch(saveFn, /\.slice\(0, 30\)/, 'the 30-chat rung is gone');
assert.doesNotMatch(saveFn, /\.slice\(0, 12\)/, 'the 12-chat rung is gone');
assert.doesNotMatch(saveFn, /\.slice\(0, 4\)/, 'the 4-chat rung that destroyed history is gone');
assert.match(saveFn, /keepRecentThreadMessages\([\s\S]*?, 2,\s*\)/, 'the lightest rung sheds CONTENT, keeping every chat');

// ---- Every save writes through to the durable store ----
assert.match(saveFn, /typeof persistChatsDurable === 'function'\) void persistChatsDurable\(chats\)/,
  'the DB always receives the full list');
assert.match(saveFn, /try \{ if \(typeof persistChatsDurable/,
  'and it can never throw the save path apart');
assert.match(aiExe, /function persistChatsDurable\(list\)/, 'the durable writer exists');
assert.match(aiExe, /method: 'PUT'/, 'it writes to the backend');

// ---- Boot restores anything the cache lost ----
assert.match(aiExe, /async function hydrateChatsFromDurableStore\(attempt = 0\)/, 'boot hydration exists');
assert.match(aiExe, /loadStoredChats\(\);\n {2}void hydrateChatsFromDurableStore\(\);/, 'it runs right after the cache load');
const hydrate = aiExe.slice(aiExe.indexOf('async function hydrateChatsFromDurableStore'), aiExe.indexOf('function loadStoredChats'));
assert.match(hydrate, /!have\.has\(chat\.id\)/, 'only chats missing locally are restored — no clobbering');
// Hydration lands after boot has painted, so it must repaint or the restore is invisible.
assert.match(hydrate, /renderHistory\(\)/, 'the sidebar is repainted after a restore');
assert.match(hydrate, /attempt >= 5/, 'it retries while the backend is still starting');

// ---- The store itself never deletes to reclaim space ----
assert.match(store, /def delete_chat/, 'explicit deletion exists');
assert.match(store, /Explicit user deletion only/, 'and it is documented as user-driven only');
assert.doesNotMatch(store, /LIMIT \d+|\[:\s*\d+\]/, 'no silent truncation anywhere in the store');
assert.match(store, /def import_chats/, 'additive restore exists');
assert.match(store, /self\.snapshot\(scope, reason\)/, 'an import snapshots first so it is reversible');

// ---- The local API is not reachable from a website ----
assert.match(main, /async def block_foreign_origins/, 'the origin guard exists');
assert.match(main, /status_code=403/, 'foreign origins are refused');
assert.doesNotMatch(main, /allow_origins=settings\.allowed_origins/, 'the wildcard CORS default is gone');

console.log('PASS: chats are never deleted to save space, every save reaches the DB, boot restores what the cache lost, and the local API refuses foreign origins');
