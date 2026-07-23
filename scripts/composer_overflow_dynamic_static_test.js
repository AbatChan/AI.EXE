const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const start = source.indexOf('// ---- Composer action-chip overflow (+N)');
const end = source.indexOf('const settingsAdapterHidePrompt', start);
assert.ok(start >= 0 && end > start, 'composer overflow section exists');
const section = source.slice(start, end);

assert.match(
  source,
  /const buttons = \[continueBtn, canvasBtn, attachBtn, agentBtn, thinkBtn, webSearchBtn, contextBtn\]/,
  'Web Search participates in composer action state',
);
assert.match(
  section,
  /querySelectorAll\('\.iact-btn'\)/,
  'overflow candidates are discovered dynamically from all action chips',
);
assert.match(
  section,
  /composerOverflowBtn\.textContent = `\+\$\{chips\.length\}`/,
  'the real maximum +N label is measured before fitting chips',
);
assert.match(
  section,
  /fittedActionsWidth = Math\.max\(0, inputActionsEl\.getBoundingClientRect\(\)\.width\)/,
  'fit calculation uses live browser geometry',
);
assert.doesNotMatch(section, /const reserve = 46/, 'fixed overflow width estimate is removed');
assert.match(section, /new ResizeObserver\(\(\) => scheduleComposerChipOverflow\(30\)\)/, 'container resizing triggers recalculation');
assert.match(section, /composerOverflowResizeObserver\.observe\(inputControlsLeftEl\)/, 'composer width is observed');
assert.match(section, /if \(composerModelWrap\) composerOverflowResizeObserver\.observe\(composerModelWrap\)/, 'model pill width is observed');
assert.match(section, /id === 'webSearchBtn'[\s\S]*?setWebSearchMode\(false\)/, 'overflow removal disables Web Search through shared state');

console.log('PASS: composer +N overflow is dynamic and includes Web Search.');
