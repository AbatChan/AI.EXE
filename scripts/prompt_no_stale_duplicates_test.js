// Cube run: every step carried stale earlier copies of app.js plus a blocked read re-pasting it.
const assert=require('node:assert/strict');
const path=require('path'); global.window=global;
const root=path.join(__dirname,'..');
require(path.join(root,'ui','prompt-core.js'));
require(path.join(root,'ui','agent-planner.js'));
const norm=(p)=>{let s=String(p||'').trim();if(!s.startsWith('/'))s='/'+s;return s.replace(/\/+/g,'/');};
const planner=global.AIExeAgentPlanner.createAgentPlanner({normalizeWorkspacePath:norm,buildAgentHistoryTranscript:()=>'',getWorkspaceFileTreeSummary:async()=>'',loadPromptTemplate:async()=>'T',renderPromptTemplate:(t,v)=>Object.entries(v||{}).map(([k,x])=>k+':'+x).join('\n'),getWorkspaceContext:()=>({}),isAgentTaskGameLike:()=>false,hasReadmeRunInstructions:()=>false,isLikelyCompleteReadme:()=>false,isExplicitReadmeOrDocsTask:()=>false,buildAgentFileGenerationHints:()=>'',deriveProjectNameFromTask:()=>'x'});
const big=(tag)=>Array.from({length:120},(_,i)=>`const ${tag}${i} = ${i}; // line ${i}`).join('\n');
const oldApp=big('old'), newApp=big('cur');
const pad=Array.from({length:14},(_,i)=>({tool:'check_code',ok:true,path:'/',observation:'check_code ok '+i}));
const events=[
 {tool:'read_file',ok:true,path:'/js/app.js',content:oldApp,observation:'read_file /js/app.js\n'+oldApp},
 ...pad,
 {tool:'edit_file',ok:true,path:'/js/app.js',content:newApp,observation:'edit_file ok: /js/app.js'},
 {tool:'read_file',ok:true,path:'/js/app.js',content:newApp,observation:'read_file /js/app.js\n'+newApp},
 {tool:'read_file',ok:false,path:'/js/app.js',observation:'read_file blocked for /js/app.js: it was already read and nothing changed since. Its content is repeated below — do NOT read it again; make the edit or take the next corrective step.\n\nCurrent content of /js/app.js:\n'+newApp+'\n\nESCALATION: this is repeat #2 of the same call.'},
];
planner.buildAgentDecisionPrompt('c1','fix the app.js scramble',events,20,{affectedFiles:['/js/app.js'],filesToInspect:['/js/app.js'],expectedFiles:[]}).then((p)=>{
  const t=typeof p==='string'?p:(p.prompt||JSON.stringify(p));
  assert.equal((t.match(/const old5 =/g)||[]).length,0,'stale pre-edit copy is not carried');
  assert.equal((t.match(/const cur5 =/g)||[]).length,1,'current content appears exactly once (OPEN FILES)');
  assert.match(t,/blocked: unchanged since your last read; its current content is in OPEN FILES above\.\n\nESCALATION/,'blocked read points at OPEN FILES and keeps the escalation');
  console.log('PASS: prompt carries each file once, current, no stale copies');
}).catch((e)=>{console.error(e);process.exit(1);});
