const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');

assert.doesNotMatch(source, /Generate a concise sidebar title for this chat/);
assert.doesNotMatch(source, /function maybeRenameVeniceChat/);
assert.doesNotMatch(source, /\/api\/provider\/rename_chat/);
assert.doesNotMatch(source, /\/api\/provider\/delete_chat/);

const start = source.indexOf('function scheduleSmartChatRename');
const end = source.indexOf('\n\nfunction buildPromptWithInputAugments', start);
assert.ok(start >= 0 && end > start);
const naming = source.slice(start, end);
assert.match(naming, /<AIcanvas/);
assert.match(naming, /source: canvasMatch \? 'canvas' : 'existing'/);
assert.doesNotMatch(naming, /requestRemoteTextCompletion|setTimeout|fetch\(/);

console.log('PASS: chat titles come from the first response/canvas with no extra model call or Venice rename');
