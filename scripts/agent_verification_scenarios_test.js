const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
global.window = global;
global.eslint = require('../ui/vendor/eslint/linter.js');
require('../ui/agent-executor.js');
const executor = AIExeAgentExecutor.createAgentExecutor({ normalizeWorkspacePath: p => p });
for (const source of ['import { x } from "./dep.js";\nconst x = 1;', 'export const x = ;']) {
  assert.match(executor.getStructuralIssueForPath('/x.js', source), /syntax error/);
}
for (const source of ['import { x } from "./dep.js"; export { x };', 'const label = `hello\nexport default world\n`; export { label };', 'export const pattern = /[(){}]/;']) {
  assert.equal(executor.getStructuralIssueForPath('/x.js', source), '');
}
const ui = fs.readFileSync('ui/ai-exe.js','utf8');
const planner = fs.readFileSync('ui/agent-planner.js','utf8');
const extract = (src, start, end) => src.slice(src.indexOf(start),src.indexOf(end,src.indexOf(start)));
const views = vm.runInNewContext(extract(planner,'function buildOpenFileViews(', '    function buildAgentEvidenceLedger')+';buildOpenFileViews',{normalizeWorkspacePath:p=>p});
require('../ui/agent-loop.js');
const content = Array.from({length:300},(_,i)=>`${i} ${'x'.repeat(65)}`).join('\n');
const events = [{tool:'read_file',ok:true,path:'/x.js',startLine:1,endLine:300,content}];
const clipped = views(events,700);
assert.equal(AIExeAgentLoop.evaluateRepeatedRead(events,'/x.js','1:300:0',6,clipped.visibleRanges),null);
assert.equal(AIExeAgentLoop.evaluateRepeatedRead(events,'/x.js','1:300:0',6,views(events,30000).visibleRanges),'exact-repeat');
assert.equal(AIExeAgentLoop.evaluateRepeatedRead(events,'/x.js','250:280:0',6,clipped.visibleRanges),null);
const refocused = views([...events, {tool:'read_file',ok:true,path:'/x.js',startLine:250,endLine:255,content}], 700);
assert.match(refocused.text, /250\|/);
assert.equal(AIExeAgentLoop.evaluateRepeatedRead(events,'/x.js','250:255:0',6,refocused.visibleRanges),'subset-of-recent-read');
const runnerSource=extract(ui,'function aiexeRunSmokeChecks(', 'async function runWorkspaceAppSmokeTest');
{
 const queue=[], events=[];
 const input={tagName:'INPUT',value:'1',focus(){},dispatchEvent(e){events.push(e.type);}};
 const select={tagName:'SELECT',value:'T',options:[{value:'T'},{value:'M'},{value:'X',disabled:true}],focus(){},dispatchEvent(e){events.push(e.type);}};
 const ctx={document:{querySelector:s=>s==='#qty'?input:s==='#sku'?select:null},setTimeout:fn=>queue.push(fn),Event:class{constructor(type){this.type=type;}}};
 const run=vm.runInNewContext(runnerSource+';aiexeRunSmokeChecks',ctx);
 let results;
 run([{fill:'#qty',text:'2'},{select:'#sku',value:'M'},{select:'#sku',value:'X'},{fill:'#qty',text:'9',expect:'#qty'},{expect:'#qty',text:'2'}],()=>{},r=>results=r);
 while(queue.length) queue.shift()();
 assert.equal(input.value,'2');
 assert.equal(select.value,'M');
 assert.deepEqual(events,['input','change','input','change']);
 assert.deepEqual(Array.from(results,r=>r[0]),['✓','✓','✗','✗','✓']);
 console.log('PASS: fill replaces values, select dispatches changes, disabled options and combined steps fail');
}
async function runAssertion(readyAfter) {
  let now=100,queue=[],result;
  const target={tagName:'DIV',get innerText(){return now>=100+readyAfter?'Saved':'Saving';}};
  const ctx={document:{querySelector:()=>target},Date:{now:()=>now},setTimeout:fn=>queue.push(fn)};
  const run=vm.runInNewContext(runnerSource+';aiexeRunSmokeChecks',ctx);
  run([{expect:'#status',text:'Saved'}],()=>{},r=>result=r);
  while(queue.length){now+=40;queue.shift()();}
  return result;
}
(async()=>{
 assert.match((await runAssertion(300))[0],/^✓/);
 assert.match((await runAssertion(2000))[0],/^✗/);
 // An unrelated iframe cannot finish or poison this run.
 let listener; const own={}; const iframe={contentWindow:own,style:{},setAttribute(){},remove(){}};
 const html='<html><head><script src="app.js" defer></script></head><body><button id="add">Add</button></body></html>';
 const ctx={normalizeWorkspacePath:p=>p,parentWorkspacePath:()=> '/',invokeWorkspaceAction:async(_,o)=>({ok:true,output:o.path==='/index.html'?html:'/*\nexport documentation\n*/\nconst x = ;'}),aiexeRunSmokeChecks:()=>{},mapSmokeStackToSource:()=>'',document:{createElement:()=>iframe,body:{appendChild(){}}},window:{addEventListener:(_,fn)=>listener=fn,removeEventListener(){},setTimeout(){}},console};
 const smoke=vm.runInNewContext(extract(ui,'async function runWorkspaceAppSmokeTest','function buildContinuationPrompt')+';runWorkspaceAppSmokeTest',ctx);
 const promise=smoke('/index.html');
 await new Promise(r=>setImmediate(r));
 assert.ok(iframe.srcdoc.indexOf('//@aiexe-src /app.js') > iframe.srcdoc.indexOf('<button id="add">'), 'deferred code stays after DOM');
 listener({source:{},data:{__aiexeSmoke:true,text:'FOREIGN'}});
 listener({source:own,data:{__aiexeSmoke:true,text:'Unexpected token ;'}});
 ctx.window.setTimeout=fn=>fn();
 listener({source:own,data:{__aiexeSmokeDone:true}});
 const result=await promise;
 assert.deepEqual(Array.from(result.errors),['Unexpected token ;']);
 console.log('PASS: original module parsing, visible-context rereads, delayed assertions, preserved errors and isolated smoke messages');
})().catch(e=>{console.error(e);process.exitCode=1;});
