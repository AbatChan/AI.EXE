const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const storage = new Map(), calls = [];
const thread = { id: 'branch-a', messages: [] }, other = { id: 'branch-b', messages: [] };
const chat = { id: 'chat-a', activeThreadId: thread.id, threads: [thread, other], messages: thread.messages };
const ctx = { Date, JSON, String, Number, Boolean, localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
  scopedStorageKey: key => key + ':test-user', findChatById: id => id === chat.id ? chat : null,
  activeAgentStreamState: null, activeStreamRawText: '<AIcanvas title="Draft">Unfinished paragraph',
  buildThinkingState: text => ({ displayText: text }), activeInferenceRequest: { chatId: chat.id, threadId: thread.id, startedAt: 100, initialThinking: 'Consider the request.' },
  getChatActiveThread: () => chat.threads.find(t => t.id === chat.activeThreadId), syncChatFromThread: (c,t) => { c.activeThreadId=t.id; c.messages=t.messages; },
  commitInterruptedAgentRun: () => false, sanitizeAssistantText: t => t,
  commitAssistantMessage: (id,text,raw,options) => { calls.push({id,text,raw,options}); chat.messages.push({role:'ai',ts:Date.now(),text}); },
  saveChats() {}, showComposerNotice: message => calls.push({warning:message}),
};
vm.createContext(ctx);
for (const name of ['captureResponseCheckpoint','persistResponseCheckpoint','clearResponseCheckpoint','commitResponseCheckpoint','recoverResponseCheckpoint']) vm.runInContext(source.match(new RegExp('^function '+name+'\\([^]*?^}', 'm'))[0],ctx);
ctx.persistResponseCheckpoint(); assert.equal(storage.size,1);
const snapshot = JSON.parse([...storage.values()][0]); assert.equal(snapshot.answer,ctx.activeStreamRawText);
ctx.activeInferenceRequest = null; chat.activeThreadId=other.id; chat.messages=other.messages;
ctx.recoverResponseCheckpoint(); assert.equal(storage.size,0); assert.equal(calls.length,1);
assert.match(calls[0].raw, /Draft \(unfinished\)/); assert.match(calls[0].raw, /Unfinished paragraph<\/AIcanvas>/);
assert.match(calls[0].text,/Session interrupted/); assert.equal(calls[0].options.forceNeedsContinue,true);
assert.equal(chat.activeThreadId,other.id); assert.equal(thread.messages.length,1); assert.equal(other.messages.length,0);
storage.set('aiexe_response_checkpoint_v1:test-user',JSON.stringify(snapshot));ctx.recoverResponseCheckpoint();assert.equal(calls.length,1);
thread.messages=[];chat.activeThreadId=thread.id;chat.messages=thread.messages;
ctx.commitResponseCheckpoint({...snapshot,answer:'',webSearch:{pending:true,sources:[]}},'Interrupted by you.');assert.match(calls[1].text,/Interrupted by you/);
assert.equal(calls[1].options.webSearch.pending,false);assert.equal(calls[1].options.webSearch.failed,true);
const continuationCalls=[];
ctx.buildContinuationPrompt=()=>'Resume';ctx.setChatAutoContinuing=()=>{};ctx.requestAssistantReply=(...args)=>continuationCalls.push(args);
vm.runInContext(source.match(/^function startAssistantContinuation\([^]*?^}/m)[0],ctx);
ctx.startAssistantContinuation(chat.id,{appendToLastAssistant:false});
assert.equal(continuationCalls[0][3].appendToLastAssistant,false);
ctx.findLastAssistantMessage=()=>({ts:300,text:'Interrupted.'});ctx.continuationTailChars=1000;
ctx.artifacts=[{chatId:chat.id,messageTs:300,name:'Saved draft',content:'Previously written paragraph'},
  {chatId:'different-chat',messageTs:300,name:'Private draft',content:'UNRELATED'}];
vm.runInContext(source.match(/^function buildContinuationPrompt\([^]*?^}/m)[0],ctx);
const resumePrompt=ctx.buildContinuationPrompt(chat.id);
assert.match(resumePrompt,/Previously written paragraph/);assert.doesNotMatch(resumePrompt,/UNRELATED/);
const token={chatId:chat.id,startedAt:200};storage.set('aiexe_response_checkpoint_v1:test-user',JSON.stringify({...snapshot,startedAt:201}));ctx.clearResponseCheckpoint(token);assert.equal(storage.size,1);
ctx.clearResponseCheckpoint({...token,startedAt:201});assert.equal(storage.size,0);
console.log('PASS: durable partial Canvas checkpoint, labelled interruption, Continue state, correct branch, idempotent recovery and request-owned cleanup');

const interruptedCommits=[];
const agentCtx={Date,String,Boolean,Array,activeAgentStreamState:null,
 cloneAgentActivities:rows=>JSON.parse(JSON.stringify(rows)),mergeAgentActivityIntoList:(rows,row)=>rows.push(row),
 commitAssistantMessage:(...args)=>interruptedCommits.push(args),pushDebugTrace:()=>{}};
vm.runInNewContext(source.match(/^function commitInterruptedAgentRun\([^]*?^}/m)[0]+`;commitInterruptedAgentRun('qa','Interrupted by you · Progress saved',{chatId:'qa',startedAt:1,activities:[{kind:'read',status:'done'},{kind:'command',status:'error'},{kind:'reasoning',status:'running'}]});`,agentCtx);
const activity=interruptedCommits[0][3].agentActivities;
assert.equal(activity[0].status,'done');assert.equal(activity[1].status,'error');assert.equal(activity[2].status,'paused');
assert.equal(activity[3].kind,'interruption');assert.equal(activity[3].status,'paused');
assert.match(interruptedCommits[0][3].interruptionNotice,/Interrupted by you/);
console.log('PASS: interruption is neutral, active steps stop, completed work and genuine errors retain status');

const rendererCtx={window:{}};vm.runInNewContext(fs.readFileSync('ui/chat-renderer.js','utf8'),rendererCtx);
const renderer=rendererCtx.window.AIExeChatRenderer.createChatRenderer({});
const normalized=renderer.normalizeAgentActivities([{kind:'interruption',title:'Interrupted',status:'paused'},{kind:'command',title:'Failed',status:'error'}]);
assert.equal(normalized[0].status,'paused');assert.equal(normalized[1].status,'error');
assert.match(source,/interruptionNotice: m.role === 'ai'/);
console.log('PASS: paused status and notice survive storage normalization');
