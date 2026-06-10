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
const { parseAgentDecision } = core;

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

// Existing behavior preserved: tool-name-in-action repair still works.
{
  const d = parseAgentDecision('{"action":"read_file","path":"/x.js","start_line":1,"end_line":40}');
  ok('tool-name-in-action is still repaired to read_file', d && d.action === 'tool' && d.tool === 'read_file' && d.start_line === 1);
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
