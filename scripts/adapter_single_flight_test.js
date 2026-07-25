// v9.8.5 — the adapter drives one browser behind one lock, so the app must never have
// two requests queued for the same chat.
//
// Captured live: `lsof -iTCP:9999` showed 24 ESTABLISHED connections, adapter CPU 0.0%.
// Our side timed out (~5 min), abandoned the wait WITHOUT closing the socket, invented a
// fallback decision, and fired another request. Every step then queued behind the corpses.
// The user reads those fallback decisions as "the model hallucinating".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');

assert.match(aiExe, /const adapterInFlightByChat = new Map\(\);/, 'the in-flight registry exists');

const start = aiExe.indexOf('async function streamOllamaChatCompletion');
const fn = aiExe.slice(start, aiExe.indexOf('const result = await requestOllamaChatCompletion', start));

// A superseding request must ABORT the old one — that is what closes the socket.
assert.match(fn, /const previousInFlight = adapterInFlightByChat\.get\(inFlightKey\);/, 'the previous request is looked up');
assert.match(fn, /previousInFlight\.controller\.abort\(\)/, 'the previous request is aborted, not just dropped');
assert.match(fn, /adapter_request_superseded/, 'supersession is traced');

// The fetch must use the controller we track, or aborting it would do nothing.
assert.match(fn, /signal: streamController \? streamController\.signal : undefined/, 'the tracked controller drives the fetch');
assert.doesNotMatch(fn, /signal: options\.abortController \? options\.abortController\.signal : undefined/,
  'the untracked signal is gone');

// The slot must be released on EVERY exit or the next request aborts a finished one.
assert.match(fn, /\} finally \{[\s\S]*?adapterInFlightByChat\.delete\(inFlightKey\)/,
  'the slot is released in finally, not only on success');
assert.match(fn, /stillMine\.controller === streamController/,
  'only the owner releases the slot, so a superseding request keeps its own');

// Per-chat, not global: two different chats must still run independently.
assert.match(fn, /const inFlightKey = String\(chatId \|\| 'default'\);/, 'the gate is keyed per chat');

console.log('PASS: one adapter request per chat; a new one aborts the old so the socket closes instead of queueing behind a lock');
