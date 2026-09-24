const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('ui/ai-exe.js','utf8');
const encoder=new TextEncoder();
let sent, chunks=[],reads=0;
const events=[{choices:[{delta:{reasoning_content:'Reason <thinking>quoted</thinking> completely.',content:'Final answer.'}}]},{choices:[{delta:{},finish_reason:'stop'}]}];
const ctx={AbortController,TextDecoder,Date,remoteProvidersEnabled:true,
 getInferenceProviderDef:()=>({label:'test'}),getProviderApiKey:()=> 'fixture',getProviderModel:()=> 'fixture',getProviderEndpoint:()=> 'https://example.invalid',shouldUseNativeCustomOpenAiRelay:()=>false,
 buildApiMessagePayloadFromPrompt:()=>({messages:[{role:'user',content:'Task'}]}),adaptOpenAiRequest:(_p,r)=>r,getOpenAiCompatibleAuthHeader:()=> 'fixture',
 fetch:async(_u,o)=>{sent=JSON.parse(o.body);return {ok:true,body:{getReader:()=>({read:async()=>reads++?{done:true}:{done:false,value:encoder.encode(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''))}})}};}
};vm.createContext(ctx);vm.runInContext(src.match(/^function applyThinkingMode\([^]*?^}/m)[0],ctx);vm.runInContext(src.match(/^async function streamOpenAiCompatibleChatCompletion\([^]*?^}/m)[0],ctx);
(async()=>{const res=await ctx.streamOpenAiCompatibleChatCompletion('deepseek','Task',{onDelta:x=>chunks.push(x)},{thinkActive:true});assert.equal(res.ok,true);assert.equal(sent.thinking.type,'enabled');assert.equal(res.output,'<native_thinking>Reason <thinking>quoted</thinking> completely.</native_thinking>Final answer.');assert.equal(chunks.join(''),res.output);console.log('PASS: native reasoning and answer in same SSE frame both preserved, isolated wrapper');})().catch(e=>{console.error(e);process.exitCode=1;});
