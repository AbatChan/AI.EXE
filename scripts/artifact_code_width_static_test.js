const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.css'), 'utf8');
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `${selector} rule exists`);
  return match[1];
};

const artifactBrowser = rule('.artifact-browser');
const chatChild = rule('.chat-area > *');
const financeChild = rule('.finance-dashboard > *');

assert.match(chatChild, /var\(--chat-content-max-width\)/, 'Chat/New Chat use the readable chat cap');
assert.match(artifactBrowser, /var\(--chat-content-max-width\)/, 'Artifacts and Code share the chat cap');
assert.match(artifactBrowser, /calc\(100% - \(2 \* var\(--content-gutter\)\)\)/, 'Artifacts and Code stay fluid on small screens');
assert.doesNotMatch(artifactBrowser, /var\(--content-max-width\)/, 'Artifacts and Code no longer use the wide dashboard cap');
assert.match(financeChild, /var\(--content-max-width\)/, 'Finance keeps its wider layout unchanged');

console.log('PASS: Artifacts and Code match Chat width while Finance remains wide.');
