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
const router = fs.readFileSync(path.join(root, 'backend', 'app', 'routers', 'chats.py'), 'utf8');

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
// Hydration lands after boot has painted, so it must repaint or the restore is invisible.
assert.match(hydrate, /renderHistory\(\)/, 'the sidebar is repainted after a restore');
assert.match(hydrate, /attempt >= 5/, 'it retries while the backend is still starting');

// ---- The store itself never deletes to reclaim space ----
assert.match(store, /def delete_chat/, 'explicit deletion exists');
assert.match(store, /Explicit user deletion only/, 'and it is documented as user-driven only');
// No silent truncation on the LIVE chat path — that is what dropped conversations. Scoped
// to the live read/write region: the deleted-copy helpers legitimately use LIMIT 1 to pick
// the newest backup for ONE chat, which is not list truncation.
const liveRegion = store.slice(store.indexOf('def list_chats'), store.indexOf('def delete_chat'));
assert.doesNotMatch(liveRegion, /LIMIT \d+|\[:\s*\d+\]/, 'no silent truncation on the live chat path');
assert.match(store, /SELECT payload FROM chats WHERE user_scope = \? ORDER BY updated_at DESC",/,
  'listing chats reads every row — no LIMIT crept into it');
assert.match(store, /def import_chats/, 'additive restore exists');
assert.match(store, /self\.snapshot\(scope, reason\)/, 'an import snapshots first so it is reversible');

// ---- The local API is not reachable from a website ----
assert.match(main, /async def block_foreign_origins/, 'the origin guard exists');
assert.match(main, /status_code=403/, 'foreign origins are refused');
assert.doesNotMatch(main, /allow_origins=settings\.allowed_origins/, 'the wildcard CORS default is gone');

// ---- The cache must not starve settings / API keys / artifacts of the same quota ----
// Live: chats held 4.38 MB of a 5 MB origin quota, so every OTHER localStorage write
// (API keys, password change, artifacts) failed silently too.
assert.match(aiExe, /const CHAT_CACHE_BUDGET_CHARS = \d+;/, 'the cache has an explicit budget');
assert.match(saveFn, /boundChatCacheToBudget\(basePayload\)/, 'the very first attempt is already bounded');
const bound = aiExe.slice(aiExe.indexOf('function boundChatCacheToBudget'), aiExe.indexOf('function saveChats()'));
assert.match(bound, /_cacheStub: true/, 'over-budget chats become stubs, not deletions');
assert.match(bound, /id: chat\.id/, 'a stub keeps its identity so the sidebar stays complete');
// The chat on screen must survive the cache bound whatever its size.
assert.match(bound, /if \(!out\.length \|\| used \+ full\.length <= budget\)/,
  'the newest chat is never stubbed');

// ---- v9.9.2: a stub is a placeholder, never a save ----
// Live damage: the stub lost its flag in loadStoredChats, so the next save wrote an
// EMPTY chat over the DB row that still held the history. 14 chats went title-only.
assert.match(aiExe, /function isChatCacheStub\(chat\)/, 'stubs are identifiable at runtime');
const persist = aiExe.slice(aiExe.indexOf('function persistChatsDurable'), aiExe.indexOf('async function hydrateChatsFromDurableStore'));
assert.match(persist, /filter\(\(chat\) => chat && !isChatCacheStub\(chat\)\)/,
  'a stub is never PUT over the stored conversation');
const load = aiExe.slice(aiExe.indexOf('function loadStoredChats'), aiExe.indexOf('function openChatActionModal'));
assert.match(load, /_cacheStub: Boolean\(chat\._cacheStub\)/,
  'the stub flag survives the cache load — losing it is what caused the loss');
assert.match(hydrate, /isChatCacheStub\(local\)/, 'boot fills stubs from the DB instead of skipping them');
assert.match(aiExe, /async function ensureChatContentLoaded\(chatId\)/, 'opening a stub loads it on demand');
// Server-side backstop: even a buggy client cannot blank stored history.
assert.match(store, /def _message_total/, 'the store counts stored messages');
assert.match(store, /if incoming_msgs == 0 and stored_msgs > 0:/, 'a blank write over history is refused');
assert.match(store, /protected \+= 1/, 'and reported rather than applied');
assert.match(store, /f"shrink-\{chat_id\}"/, 'any other shrink stays recoverable');

// ---- A deleted chat must stay deleted across a relaunch ----
// Live: delete only cleared memory + cache; the DB row survived and boot hydrated it back.
const delStart = aiExe.indexOf('function deleteChatFromModal');
const del = aiExe.slice(delStart, aiExe.indexOf('\nfunction ', delStart + 1));
assert.match(del, /recordChatDeletion\(deletedChatId\)/, 'deleting a chat reaches the DB');
assert.match(aiExe, /async function deleteChatFromDurableStore\(chatId\)/, 'the DELETE call exists');
assert.match(aiExe, /res\.ok \|\| res\.status === 404/, 'already-gone counts as deleted');
// A tombstone covers a backend that is down at delete time.
assert.match(aiExe, /const chatTombstonesStoragePrefix = /, 'deletions are remembered locally');
assert.match(aiExe, /async function flushChatTombstones\(\)/, 'and retried later');
assert.match(hydrate, /if \(deleted\.has\(chat\.id\)\) continue;/, 'a deleted chat is never hydrated back');
assert.match(router, /@router\.get\("\/chats\/\{scope\}\/\{chat_id\}"\)/, 'per-chat read exists for stub fills');
assert.match(router, /@router\.delete\("\/chats\/\{scope\}\/\{chat_id\}"\)/, 'the delete endpoint exists');

// ---- v9.9.4: a delete is recoverable for 30 days, then it is really gone ----
// A misclick should not be as final as the v9.9.1 bug was; the chat still leaves the
// sidebar instantly, the copy just lives in chat_backups until retention expires.
assert.match(store, /DELETED_RETENTION_DAYS = 30/, 'retention is 30 days');
const deleteFn = store.slice(store.indexOf('def delete_chat'), store.indexOf('def list_deleted'));
assert.match(deleteFn, /INSERT INTO chat_backups/, 'the conversation is snapshotted before removal');
assert.ok(deleteFn.indexOf('INSERT INTO chat_backups') < deleteFn.indexOf('DELETE FROM chats'),
  'snapshot FIRST — a crash mid-delete must not lose the only copy');
assert.match(deleteFn, /DELETE FROM chat_backups WHERE created_at < \?/, 'expired copies are pruned');
assert.match(store, /def list_deleted/, 'recoverable deletions can be listed');
assert.match(store, /def restore_deleted/, 'and restored');
assert.match(store, /if not chat_id or chat_id in live or chat_id in seen:/,
  'an already-restored chat is not offered as recoverable');
// Route order is a real trap: /{chat_id} would swallow the literal "deleted" path.
assert.ok(router.indexOf('"/chats/{scope}/deleted"') < router.indexOf('"/chats/{scope}/{chat_id}"'),
  'the literal /deleted route is declared before /{chat_id} or it is unreachable');
assert.match(router, /@router\.post\("\/chats\/\{scope\}\/deleted\/\{chat_id\}\/restore"\)/,
  'the restore endpoint exists');

console.log('PASS: chats are never deleted to save space, every save reaches the DB, a cache stub can never blank stored history, deleted chats stay deleted, boot restores what the cache lost, and the local API refuses foreign origins');
