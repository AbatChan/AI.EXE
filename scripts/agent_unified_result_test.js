'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const commit = source.match(/^function commitAssistantMessage\([^]*?^}/m)[0];
const messages = [];
const artifact = { chatId: 'qa', name: 'Handoff', messageTs: 0 };
const token = { chatId: 'qa', agentResultArtifacts: ['Handoff'], agentWebSearchEvent: { ok: true, sources: [{url:'https://example.org'}] } };
const noop = () => {};
const ctx = {
 activeInferenceRequest: token, artifacts: [artifact], activeStreamRow: null,
 activeStreamRawText: '', activeStreamText: '', activeChatId: 'qa', inNewChatMode: false,
 cancelLiveStreamRender: noop, resetActiveAgentStreamState: noop,
 buildThinkingState: () => ({text:''}), extractCanvasBlocksFromReply: () => ({payloads:[],displayText:'Done'}),
 appendMessageToChat: (id,role,text,_n,opts) => {const m={id,role,text,ts:42,...opts};messages.push(m);return m;},
 resolveChatNamingFallback: noop, nowTs: () => 42, addCodeArtifacts: () => [],
 saveArtifacts: noop, renderSidebarCounts: noop, renderActiveChat: noop,
 isCurrentArtifact: (item) => Boolean(item) && !item.superseded,
};
vm.createContext(ctx); vm.runInContext(commit,ctx);
ctx.commitAssistantMessage('qa','Verified result','Verified result',{agentActivities:[{title:'Created file'}]});
assert.equal(messages.length,1);
assert.equal(messages[0].text,'Verified result');
assert.equal(messages[0].webSearch.sources.length,1);
assert.equal(messages[0].agentActivities.length,1);
assert.equal(artifact.messageTs,messages[0].ts);
assert.equal(token.agentResultArtifacts.length,0);
const canvas = source.slice(source.indexOf('    createAgentCanvas:'),source.indexOf('    getWorkspaceContext,',source.indexOf('    createAgentCanvas:')));
assert.doesNotMatch(canvas,/commitAssistantMessage/);
const search = source.slice(source.indexOf('async function requestSelectedDeveloperAgentReply'),source.indexOf('// Mark Continue/Retry/resume'));
assert.doesNotMatch(search,/commitAssistantMessage/);
console.log('PASS: search, activities and Canvas belong to one assistant result');
