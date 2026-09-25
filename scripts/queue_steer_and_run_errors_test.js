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

// A complete JS file with a quote inside a regex literal is not "truncated" (it sent a
// finished engine.js into continuations that restarted and duplicated it).
{
  global.window = global;
  vm.runInThisContext(fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8'));
  const rt = window.AIExeAgentRuntime.createAgentRuntime({});
  const whole = '(function (g) {\n  function esc(s) {\n    if (/[",\\n\\r]/.test(s)) return \'"\' + s.replace(/"/g, \'""\') + \'"\';\n    return s;\n  }\n  g.esc = esc;\n})(this);\n';
  assert.equal(rt.looksTruncatedFileContent(whole, '/js/engine.js'), false, 'parses = whole');
  assert.equal(rt.looksTruncatedFileContent(`export ${whole}`, '/js/engine.mjs'), false, 'regex-aware scan for modules');
  assert.equal(rt.looksTruncatedFileContent(whole.slice(0, 60), '/js/engine.js'), true);
  assert.equal(rt.looksTruncatedFileContent('export const a = b / c / d;\n', '/a.mjs'), false, 'division is not a regex');
  console.log('PASS: complete JS with quotes in regex literals is not treated as cut off');
}

// Masked top-level "Script error." replays the running script to recover the real error.
{
  assert.match(ui, /var replayTop=function\(\)\{var sc=document\.scripts\[document\.scripts\.length-1\]/);
  assert.match(ui, /document\.readyState!=='loading'\)return false/, 'only while the page is parsing');
  assert.match(ui, /if\(String\(m\)==='Script error\.'&&replayTop\(\)\)return;/);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fn(ui, 'mapSmokeStackToSource')}; this.map = mapSmokeStackToSource;`, ctx);
  assert.equal(ctx.map('', 'init@aiexe-replay/js/app.js:434:12'), '/js/app.js:434:12 in init()');
  console.log('PASS: masked top-level errors are replayed and mapped to file:line');
}

// The smoke hook is a template literal: evaluate it and parse the real output. A broken
// escape once made every smoke run silently report "started cleanly".
{
  const a = ui.indexOf('const hook = `<script>');
  const b = ui.indexOf('</script>`;', a);
  assert.ok(a > 0 && b > a, 'hook template found');
  const tpl = ui.slice(a + 'const hook = '.length, b + '</script>`'.length);
  const runnerSrc = fn(ui, 'aiexeRunSmokeChecks');
  const runnerFn = vm.runInNewContext(`(${runnerSrc})`, {});
  const hookJs = vm.runInNewContext(tpl, { checks: [{ click: '#a</script>' }], aiexeRunSmokeChecks: runnerFn }).replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.ok(!hookJs.includes('</script>'), 'check text cannot close the hook script');
  assert.match(hookJs, /var CHECKS=\[\{"click":"#a\\u003c\/script>"\}\];/);
  assert.doesNotThrow(() => new Function(hookJs), 'smoke hook must parse');
  // Replay recovers a masked top-level error through the real hook code.
  const sent = [];
  const reported = [];
  const line = hookJs.split('\n').find((l) => l.startsWith('var replayTop='));
  const ctx = {
    document: { readyState: 'loading', scripts: [{ textContent: '\n//@aiexe-src /js/app.js\nvar MS = window.Missing;\nvar C = MS.COLS;\n' }] },
    send: (t) => sent.push(t),
    report: (e, where) => reported.push(`${e.message} | ${where} | ${e.stack}`),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${line}; this.hit = replayTop();`, ctx);
  assert.equal(ctx.hit, true);
  assert.match(reported[0], /COLS[\s\S]*top level of \/js\/app\.js[\s\S]*aiexe-replay\/js\/app\.js:2:/);
  console.log('PASS: smoke hook parses; masked top-level error replays to /js/app.js:2');
}

// Run groups fold 2+ back-to-back same-kind rows (writes, setup, checks) into a nested group.
{
  const renderer = fs.readFileSync(path.join(root, 'ui', 'chat-renderer.js'), 'utf8');
  const sub = fn(renderer, 'buildActivitySubgroup');
  assert.match(sub, /const nestRuns = phase === 'run' && !disclosureOptions\.nested;/);
  assert.match(sub, /cluster\.phase !== 'other' && cluster\.items\.length > 1[\s\S]{0,120}buildActivitySubgroup\(chatId, cluster/);
  assert.match(sub, /if \(!nestRuns\) items\.forEach/, 'flat rows only when not nested');
  const css = fs.readFileSync(path.join(root, 'ui', 'ai-exe.css'), 'utf8');
  assert.match(css, /\.run-group > \.msg-agent-subgroup-drawer \{ max-height: 220px/, 'parent cap must not force nested drawers open');
  console.log('PASS: same-kind rows fold into nested groups inside a run');
}

// Reading like Codex: what you read stays in view (current content, real line numbers);
// reading lines you have not seen is allowed; runtime errors carry a code frame.
{
  const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
  const ctx = { normalizeWorkspacePath: (p) => `/${String(p || '').replace(/^\/+/, '')}` };
  vm.createContext(ctx);
  vm.runInContext(`${fn(planner, 'buildOpenFileViews')}; this.views = buildOpenFileViews;`, ctx);
  const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
  const edited = file.replace('line 12', 'line 12 EDITED');
  const v = ctx.views([
    { tool: 'read_file', ok: true, path: '/g.js', startLine: 10, endLine: 20, content: file },
    { tool: 'read_file', ok: true, path: '/g.js', startLine: 15, endLine: 30, content: file },
    { tool: 'edit_file', ok: true, path: '/g.js', content: edited },
  ]);
  assert.ok(v.paths.has('/g.js'));
  assert.match(v.text, /\/g\.js \(60 lines; lines 10–30\)/, 'overlapping ranges merge');
  assert.match(v.text, /  12\| line 12 EDITED/, 'shows current content after an edit');
  assert.doesNotMatch(v.text, /  31\| /, 'only lines actually read');
  assert.equal(ctx.views([]).text, '');
  assert.match(planner, /shown in OPEN FILES above/);

  const loopSrc = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
  const c2 = {};
  vm.createContext(c2);
  vm.runInContext(`${fn(loopSrc, 'summarizeReadRange')}\n${fn(loopSrc, 'readEventWasTruncated')}\n${fn(loopSrc, 'evaluateRepeatedRead')}; this.rr = evaluateRepeatedRead;`, c2);
  const reads = [10, 400, 390, 1].map((s) => ({ tool: 'read_file', ok: true, path: '/g.js', startLine: s, endLine: s + 60, observation: '' }));
  assert.equal(c2.rr(reads, '/g.js', '600:640:0'), null, 'unseen lines are new information');
  assert.notEqual(c2.rr(reads, '/g.js', '400:440:0'), null, 'seen lines are a repeat');
  assert.match(loopSrc, /Not re-read: every line you asked for from \$\{readPath\} is already in OPEN FILES above/);

  assert.match(executor, /const framesText = frames\.length \? `\\nCode at the error/);
  assert.match(executor, /runtime error\$\{errors\.length === 1 \? '' : 's'\} during the smoke run:\\n- \$\{errors\.join\('\\n- '\)\}\$\{framesText\}/);
  console.log('PASS: open-file views, unseen-line reads allowed, code frames on runtime errors');
}

