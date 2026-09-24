const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
global.window=global;require('../ui/agent-core.js');require('../ui/agent-executor.js');
const core=AIExeAgentCore.createAgentCore({normalizeWorkspacePath:p=>p});
const decision=core.parseAgentDecision(JSON.stringify({action:'tool',tool:'web_search',query:'MDN private localStorage lifetime'}));
assert.equal(decision.query,'MDN private localStorage lifetime');
let seen='';
const executor=AIExeAgentExecutor.createAgentExecutor({searchAgentWeb:async(_id,q)=>{seen=q;return {ok:true,observation:'Sourced fact'};},getWorkspaceContext:()=>{throw Error('Search must not need workspace');}});
const source=fs.readFileSync('ui/ai-exe.js','utf8');
const fn=source.match(/^async function decideTurnModes\([^]*?^}/m)[0];
let reply={}, calls=0;
const ctx={webSearchAvailable:()=>true,getChatDebugSnapshot:()=>[],recordDebugTrace:()=>{},
 requestSelectedRemoteTextCompletion:async()=>{calls+=1;return {ok:true,output:JSON.stringify(reply)};},
 extractFirstJsonObject:(t)=>{try{return JSON.parse(t);}catch(_){return null;}}};
vm.createContext(ctx);vm.runInContext(fn,ctx);
const off={search:false,canvas:false,think:false,agent:false};
const pick=(m)=>({search:m.search,canvas:m.canvas,think:m.think,agent:m.agent});
const plan=async(toggles,r)=>{reply=r;return pick(JSON.parse(JSON.stringify(await ctx.decideTurnModes('qa','x',toggles))));};
(async()=>{
 assert.equal((await executor.executeDeveloperToolCall('qa',decision,'Research online')).ok,true);assert.equal(seen,decision.query);
 // OFF: search and canvas are the model's call.
 assert.deepEqual(await plan(off,{search:true,canvas:true,think:false,agent:false}),{search:true,canvas:true,think:false,agent:false});
 // OFF: think/agent only when the model reports the user asked.
 assert.deepEqual(await plan(off,{search:false,canvas:false,think:true,agent:true}),{search:false,canvas:false,think:true,agent:true});
 // ON: think/agent stay on whatever the model says; search/canvas on unless opted out.
 assert.deepEqual(await plan({search:true,canvas:true,think:true,agent:false},{search:false,canvas:false,think:false,agent:false}),{search:false,canvas:false,think:true,agent:false});
 assert.deepEqual(await plan({search:true,canvas:true,think:false,agent:false},{}),{search:true,canvas:true,think:false,agent:false});
 // App context flags come from the same plan.
 reply={trading:true,past_work:true};{const m=await ctx.decideTurnModes('qa','x',off);assert.equal(m.trading,true);assert.equal(m.pastWork,true);}
 // Unparseable reply keeps the toggles.
 ctx.requestSelectedRemoteTextCompletion=async()=>({ok:true,output:'nope'});
 assert.deepEqual(pick(JSON.parse(JSON.stringify(await ctx.decideTurnModes('qa','x',{search:false,canvas:true,think:false,agent:false})))),{search:false,canvas:true,think:false,agent:false});
 // Search unavailable is never planned.
 ctx.requestSelectedRemoteTextCompletion=async()=>({ok:true,output:JSON.stringify({search:true})});ctx.webSearchAvailable=()=>false;
 assert.equal((await ctx.decideTurnModes('qa','x',off)).search,false);
 // Everything already on: no model call.
 calls=0;ctx.webSearchAvailable=()=>true;ctx.requestSelectedRemoteTextCompletion=async()=>{calls+=1;return {ok:false};};
 await ctx.decideTurnModes('qa','x',{search:true,canvas:false,think:true,agent:true});assert.equal(calls,0);
 console.log('PASS: per-reply capability plan (auto search/canvas, asked-for think/agent, toggles stick) and workspace-independent Agent search');
})().catch(e=>{console.error(e);process.exitCode=1;});
