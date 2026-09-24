const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const ctx={window:{}}; vm.createContext(ctx); vm.runInContext(fs.readFileSync('ui/chat-renderer.js','utf8'),ctx);
const api=ctx.window.AIExeChatRenderer.createChatRenderer({});
const long='Reasoning detail. '.repeat(1000);
for(const raw of ['<thinking>'+long+'</thinking>Answer','<native_thinking>'+long+'<thinking>quoted tags</thinking>More</native_thinking>Answer','<thinking>outer<thinking>inner</thinking>tail</thinking>Answer']) {
 const state=api.buildThinkingState(raw);assert.equal(state.displayText,'Answer');assert.equal(state.inProgress,false);
}
assert.equal(api.buildThinkingState('<native_thinking>'+long).text,long.trim());
assert.equal(api.buildThinkingState('<native_thinking>'+long).displayText,'');
assert.equal(api.normalizeAgentActivities([{kind:'reasoning',detail:long,status:'done'}])[0].detail,long.trim());
const src=fs.readFileSync('ui/ai-exe.js','utf8');
vm.runInContext(src.match(/^function applyThinkingMode\([^]*?^}/m)[0],ctx);
assert.equal(ctx.applyThinkingMode('deepseek',{},true).thinking.type,'enabled');
assert.equal(ctx.applyThinkingMode('deepseek',{},false).thinking.type,'disabled');
assert.equal(ctx.applyThinkingMode('venice',{},true).venice_parameters.strip_thinking_response,false);
assert.ok(!src.includes('surface the thinking text itself as the answer'));
console.log('PASS: long thoughts preserved, native/nested boundaries, unfinished thoughts hidden, explicit provider switches');

const renderSource=fs.readFileSync('ui/chat-renderer.js','utf8');
vm.runInContext(renderSource.match(/    function groupToolRuns\([^]*?\n    }/)[0],ctx);
const groups=ctx.groupToolRuns([{kind:'reasoning',detail:long},{kind:'read',title:'Read result.txt'}]);
assert.equal(groups.length,2);assert.equal(groups[0].phase,'other');assert.equal(groups[1].phase,'run');
console.log('PASS: Thinking precedes tool groups rather than being folded inside one');
