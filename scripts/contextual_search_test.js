const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('ui/ai-exe.js','utf8');
const fn=source.match(/^async function fetchWebFindings\([^]*?^}/m)[0];
let extractedPrompt='', sent='', research={query:'React 19 hydration mismatch official fix',time_sensitive:false};
const ctx={
 getProviderApiKey:()=> 'fixture',getProviderEndpoint:()=> 'https://example.invalid',getProviderModel:()=> 'fixture',getOpenAiCompatibleAuthHeader:()=> 'fixture',
 getChatDebugSnapshot:()=> [{role:'user',text:'React 19.1, Node 22: Hydration failed because the server rendered HTML did not match the client.'}],
 requestSelectedRemoteTextCompletion:async p=>{extractedPrompt=p;return {ok:true,output:JSON.stringify(research)};},extractFirstJsonObject:JSON.parse,recordDebugTrace:()=>{},
 fetch:async(_u,opts)=>{sent=JSON.parse(opts.body).messages[1].content;return {ok:true,json:async()=>({choices:[{message:{content:'Sourced facts'}}],venice_parameters:{web_search_citations:[]}})};}
};
vm.createContext(ctx);vm.runInContext(fn,ctx);
(async()=>{
 await ctx.fetchWebFindings('Check online for a fix',null,{chatId:'qa',toolContext:'Node 22; existing useEffect workaround failed'});
 assert.match(extractedPrompt,/React 19.1/);assert.match(extractedPrompt,/Hydration failed/);assert.match(extractedPrompt,/workaround failed/);
 assert.equal(sent,research.query);
 research={query:'Crypto market price returns and volume',time_sensitive:true,time_window:'last 24 hours'};
 const result=await ctx.fetchWebFindings('What is trending and winning rn?',null,{chatId:'qa'});
 assert.ok(sent.includes(new Date().toISOString().slice(0,10)));assert.match(sent,/last 24 hours/);assert.equal(result.query,research.query,'shown query stays clean; date scope only goes to the search model');
 research={query:'Bitcoin return January 2021',time_sensitive:false};await ctx.fetchWebFindings('Compare January 2021',null,{chatId:'qa'});assert.equal(sent,research.query);
 console.log('PASS: follow-up context, date and time window, historical scope, clean displayed query');
})().catch(e=>{console.error(e);process.exitCode=1;});
