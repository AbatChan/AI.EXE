const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
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
assert.match(js, /function getArtifactDisplayName\(item\)/, 'technical artifact names have a friendly display fallback');
assert.match(js, /return projectName \|\| String\(linkedChat\.name/, 'project name falls back to the source chat name');
assert.match(js, /if \(!isCodeArtifact\(item\)\) return 'TEXT'/, 'text artifacts use a TEXT type label');
assert.match(js, /artifact-row-icon[\s\S]*artifact-row-time/, 'type icon is left and time is right in each row');
assert.match(css, /\.artifact-row:hover \.artifact-row-time[\s\S]*opacity: 0/, 'time clears space for hover actions');
assert.match(css, /\.artifact-row:hover \.artifact-row-actions[\s\S]*opacity: 1/, 'hover action icons remain available');
assert.doesNotMatch(js, /\$\{escapeHtml\(chatName\)\} • \$\{escapeHtml\(formatTimeAgo\(item\.createdAt\)\)\}/, 'time is removed from the metadata under the title');

console.log('PASS: Artifacts and Code match Chat width while Finance remains wide.');
