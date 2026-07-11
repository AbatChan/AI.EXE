// Unit tests for parseAgentDecision (agent-core.js) auto-repair of malformed
// planner output. The weak model sometimes emits a path-only / line-range JSON
// object with no "action"/"tool" — e.g. {"path":"/script.js","start_line":35,
// "end_line":120}. Returning null for that surfaced as agent_parse_error and
// HARD-STOPPED the whole run (the "it fixed it but keeps getting stuck" bug).
// The intent is unambiguously a read; these tests pin that it is inferred.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));

const core = global.AIExeAgentCore.createAgentCore({});
const { parseAgentDecision, deriveFallbackAgentDecision, buildFallbackAgentPlanSpec } = core;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`PASS: ${name}`);
  passed += 1;
}

// The exact step-16 output that hard-stopped the agent.
{
  const d = parseAgentDecision('{"path": "/movielibrary/script.js", "start_line": 35, "end_line": 120}');
  ok('path + line-range with no action/tool is inferred as read_file', d && d.action === 'tool' && d.tool === 'read_file');
  ok('inferred read keeps the path', d && d.path === '/movielibrary/script.js');
  ok('inferred read keeps the line range', d && d.start_line === 35 && d.end_line === 120);
}

// Path-only object (no range) is still a safe read, not a null/stop.
{
  const d = parseAgentDecision('{"path": "/script.js"}');
  ok('bare path-only object infers read_file (non-destructive recovery)', d && d.action === 'tool' && d.tool === 'read_file' && d.path === '/script.js');
}

// offset-style pagination object also infers a read.
{
  const d = parseAgentDecision('{"path": "/style.css", "offset": 4096}');
  ok('path + offset infers read_file with the offset', d && d.tool === 'read_file' && d.offset === 4096);
}

// Existing behavior preserved: a well-formed decision is untouched.
{
  const d = parseAgentDecision('{"action":"tool","tool":"edit_file","path":"/style.css","content":"x"}');
  ok('well-formed edit_file decision is unchanged', d && d.action === 'tool' && d.tool === 'edit_file' && d.path === '/style.css');
}

{
  const d = parseAgentDecision(JSON.stringify({
    action: 'tool',
    tool: 'edit_file',
    path: '/app.js',
    plan_update: ['Add the AI controls', 'Make legal AI moves after human turns', 'Keep undo and reset coherent'],
  }));
  ok('structured plan update is preserved with the tool decision', d && d.planUpdate === 'Add the AI controls|Make legal AI moves after human turns|Keep undo and reset coherent');
}

// Hermes/Qwen tool-call XML must parse without leaking the raw tool call or file
// content as user-facing narration.
{
  const raw = `I'll start by creating the shared component script.

<tool_call>
<function=agent_step>
<parameter=action>
tool
</parameter>
<parameter=tool>
write_file
</parameter>
<parameter=path>
/js/components.js
</parameter>
<parameter=content>
// components
document.addEventListener('DOMContentLoaded', function () {
  window.FlowPilot = {};
});
</parameter>
</function>
</tool_call>`;
  const d = parseAgentDecision(raw);
  ok('Hermes tool_call parses as write_file', d && d.action === 'tool' && d.tool === 'write_file' && d.path === '/js/components.js');
  ok('Hermes tool_call keeps content', d && d.content.includes('window.FlowPilot'));
  ok('Hermes tool_call narration keeps only the note', d && d.thought === "I'll start by creating the shared component script.");
  ok('Hermes tool_call narration does not leak XML', d && !/<tool_call|<parameter|function=agent_step/i.test(`${d.thought} ${d.message}`));
}

// Existing behavior preserved: tool-name-in-action repair still works.
{
  const d = parseAgentDecision('{"action":"read_file","path":"/x.js","start_line":1,"end_line":40}');
  ok('tool-name-in-action is still repaired to read_file', d && d.action === 'tool' && d.tool === 'read_file' && d.start_line === 1);
}

// Venice DOM fallback can accidentally include model chrome before the model's
// JSON. It must not become user-facing agent narration.
{
  const d = parseAgentDecision('Qwen 3 Coder 480B Turbo · 3.27s\n{"action":"tool","tool":"read_file","path":"/index.html"}');
  ok('provider chrome before JSON parses as the tool decision', d && d.action === 'tool' && d.tool === 'read_file' && d.path === '/index.html');
  ok('provider chrome is not kept as narration', d && !/Qwen|3\.27s/i.test(`${d.thought} ${d.message}`));
}

