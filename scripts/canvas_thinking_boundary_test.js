const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {}, canvasModeEnabled: true };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('ui/chat-renderer.js', 'utf8'), ctx);
const renderer = ctx.window.AIExeChatRenderer.createChatRenderer({});
ctx.buildThinkingState = renderer.buildThinkingState;
const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
vm.runInContext(source.match(/^function extractCanvasBlocksFromReply\([^]*?^}/m)[0], ctx);
const example = '<AIcanvas title="..." type="text">...</AIcanvas>';
const jsonExample = '<AIcanvasJSON>{"name":"Example","content":"not an artifact"}</AIcanvasJSON>';
const answer = 'Here is the story.\n<AIcanvas title="Story" type="text">Once upon a time.</AIcanvas>\nThe end.';
for (const tag of ['native_thinking', 'thinking', 'think']) {
  const thought = `<${tag}>Consider ${example} and ${jsonExample}. Then write the story.</${tag}>`;
  const parsed = ctx.extractCanvasBlocksFromReply(thought + answer);
  assert.equal(parsed.payloads.length, 1);
  assert.equal(parsed.payloads[0].name, 'Story');
  assert.equal(parsed.payloads[0].content, 'Once upon a time.');
  assert.equal(parsed.displayText, 'Here is the story.\n\nThe end.');
  assert.equal(renderer.hasCanvasTokenStarted(thought), false);
  for (let end = 1; end <= thought.length; end++) {
    const partial = thought.slice(0, end);
    assert.equal(ctx.extractCanvasBlocksFromReply(partial).payloads.length, 0);
    assert.equal(renderer.hasCanvasTokenStarted(partial), false);
  }
}
assert.equal(renderer.hasCanvasTokenStarted('<native_thinking>Plan</native_thinking><AIcanvas title="Story">'), true);
const chained = '<native_thinking>Assess ' + example + '</native_thinking><native_thinking>Draft ' + example + '</native_thinking>';
assert.equal(ctx.extractCanvasBlocksFromReply(chained + answer).payloads.length, 1);
assert.ok(source.includes('addCodeArtifacts(chatId, parsed.displayText, messageTs)'));
console.log('PASS: reasoning examples cannot create Canvas/code artifacts or trigger the Canvas loader; visible artifacts remain intact');

vm.runInContext(source.match(/^function extractCodeBlocksFromText\([^]*?^}/m)[0],ctx);
const docWithExample=ctx.extractCanvasBlocksFromReply('<AIcanvas title="Guide">Use this example:\n```js\ntry { localStorage.setItem("x","1"); } catch {}\n```\n</AIcanvas>');
assert.equal(docWithExample.payloads.length,1);
assert.equal(ctx.extractCodeBlocksFromText(docWithExample.displayText).length,0);
const separate=ctx.extractCanvasBlocksFromReply('<AIcanvas title="Guide">A guide</AIcanvas>\n```js\nconsole.log("separate requested code");\n```');
assert.equal(ctx.extractCodeBlocksFromText(separate.displayText).length,1);
console.log('PASS: embedded Canvas examples stay in the document; separate code remains extractable');
