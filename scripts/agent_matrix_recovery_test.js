const assert = require('node:assert/strict');
global.window = global;
require('../ui/agent-core.js');
require('../ui/agent-executor.js');
require('../ui/agent-runtime.js');
const norm = p => '/' + String(p || '').replace(/^\/+/, '');
const ws = {workspaceRootName:'previous',rootLoaded:true,currentPath:'/',rootEntryCount:1};
const core = AIExeAgentCore.createAgentCore({normalizeWorkspacePath:norm,normalizeWorkspaceName:s=>s,getWorkspaceContext:()=>ws,looksLikePlaceholderImplementation:()=>false});
const plan = core.normalizeAgentPlanSpec({task_kind:'edit',workspace:'current',expected_files:['/index.html']}, 'Create a NEW isolated project Matrix Six', {forceProjectScope:true});
assert.equal(plan.taskKind,'project');
assert.equal(plan.workspaceIntent,'new');
assert.equal(core.parseAgentDecision('```json\n{"action":"tool","tool":"create_canvas","path":"Handoff","content":"Verified total: 380"}\n```').tool,'create_canvas');
let writes = 0; let canvas = null;
const executor = AIExeAgentExecutor.createAgentExecutor({
 normalizeWorkspacePath:norm,getWorkspaceContext:()=>ws,
 requestWorkspaceStatusSnapshot:async()=>({ok:true,rootName:'previous',currentPath:'/'}),
 invokeWorkspaceAction:async()=>{writes++;throw Error('Must not reach previous workspace');},
 createAgentCanvas:async(chatId,name,content)=>{canvas={chatId,name,content};return true;}
});
(async()=>{
 for(const tool of ['write_file','write_files','edit_file','generate_project','mkdir','move','delete','run_command','run_app']) {
  const r=await executor.executeDeveloperToolCall('test',{tool,path:'/index.html'},'New isolated project',[],plan,{approvedNewProject:true});
  assert.equal(r.ok,false,tool);assert.match(r.observation,/NEW workspace/,tool);
 }
 assert.equal(writes,0);
 const r=await executor.executeDeveloperToolCall('test',{tool:'create_canvas',path:'Handoff',content:'Verified total: 380'},'Create a Canvas handoff');
 assert.equal(r.ok,true); assert.deepEqual(canvas,{chatId:'test',name:'Handoff',content:'Verified total: 380'});assert.equal(writes,0);
 const rt=AIExeAgentRuntime.createAgentRuntime({});
 assert.equal(rt.looksTruncatedFileContent('# Handoff\n'+'Verified values and unverified checks '.repeat(30),'handoff.md'),false);
 console.log('PASS: new scope survives planning, previous workspace cannot mutate, real Canvas tool, prose does not trigger continuations');
})().catch(e=>{console.error(e);process.exitCode=1;});
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('ui/ai-exe.js','utf8');
const ctx = {activeInferenceRequest:{tradingContextEnabled:false}};
vm.createContext(ctx);
for(const name of ['buildLiveContext','buildLiveReminder']) {
 const fn=source.match(new RegExp('^function '+name+'\\([^]*?^}', 'm'))[0];
 vm.runInContext(fn,ctx);
 const out=String(ctx[name]()||'');
 // General live cards are fine; the autopilot account and its actions are not.
 assert.doesNotMatch(out,/card:trading|card:portfolio|card:action|Ambient app data|\$\d/,'Unrelated turn must not access account data');
}
assert.match(source,/requestToken\.approvedNewProject = requestToken\.approvedNewProject \|\| Boolean\(preflightDecision\.shouldCreateProject\)/);
assert.equal(core.deriveFallbackAgentDecision('Create a project',[],plan).tool,'new_project','Initialize requested new workspace before writing');
require('../ui/agent-loop.js');
const honest=AIExeAgentLoop.enforceCriteriaCompletion('All six checks passed!', '\nStill unverified: storage failure', [{tool:'write_file',ok:true,path:'/index.html'}]);
assert.doesNotMatch(honest,/All six checks passed/);
assert.match(honest,/unverified/);
assert.doesNotMatch(honest,/index.html/);
assert.equal(AIExeAgentLoop.enforceCriteriaCompletion('Verified receipt','',[]),'Verified receipt');
const fetchFn=source.match(/^async function fetchWebFindings\([^]*?^}/m)[0];
let sentQuestion='';
const searchCtx={getProviderApiKey:()=> 'test-only',getProviderEndpoint:()=> 'https://example.invalid',getProviderModel:()=> 'fake',getOpenAiCompatibleAuthHeader:()=> 'test-only',requestSelectedRemoteTextCompletion:async()=>({ok:true,output:'{"query":"MDN private localStorage lifetime"}'}),extractFirstJsonObject:JSON.parse,recordDebugTrace:()=>{},fetch:async(_url,options)=>{sentQuestion=JSON.parse(options.body).messages[1].content;return {ok:true,json:async()=>({choices:[{message:{content:'Source facts'}}],venice_parameters:{web_search_citations:[]}})}}};
vm.createContext(searchCtx); vm.runInContext(fetchFn,searchCtx);
searchCtx.fetchWebFindings('Build an app from my CSV; also research MDN private localStorage lifetime').then(r=>{
 assert.equal(r.ok,true);assert.equal(sentQuestion,'MDN private localStorage lifetime');console.log('PASS: search receives only the factual research question');
}).catch(e=>{console.error(e);process.exitCode=1;});