{
  const d = parseAgentDecision('Qwen 3 Coder 480B Turbo\n· 3.27s\n{"action":"tool","tool":"read_file","path":"/style.css"}');
  ok('wrapped provider chrome before JSON is stripped too', d && d.tool === 'read_file' && d.path === '/style.css' && !/Qwen|3\.27s/i.test(`${d.thought} ${d.message}`));
}

// Genuinely empty / contentless output still returns null (no false decision).
{
  const d = parseAgentDecision('{"thought":"hmm"}');
  ok('contentless object (no path/action/tool) still returns null', d === null);
}

// A final message is still parsed as final, not coerced to a read.
{
  const d = parseAgentDecision('{"action":"final","message":"All done."}');
  ok('final decision is preserved', d && d.action === 'final' && /All done/.test(d.message));
}

// Path + substantial content with no action/tool is a WRITE intent (a recovery
// rewrite), not a read — inferring read_file here blocked recovery as a
// duplicate re-read and redirected the run into editing the wrong file.
{
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>Card</title></head>\n<body><div class="layout"></div></body>\n</html>';
  const d = parseAgentDecision(JSON.stringify({ path: '/index.html', content: html }));
  ok('path + full file content infers write_file', d && d.action === 'tool' && d.tool === 'write_file' && d.path === '/index.html');
  ok('inferred write keeps the content', d && d.content.includes('<!DOCTYPE html>'));
}

// Path + an edit-program payload infers edit_file, not a raw overwrite.
{
  const program = JSON.stringify({ edits: [{ op: 'replace', find: 'flex-direction: column', replace: 'flex-direction: row' }] });
  const d = parseAgentDecision(JSON.stringify({ path: '/style.css', content: program }));
  ok('path + edit program content infers edit_file', d && d.tool === 'edit_file' && d.path === '/style.css');
}

// Short content stays a read (likely a stray field, not a file body).
{
  const d = parseAgentDecision('{"path": "/script.js", "content": "check this"}');
  ok('path + trivial content still infers read_file', d && d.tool === 'read_file');
}

// Validation repair must read the broken target first, even when the file was
// just written in the same run. Jumping straight to edit/write wasted steps:
// raw repair instructions got mistaken for file content, then write_file was
// blocked because the existing target had not been read.
{
  const d = deriveFallbackAgentDecision('Create a Vite React app.', [
    { tool: 'new_project', ok: true, path: '/' },
    { tool: 'write_file', ok: true, path: '/src/components/Header.tsx', writtenPath: '/src/components/Header.tsx' },
    {
      tool: 'validate_files',
      ok: true,
      validationPassed: false,
      validationIssues: ['/src/components/Header.tsx: has a JavaScript syntax error: Unexpected token ":"'],
    },
  ], {
    taskKind: 'project',
    expectedFiles: ['/src/components/Header.tsx'],
  });
  ok('validation repair reads a just-written broken file before editing', d && d.tool === 'read_file' && d.path === '/src/components/Header.tsx');
}

// Fallback project plans need a summary too; otherwise deterministic new_project
// starts with tool cards only and no visible narration when the model planner
// path is skipped/timed out.
{
  const p = buildFallbackAgentPlanSpec('Build a personal finance dashboard app.', { forceProjectScope: true });
  ok('fallback project plan includes a visible summary', p && p.taskKind === 'project' && /personal finance dashboard/i.test(p.summary || ''));
}

// --- parseAgentEditProgram shape tolerance ---
const { parseAgentEditProgram } = core;

// Documented object form still parses.
{
  const p = parseAgentEditProgram('{"edits":[{"op":"replace","find":"a","replace":"b"}]}');
  ok('object-form edit program parses', p && p.edits.length === 1 && p.edits[0].op === 'replace');
}

// Top-level ARRAY form (a common model variant) parses instead of failing.
{
  const p = parseAgentEditProgram('[\n  {"find": "<body>", "replace": "<body class=\\"row\\">"},\n  {"find": "gap: 2rem", "replace": "gap: 1rem"}\n]');
  ok('array-form edit program parses', p && p.edits.length === 2);
  ok('array-form edits default missing op to replace', p && p.edits.every((e) => e.op === 'replace'));
}

// find+replace without an op defaults to replace in object form too.
{
  const p = parseAgentEditProgram('{"edits":[{"find":"x","replace":"y"}]}');
  ok('missing op with find+replace defaults to replace', p && p.edits[0].op === 'replace');
}

// Garbage still returns null.
{
  ok('non-JSON edit program returns null', parseAgentEditProgram('please change the layout') === null);
}

console.log(`\n${passed} passed`);