// run_app user-flow checks: parsed, passed to the smoke page, failures count as run errors.
{
  const core = fs.readFileSync(path.join(root, 'ui', 'agent-core.js'), 'utf8');
  assert.match(core, /if \(Array\.isArray\(parsed\.checks\)\) checksList = /);
  assert.match(executor, /deps\.runWorkspaceAppSmokeTest\(htmlTarget, \{ checks \}\)/);
  assert.match(executor, /runErrorCount: errors\.length \+ failedChecks/);
  assert.match(executor, /This only proves the page loads; it does not prove any feature works/);
  assert.match(ui, /checks: \{\n\s+type: 'array',/, 'native tool schema carries checks');
  const runner = fn(ui, 'aiexeRunSmokeChecks');
  assert.match(runner, /if \(!kp\.defaultPrevented && editable\(target\)\) insertText\(target, key\);/, 'typed text lands where focus is after handlers, like a browser');
  // WKWebView ignores script focus() in the hidden sandboxed frame; typing went to <body>.
  assert.match(runner, /proto\.focus = function/, 'runner tracks focus the frame refuses');
  assert.match(runner, /var t = active\(\) \|\| document\.body;/, 'keys go to the tracked focus');
  assert.doesNotMatch(runner.slice(runner.indexOf('var CODES')), /document\.activeElement/, 'no raw activeElement after the focus shim');
  const md = fs.readFileSync(path.join(root, 'ui', 'prompts', 'developer_agent_decision.md'), 'utf8');
  assert.match(md, /Claim a feature works only when a check for it passed/);
  assert.match(md, /include at least one check that changes existing data/, 'checks must cover editing filled data (Mini Sheets append bug)');
  assert.match(md, /don't guess selectors/);
  console.log('PASS: run_app user-flow checks wired end to end');
}

// Regression scenarios exercise parser semantics and error preservation.
require('./agent_verification_scenarios_test.js');

// A harness-issued re-run repeats the model's latest checks instead of reporting startup only.
{
  assert.match(executor, /if \(!checks\.length && decision\._deterministic\) \{[\s\S]{0,300}String\(event\.checksSig \|\| '\[\]'\) !== '\[\]'/);
  assert.match(executor, /Your latest checks, run again after the change/);
  console.log('PASS: automatic re-runs reuse the latest user-flow checks');
}

// Finish gate: a smoke-tested web page needs a run WITH checks after the last change (one advisory nudge).
{
  const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  const src = planner.slice(planner.indexOf("// A web page the smoke run can drive"), planner.indexOf("met: lastChecked > lastMutation,") + "met: lastChecked > lastMutation,".length);
  assert.match(src, /Number\(event\.checksRun\) > 0/);
  assert.match(planner, /id: 'checks_after_changes'/);
  assert.match(loop, /checksRun: Number\(toolResult && toolResult\.checksRun\) \|\| 0,/);
  console.log('PASS: finishing a web page without user-flow checks gets one push-back');
}

// "No change needed" on a planned file satisfies its "update X" requirement (the 13.1.5 reword broke the text match).
{
  const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
  assert.match(planner, /event\.noChangeNeeded === true \|\| \/already contains that exact text\/i/);
  assert.match(loop, /noChangeNeeded: Boolean\(toolResult && toolResult\.noChangeNeeded\),/);
  console.log('PASS: a no-change-needed edit satisfies the planned update requirement');
}
