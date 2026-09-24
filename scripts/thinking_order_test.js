const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('ui/ai-exe.js','utf8');
const renderer={window:{}};vm.createContext(renderer);vm.runInContext(fs.readFileSync('ui/chat-renderer.js','utf8'),renderer);
const parse=renderer.window.AIExeChatRenderer.createChatRenderer({}).buildThinkingState;
let enabled=true,active=true,truncated=false,prose=false,received='',calls=[];
const ctx={Date,Boolean,String,Error,AbortController,
 captureChatModes:()=>({think:enabled,agent:false}),
 summarizeThinkingForDisplay:async(_token,text)=>'Summary of the task approach.',recordDebugTrace:()=>{},findChatById:()=>({thinkMode:enabled}),thinkModeEnabled:false,getSelectedInferenceProvider:()=> 'deepseek',
 buildInferencePrompt:async()=>{calls.push('context');return 'Prior user: offline, React 19 hydration bug. Current request: analyze first';},
 isInferenceActive:()=>active,buildThinkingState:parse,developerAgentEnabled:false,isVeniceAdapterSelected:()=>false,
 activeStreamRow:{isConnected:true},scheduleLiveStreamRender:()=>{},createLiveAssistantRow:()=>{},
 streamRemoteChatCompletion:async(_p,p,h,o)=>{calls.push('think');received=p;assert.equal(o.thinkActive,true);assert.equal(o.webSearchActive,false);const output=prose ? '<native_thinking>Check the current task first.</native_thinking>Inspect the file offline.' : '<native_thinking>Consider history and constraints.</native_thinking>{"search":false,"assessment":"Inspect the hydration cause offline."}';h.onDelta(output);return {ok:true,output,truncated};},
 extractFirstJsonObject:s=>{try{return JSON.parse(s);}catch{return null;}},webSearchAvailable:()=>true,consumeLiveAssistantText:()=>{calls.push('clear');}
};vm.createContext(ctx);vm.runInContext(src.match(/^async function thinkBeforeActions\([^]*?^}/m)[0],ctx);
(async()=>{
 const token={webSearchActive:true};await ctx.thinkBeforeActions(token,'qa','Fix this');
 assert.deepEqual(calls,['context','think']);assert.match(received,/React 19/);assert.equal(token.webSearchActive,false);assert.equal(token.initialThinking,'Summary of the task approach.');assert.equal(ctx.activeStreamRawText,'');
 assert.equal(token.thinkingAssessed,true);
 prose=true;const plain={};await ctx.thinkBeforeActions(plain,'qa','Read');assert.equal(plain.initialAssessment,'Inspect the file offline.');assert.equal(plain.thinkingAssessed,undefined);prose=false;
 calls=[];enabled=false;await ctx.thinkBeforeActions({},'qa','Hi');assert.deepEqual(calls,[]);
 enabled=true;truncated=true;await assert.rejects(ctx.thinkBeforeActions({},'qa','Fix'),/Thinking did not finish/);
 truncated=false;active=false;const cancelled={};await ctx.thinkBeforeActions(cancelled,'qa','Fix');assert.equal(cancelled.thinkingAssessed,undefined);
 // Capability plan, then Thinking, then routing.
 const plan=src.indexOf('await decideTurnModes(chatId, promptText, modes)'), think=src.indexOf('await thinkBeforeActions(requestToken, chatId, promptText)'), route=src.indexOf('await requestPreflightRouteDecision(', think);
 assert.ok(plan>0&&plan<think&&think<route,'plan → think → route');
 console.log('PASS: history considered before routing, no research in assessment, offline decision, mode off, cancellation and incomplete thinking');
})().catch(e=>{console.error(e);process.exitCode=1;});
