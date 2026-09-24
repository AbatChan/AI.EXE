const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const button = () => ({ attributes: {}, classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = value; } });
let context = false;
const ctx = { Boolean, String, Number, Array, Set, Math, artifacts: [], nowTs: () => 1000,
  getActiveManualContext: () => context ? 'Audience: beginners.' : '', updateAttachButtonState() {}, syncComposerLayoutState() {},
  saveArtifacts() {}, renderArtifacts() {}, setCanvasPanelContent() {}, maxArtifactContentChars: 10000,
  estimateTextBytes: text => Buffer.byteLength(text), formatBytes: bytes => `${bytes} B`,
};
for (const name of ['canvasBtn','agentBtn','thinkBtn','webSearchBtn','contextBtn','menuCanvasBtn','menuAgentBtn','menuThinkBtn','menuWebSearchBtn','menuContextBtn']) ctx[name] = button();
vm.createContext(ctx);
vm.runInContext(source.match(/^function updateInputActionChips\([^]*?^}/m)[0], ctx);
for (let mask = 0; mask < 32; mask++) {
  const enabled = [...Array(5)].map((_, i) => Boolean(mask & (1 << i)));
  [ctx.canvasModeEnabled, ctx.developerAgentEnabled, ctx.thinkModeEnabled, ctx.webSearchEnabled, context] = enabled;
  ctx.updateInputActionChips();
  ['Canvas','Agent','Think','WebSearch','Context'].forEach((name, i) => assert.equal(ctx[`menu${name}Btn`].attributes['aria-pressed'], String(enabled[i])));
}
vm.runInContext(source.match(/^function isCurrentArtifact\([^]*?^}/m)[0], ctx);
vm.runInContext(source.match(/^function addCanvasArtifacts\([^]*?^}/m)[0], ctx);
ctx.addCanvasArtifacts('qa', [{ name: 'Guide', content: 'Document one', format: 'text' }, { name: 'Example', content: 'console.log(1)', format: 'code' }], 10);
ctx.addCanvasArtifacts('qa', [{ name: 'Checklist', content: 'Document two', format: 'text' }], 20);
assert.equal(ctx.artifacts.length, 3);
assert.equal(ctx.artifacts[0].content, 'Document one');
assert.equal(ctx.artifacts[1].canvasFormat, 'code');
assert.deepEqual(Array.from(ctx.artifacts, item => item.messageTs), [10, 10, 20]);
const renderer = fs.readFileSync('ui/chat-renderer.js', 'utf8');
const populate = renderer.slice(renderer.indexOf('function populateAssistantBubble('), renderer.indexOf('function populateAssistantBubble(') + 8500);
assert.ok(populate.indexOf('buildThinkingPanel(') < populate.indexOf('buildWebSearchRow('));
assert.ok(populate.indexOf('buildWebSearchRow(') < populate.indexOf('if (options.showCanvasLoader)'));
const prompt = fs.readFileSync('ui/prompt-core.js', 'utf8');
assert.ok(prompt.includes('Multiple distinct artifacts may share one response and one chat'));
assert.ok(!prompt.includes('Then output one non-empty <AIcanvas'));
console.log('PASS: all 32 selection combinations; distinct text/code artifacts across turns; Thinking → Search → Canvas presentation');
