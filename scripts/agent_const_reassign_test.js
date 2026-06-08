// Unit tests for getJsReassignedConstIssue (agent-executor.js) — the static
// catch for the "Assignment to constant variable" runtime regression that
// new Function() (parse-only) misses. The agent shipped exactly this bug:
// `const filterGenre = $('#filter-genre'); ... filterGenre = e.target.value;`
// which passed "no issues found" yet broke the filters at runtime.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));
// createAgentExecutor only reads deps lazily inside tool calls, so a minimal
// stub is enough to obtain the pure helper.
const exec = global.AIExeAgentExecutor.createAgentExecutor({});
const { getJsReassignedConstIssue } = exec;

let passed = 0;
const bug = (name, code) => { assert.ok(getJsReassignedConstIssue(code), name); console.log(`PASS: ${name}`); passed += 1; };
const ok = (name, code) => { assert.ok(!getJsReassignedConstIssue(code), name); console.log(`PASS: ${name}`); passed += 1; };

// The exact regression the agent introduced.
bug('flags const DOM ref reassigned in a handler',
  "const filterGenre = $('#filter-genre');\nif(filterGenre){filterGenre.addEventListener('change',(e)=>{ filterGenre = e.target.value; });}");
bug('flags a second case (sortBy)',
  "const sortBy = $('#sort-by');\nsortBy.addEventListener('change',(e)=>{ sortBy = e.target.value; });");

// Must NOT false-positive on legitimate code.
ok('let reassignment is fine', 'let x = 1;\nx = 2;');
ok('const compared / arrow / property assignment is fine',
  'const el = document.body;\nif (el === window) {}\nconst f = () => el.value;\nobj.el = 5;');
ok('const never reassigned is fine',
  "const a = $('#a');\na.addEventListener('click', ()=>{ doThing(a.value); });");
ok('assignment inside a string literal is ignored',
  'const a = 1;\nconst s = "a = 2";\nconsole.log(s);');
ok('a const re-declared in another scope (shadowing) is skipped',
  'const a = 1;\nfunction g(){ const a = 2; return a; }');
ok('=== and => near the name do not trip it',
  'const ok = true;\nconst h = () => ok === true ? 1 : 2;');

console.log(`\n${passed} passed`);
