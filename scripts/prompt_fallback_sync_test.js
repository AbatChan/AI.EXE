// Prompt .md files and their prompt-core.js fallbacks must stay byte-identical.
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const src=fs.readFileSync(path.join(root,'ui/prompt-core.js'),'utf8');
const s=src.indexOf('const promptTemplateDefaults = {')+'const promptTemplateDefaults = '.length;
let d=0,e=s;for(;e<src.length;e++){if(src[e]==='{')d++;else if(src[e]==='}'){d--;if(!d)break;}}
const T=eval('('+src.slice(s,e+1)+')');let bad=0;
for(const [name,text] of Object.entries(T)){const md=path.join(root,'ui/prompts',name+'.md');if(!fs.existsSync(md)){console.log('no md',name);continue;}
 const file=fs.readFileSync(md,'utf8').replace(/\n$/,'');
 if(text===file){console.log('same',name);continue;} bad++;console.log('DIFF',name);
 const a=text.split('\n'),b=file.split('\n');for(let i=0;i<Math.max(a.length,b.length);i++)if(a[i]!==b[i]){console.log(' js:',String(a[i]).slice(0,200));console.log(' md:',String(b[i]).slice(0,200));break;}}
if(bad){console.error('FAIL: prompt fallbacks drifted from ui/prompts/*.md');process.exit(1);}console.log('PASS: prompt fallbacks match their .md files');
