// Same-chat queue + Steer, readable smoke-run errors, search query hygiene, run timing in chat memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const executor = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'ui', 'prompt-core.js'), 'utf8');

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name);
}

// 1. Stack frames from the sandboxed srcdoc map back to the inlined file.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fn(ui, 'mapSmokeStackToSource')}; this.map = mapSmokeStackToSource;`, ctx);
  const html = ['<html>', '<head>', '<script>hook</script>', '</head>', '<script>', '//@aiexe-src /script.js', 'line1', 'line2', 'line3', '</script>'].join('\n');
  assert.equal(ctx.map(html, 'loop@about:srcdoc:9:14\nwrapped@about:srcdoc:3:1'), '/script.js:3:14 in loop()');
  assert.equal(ctx.map(html, '@about:srcdoc:7:2'), '/script.js:1:2');
  assert.equal(ctx.map(html, 'x@about:srcdoc:2:1'), '', 'frames outside app files are not mapped');
  assert.equal(ctx.map(html, ''), '');
}
// Hook reports real errors from handlers, timers and frames before WebKit masks them.
assert.match(ui, /EventTarget\.prototype\.addEventListener=function\(t,l,o\)\{return ael\.call\(this,t,wrap\(l,t\+' handler'\),o\);\}/);
assert.match(ui, /\['setTimeout','setInterval','requestAnimationFrame'\]\.forEach/);
assert.match(ui, /\/\/@aiexe-src \$\{srcLabel\}/);

// 2. search_files never searches narration or the task text.
assert.match(executor, /const query = String\(decision\.content \|\| decision\.query \|\| ''\)\.trim\(\);/);
assert.doesNotMatch(executor, /decision\.content \|\| decision\.message \|\| taskText/);

// 3. Chat memory of Agent runs carries timing.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fn(core, 'describeAgentRunTiming')}; this.t = describeAgentRunTiming;`, ctx);
  assert.match(ctx.t({ agentMeta: { startedAt: 1000, completedAt: 181000 } }), /^Run timing: worked 3m 0s/);
  assert.equal(ctx.t({ agentMeta: {} }), '');
}

// 4. Queue: Enter queues while this chat replies; Steer keeps Agent progress.
assert.match(ui, /const queueInThisChat = operationRunning && isCurrentViewInferenceChat\(\);/);
assert.match(ui, /deferredAppend: true/);
assert.match(fn(ui, 'dispatchNextQueuedSend'), /job\.deferredAppend[\s\S]*appendMessageToChat/);
assert.match(fn(ui, 'submitComposerMessage'), /!String\(mainInput && mainInput\.value \|\| ''\)\.trim\(\)/, 'Enter only swallowed when empty');
const steer = fn(ui, 'steerQueuedSend');
assert.match(steer, /token\.operationKind === 'agent'[\s\S]*token\.steerNotes = /, 'Agent steer joins the running task');
assert.match(steer, /queuedSends\.unshift\(job\)[\s\S]*cancelActiveInference\(\)/, 'plain replies stop, then send');
assert.match(loop, /let taskText = String\(promptText/);
assert.match(loop, /requestToken\.steerNotes\.splice\(0\)[\s\S]{0,300}kind: 'steer'[\s\S]{0,200}USER UPDATE/);
// Queued messages are not in the chat until they run; steer joins the plan; late steers requeue.
assert.match(ui, /if \(!queueInThisChat\) \{\n\s+chatAutoScrollPinned = true;\n\s+appendMessageToChat\(chat\.id, 'user'/);
assert.match(loop, /checklistItems\.push\(criterion\)/);
assert.match(fn(ui, 'requestSelectedDeveloperAgentReply'), /finally \{\s+requeueLeftoverSteers\(requestToken\);/);
assert.match(fn(ui, 'requeueLeftoverSteers'), /queuedSends\.unshift\(note\.job\)/);
console.log('PASS: queue + steer, readable smoke errors mapped to file:line, clean search queries, run timing in chat memory');

// Edit writer saying "nothing to change" is reported as such — no rewrite fallback, no "couldn't parse".
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fn(executor, 'isExplicitEmptyEditProgram')}; this.empty = isExplicitEmptyEditProgram;`, ctx);
  assert.equal(ctx.empty('{"edits":[]}'), true);
  assert.equal(ctx.empty('```json\n{"edits": []}\n```'), true);
  assert.equal(ctx.empty('{"edits":[{"find":"a","replace":"b"}]}'), false);
  assert.equal(ctx.empty('make it green'), false);
  assert.match(executor, /if \(writerFoundNothing \|\| noOpProgram\) \{[\s\S]{0,400}noChangeNeeded: true/);
  console.log('PASS: empty or identical edit programs read as "no change needed"');
}

// Verify before done: code changes need a run after the last change; cards need a standalone, complete marker.
{
  const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
  assert.match(planner, /id: 'run_after_changes'[\s\S]{0,200}met: lastRun > lastMutation/);
  assert.match(ui, /const midSentence = \/\[A-Za-z0-9\]\/\.test\(text\.slice\(match\.index \+ match\[0\]\.length\)\);/);
  assert.match(ui, /CHAT_CARD_NEEDS_ARG = new Set\(\['compare', 'fx', 'weather', 'timer', 'action'\]\)/);
  console.log('PASS: run-after-changes requirement; cards only for standalone complete markers');
}
