// Step prompts cache like Codex: rules sent once, results append-only, and this step's
// "before newest result" cache point is exactly last step's "after all results" point.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global;
const root = path.join(__dirname, '..');
require(path.join(root, 'ui', 'prompt-core.js'));
require(path.join(root, 'ui', 'agent-planner.js'));
const template = fs.readFileSync(path.join(root, 'ui', 'prompts', 'developer_agent_decision.md'), 'utf8');
const norm = (p) => { let s = String(p || '').trim(); if (!s.startsWith('/')) s = `/${s}`; return s.replace(/\/+/g, '/'); };
const planner = global.AIExeAgentPlanner.createAgentPlanner({
  normalizeWorkspacePath: norm,
  buildAgentHistoryTranscript: () => '',
  getWorkspaceFileTreeSummary: async () => 'index.html\njs/\n  app.js',
  loadPromptTemplate: async () => template,
  // The real renderer trims trailing spaces and collapses blank lines (broke text-search cache points live).
  renderPromptTemplate: (t, vars) => global.AIExePromptCore.createPromptCore({}).renderPromptTemplate(t, vars),
  getWorkspaceContext: () => ({ currentPath: '/js/app.js', currentKind: 'file', workspaceRootName: 'cube lab' }),
  isAgentTaskGameLike: () => false,
  hasReadmeRunInstructions: () => false,
  isLikelyCompleteReadme: () => false,
  isExplicitReadmeOrDocsTask: () => false,
  buildAgentFileGenerationHints: () => '',
  deriveProjectNameFromTask: () => 'cube',
});

const app = Array.from({ length: 80 }, (_, i) => (i % 7 ? `const v${i} = ${i};   ` : '')).join('\n');
const base = [
  { tool: 'read_file', ok: true, path: '/js/app.js', content: app, observation: `read_file /js/app.js\n${app}` },
  { tool: 'edit_file', ok: true, path: '/js/app.js', content: app, observation: 'edit_file ok: /js/app.js' },
];
const cmd = (i) => ({ tool: 'run_command', ok: true, command: `node t${i}.js`, terminalCommand: `node t${i}.js`, observation: `run_command \`node t${i}.js\`: finished cleanly (exit 0).   \n\n\n\nok ${i}  \n` });
const spec = { affectedFiles: ['/js/app.js'], filesToInspect: [], expectedFiles: [] };

(async () => {
  const at = (p, fromEnd) => p.length - fromEnd;
  const build = (n) => planner.buildAgentDecisionPrompt('c1', 'make scramble animate', [...base, ...Array.from({ length: n }, (_, i) => cmd(i))], n + 2, spec);
  const a = await build(9); // 11 events
  const b = await build(10); // 12 events — same window, one appended
  assert.equal(a.cacheBreaksFromEnd.length, 3, 'head, previous end, list end');
  const endA = at(a.prompt, Math.min(...a.cacheBreaksFromEnd));
  const prevB = at(b.prompt, [...b.cacheBreaksFromEnd].sort((x, y) => x - y)[1]);
  assert.equal(b.prompt.slice(0, prevB), a.prompt.slice(0, endA), "this step's second cache point = last step's end (cache hit)");
  assert.ok(endA > a.prompt.indexOf('TOOL_RESULTS:') && endA < a.prompt.indexOf('Agent step:'), 'breaks sit inside TOOL_RESULTS, before the per-step tail');
  assert.ok(a.prompt.indexOf('\nPLAN:\n') > 0 && a.prompt.startsWith(a.systemPrompt), 'rules are the system prefix');
  assert.ok(!a.prompt.includes('\uE000'), 'cache markers never reach the model');
  console.log('PASS: consecutive steps share the cached prefix up to the previous step\'s end');

  // Window advances 5 at a time: 14 → 15 events jumps; 15 → 16 appends.
  const c = await build(13); // 15 events
  const d = await build(14); // 16 events
  const endC = at(c.prompt, Math.min(...c.cacheBreaksFromEnd));
  const prevD = at(d.prompt, [...d.cacheBreaksFromEnd].sort((x, y) => x - y)[1]);
  assert.equal(d.prompt.slice(0, prevD), c.prompt.slice(0, endC), 'append-only again after the window jump');
  console.log('PASS: result window grows append-only between jumps');

  // Wire level: rules once; OpenAI explicit breakpoints; rejection strips back to strings.
  const ui = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
  const grab = (name) => {
    const s = ui.indexOf(`function ${name}(`);
    let depth = 0; let i = ui.indexOf(') {\n', s) + 2;
    for (; i < ui.length; i += 1) { if (ui[i] === '{') depth += 1; else if (ui[i] === '}' && --depth === 0) break; }
    return ui.slice(s, i + 1);
  };
  const box = {};
  vm.createContext(box);
  vm.runInContext(['withoutRepeatedSystem', 'splitAtCacheBreaks', 'openAiExplicitCaching', 'applyOpenAiAgentCacheControl', 'stripOpenAiCacheControl', 'anthropicCachedUser']
    .map(grab).join('\n') + '\nthis.api = { withoutRepeatedSystem, splitAtCacheBreaks, applyOpenAiAgentCacheControl, stripOpenAiCacheControl, anthropicCachedUser };', box);
  const { withoutRepeatedSystem, applyOpenAiAgentCacheControl, stripOpenAiCacheControl, anthropicCachedUser } = box.api;
  const user = withoutRepeatedSystem(a.prompt, a.systemPrompt);
  assert.ok(!user.includes(a.systemPrompt.slice(0, 400)) && user.startsWith('PLAN:'), 'rules are not repeated in the user message');
  const req = { messages: [{ role: 'system', content: a.systemPrompt }, { role: 'user', content: user }] };
  applyOpenAiAgentCacheControl('openai', 'gpt-6-luna', req, { breakpointOnSystem: true, userBreaksFromEnd: a.cacheBreaksFromEnd });
  const blocks = req.messages[1].content;
  assert.equal(blocks.length, 4, 'user split into 3 cached segments + tail');
  assert.equal(blocks.filter((x) => x.prompt_cache_breakpoint).length + 1, 4, '4 breakpoints total incl. system (OpenAI max)');
  assert.equal(blocks.map((x) => x.text).join(''), user, 'segments rejoin to the exact text');
  stripOpenAiCacheControl(req);
  assert.equal(req.messages[1].content, user, 'rejected cache fields -> plain string again');
  assert.equal(req.messages[0].content, a.systemPrompt);
  const other = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: user }] };
  applyOpenAiAgentCacheControl('deepseek', 'deepseek-flash', other, { breakpointOnSystem: true, userBreaksFromEnd: a.cacheBreaksFromEnd });
  assert.equal(typeof other.messages[1].content, 'string', 'automatic-cache providers keep a plain string');
  const claude = anthropicCachedUser(user, a.cacheBreaksFromEnd);
  assert.equal(claude.filter((x) => x.cache_control).length, 3, 'Claude: 3 user marks + system = 4');
  console.log('PASS: rules sent once; OpenAI/Claude cache points; plain fallback');
})().catch((e) => { console.error(e); process.exit(1); });
