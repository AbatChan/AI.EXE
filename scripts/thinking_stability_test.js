const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
class Element {
 constructor(tag){this.tagName=tag;this.childNodes=[];this.dataset={};this.style={};this.attributes={};this.className='';this.hidden=false;this.handlers={};this.classList={toggle:(name,on)=>{const c=new Set(this.className.split(' ').filter(Boolean));on?c.add(name):c.delete(name);this.className=[...c].join(' ');},add:name=>this.classList.toggle(name,true)};}
 prepend(n){n.remove();this.childNodes.unshift(n);n.parentNode=this;return n;}
 appendChild(n){n.remove();this.childNodes.push(n);n.parentNode=this;return n;}
 remove(){if(this.parentNode){const a=this.parentNode.childNodes;a.splice(a.indexOf(this),1);this.parentNode=null;}}
 set textContent(t){for(const c of [...this.childNodes])c.remove();this.text=String(t);}
 get textContent(){return this.text||this.childNodes.map(x=>x.textContent).join('');}
 set innerHTML(t){this.textContent=t;}
 setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,v){this.handlers[k]=v;}
 removeEventListener(k){delete this.handlers[k];}
 querySelectorAll(selector){const cls=selector.replace(':scope > ','').slice(1);const immediate=selector.startsWith(':scope');return this.childNodes.flatMap(c=>[...(c.className.split(' ').includes(cls)?[c]:[]),...(!immediate?c.querySelectorAll(selector):[])]);}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
}
const ctx={window:{},document:{createElement:t=>new Element(t)},requestAnimationFrame:fn=>fn()};vm.createContext(ctx);vm.runInContext(fs.readFileSync('ui/chat-renderer.js','utf8'),ctx);const api=ctx.window.AIExeChatRenderer.createChatRenderer({});
const bubble=new Element('div');
api.populateAssistantBubble(bubble,'',{thinkingText:'Initial assessment.',showThinkingLoader:true,thinkingStartedAt:1});
const panel=bubble.querySelector('.msg-thought-panel'),drawer=panel.querySelector('.msg-agent-activity-drawer');
panel.dataset.expanded='false';drawer.hidden=true;
for(let i=0;i<10;i++)api.populateAssistantBubble(bubble,'',{thinkingText:'Initial assessment. '+ 'More. '.repeat(i+1),showThinkingLoader:true,thinkingStartedAt:1});
assert.equal(bubble.querySelector('.msg-thought-panel'),panel);assert.equal(panel.querySelector('.msg-agent-activity-drawer'),drawer);assert.equal(panel.dataset.expanded,'false');assert.equal(drawer.hidden,true);
api.populateAssistantBubble(bubble,'Final result.',{thinkingText:'Initial assessment. Finished.',showThinkingLoader:false,thinkingStartedAt:1,thinkingCompletedAt:2001});
assert.equal(bubble.querySelector('.msg-thought-panel'),panel);assert.equal(bubble.querySelector('.msg-answer').textContent,'Final result.');assert.equal(panel.dataset.expanded,'false');
const src=fs.readFileSync('ui/ai-exe.js','utf8');const handoff=src.match(/^async function thinkBeforeActions\([^]*?^}/m)[0];assert.ok(!handoff.includes('consumeLiveAssistantText()'));
assert.ok(!fs.readFileSync('ui/chat-renderer.js','utf8').includes('Editing this message creates an alternate branch'));
console.log('PASS: stable thought and drawer nodes, collapse preserved across deltas and final answer, no destructive assessment handoff or edit hint');

const canvasBubble=new Element('div');
api.populateAssistantBubble(canvasBubble,'Here is the story.',{showCanvasLoader:true,canvasRawText:'<AIcanvas title="Must stay hidden">'});
const loader=canvasBubble.querySelector('.msg-canvas-loading');
const skeleton=loader.querySelector('.msg-artifact-card-loading');
assert.equal(skeleton.attributes['aria-label'],'Writing document');
assert.equal(skeleton.querySelector('.msg-artifact-title'),null);
for(let i=0;i<10;i++) api.populateAssistantBubble(canvasBubble,'Here is the story.',{showCanvasLoader:true,canvasRawText:'<AIcanvas title="Must stay hidden">Draft '+i});
assert.equal(canvasBubble.querySelector('.msg-canvas-loading'),loader);
assert.equal(canvasBubble.querySelector('.msg-artifact-card-loading'),skeleton);
assert.equal(canvasBubble.querySelectorAll('.msg-canvas-loading').length,1);
assert.equal(canvasBubble.textContent,'Here is the story.');
api.populateAssistantBubble(canvasBubble,'Here is the story.',{});
assert.equal(canvasBubble.querySelector('.msg-canvas-loading'),null);
console.log('PASS: one stable, title-free skeleton card across stream updates; removed on final handoff');

let restored=0, liveChildren=1;
const watchdogSource=src.slice(src.indexOf("setInterval(() => {",src.indexOf('// user-facing choice')),src.indexOf('function setTypingIndicatorLoaderText'));
if (!watchdogSource.includes('typing_indicator_watchdog_restored')) throw new Error('Missing loader watchdog');
const watchdogContext={setInterval:fn=>fn(),pendingInferenceCount:1,activeInferenceRequest:{chatId:'qa'},activeChatId:'qa',document:{getElementById:()=>null},activeStreamRow:{isConnected:true,querySelector:()=>({childNodes:{length:liveChildren}})},shouldSuppressTypingIndicatorForLiveAgent:()=>false,showTypingIndicator:()=>restored++,recordDebugTrace:()=>{}};
vm.runInNewContext(watchdogSource,watchdogContext);assert.equal(restored,0);
liveChildren=0;vm.runInNewContext(watchdogSource,watchdogContext);assert.equal(restored,1);
console.log('PASS: loader watchdog does not duplicate visible progress; restores genuinely missing progress');

const stagedBubble=new Element('div');
const initial={thinkingText:'I will check official guidance before drafting.',thinkingStartedAt:1000,thinkingCompletedAt:6000};
api.populateAssistantBubble(stagedBubble,'',initial);
const initialPanel=stagedBubble.querySelector('.msg-thought-panel');
const initialLabel=initialPanel.querySelector('.msg-thought-summary-label-text').textContent;
api.populateAssistantBubble(stagedBubble,'',{...initial,showPostActionThinkingLoader:true});
const review=stagedBubble.querySelector('.msg-post-action-thinking');
for(let i=0;i<5;i++)api.populateAssistantBubble(stagedBubble,'',{...initial,showPostActionThinkingLoader:true});
assert.equal(stagedBubble.querySelector('.msg-thought-panel'),initialPanel);
assert.equal(initialPanel.querySelector('.msg-thought-summary-label-text').textContent,initialLabel);
assert.equal(initialPanel.className.includes('in-progress'),false);
assert.equal(stagedBubble.querySelector('.msg-post-action-thinking'),review);
assert.equal(stagedBubble.childNodes.indexOf(review)>stagedBubble.childNodes.indexOf(initialPanel),true);
api.populateAssistantBubble(stagedBubble,'Done.',initial);
assert.equal(stagedBubble.querySelector('.msg-post-action-thinking'),null);
assert.equal(initialPanel.querySelector('.msg-thought-summary-label-text').textContent,initialLabel);
console.log('PASS: completed thought text/timer stay fixed while later reasoning has its own stable loader');
