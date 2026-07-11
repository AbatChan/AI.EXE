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
const { getJsReassignedConstIssue, getJsSyntaxIssue } = exec;

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
// The chess-app false positive (v7.7.9): a const in one function plus a
// let multi-declarator of the same name in another must not flag.
ok('let multi-declarator shadowing a const elsewhere is fine',
  'function a(){ const nc = c + dc; use(nc); }\nfunction b(){ let nr = r + dr, nc = c + dc;\nwhile (x) { nr += dr; nc += dc; } }');
ok('const multi-declarator continuation is a declaration, not a reassignment',
  'function a(){ const nc = c + dc; use(nc); }\nfunction b(){ const nr = r + dr, nc = c + dc; use(nr, nc); }');

// Linter path (bundled ESLint) — scope-aware, replaces the regex when loaded.
{
  global.window.eslint = require(path.join(__dirname, '..', 'ui', 'vendor', 'eslint', 'linter.js'));
  const { getJsCorrectnessIssues } = exec;
  const lintOk = (name, code) => {
    const result = getJsCorrectnessIssues(code);
    assert.ok(result && !result.syntaxIssue && result.issues.length === 0, name);
    console.log(`PASS: ${name}`);
    passed += 1;
  };
  const lintBug = (name, code, message) => {
    const result = getJsCorrectnessIssues(code);
    assert.ok(result && !result.syntaxIssue && result.issues.some((issue) => message.test(issue)), name);
    console.log(`PASS: ${name}`);
    passed += 1;
  };

  // False-positive matrix: scopes, member writes, literals, JSX, and modules.
  lintOk('linter passes the chess shadowing pattern',
    'function a(){ for (const dc of [-1,1]) { const nc = c + dc; use(nc); } }\n'
      + 'function b(){ let nr = r + dr, nc = c + dc; while (x) { nr += dr; nc += dc; } }');
  lintOk('allows a nested let shadowing a const',
    'const score = 0; { let score = 1; score += 1; } use(score);');
  lintOk('allows const object and array member mutations',
    'const state = { count: 0 }; const items = []; state.count += 1; items.push(state.count);');
  lintOk('ignores assignment-shaped strings, comments, and templates',
    'const total = 1; const note = "total = 2"; /* total = 3 */ const label = `total = 4`; use(note, label);');
  lintOk('parses valid JSX without a new-Function false positive',
    'const Card = () => <section>{"ready"}</section>; export default Card;');
  lintOk('parses a valid ES module',
    'import value from "./value.js"; export const doubled = value * 2;');
  lintOk('accepts a valid top-level module await',
    'const response = await fetch("/api"); export { response };');

  // Legal-but-suspicious patterns remain advisory: they must not block an agent.
  lintOk('does not block intentional function or class rebinding',
    'function run() {}\nrun = other;\nclass Card {}\nCard = Other;');
  lintOk('does not block duplicate keys, switch cases, or class members',
    'const o = { a: 1, a: 2 }; switch (x) { case 1: break; case 1: break; } class A { run() {} run() {} }');
  lintOk('does not block no-op assignments or deliberate comparisons',
    'let result = 1; result = result; if (value === NaN || typeof value === "numberish") use(result);');
  lintOk('does not block legal accessor or loop forms',
    'const o = { get value() { use(1); }, set value(v) { return v; } }; for (let i = 0; i < 3; i -= 1) use(i);');

  // Every enabled blocking rule has a positive regression case.
  lintBug('flags const reassignment', 'const total = 1;\ntotal = 2;', /constant.*line 2/i);
  lintBug('flags an extending constructor without super', 'class Child extends Parent { constructor() {} }', /super\(\)/i);
  lintBug('flags this before super', 'class Child extends Parent { constructor() { this.x = 1; super(); } }', /before.*super/i);
  delete global.window.eslint;
}

{
  const issue = getJsSyntaxIssue('function ok() {\n  return true;\n}\n}', new SyntaxError("Unexpected token '}'"));
  assert.ok(/line 4/.test(issue) && /nothing is open/i.test(issue), 'reports unmatched closing brace line');
  console.log('PASS: reports unmatched closing brace line');
  passed += 1;
}

{
  const issue = getJsSyntaxIssue('function ok() {\n  if (true) {\n    return 1;\n', new SyntaxError('Unexpected end of input'));
  assert.ok(/opened at line 2/.test(issue), 'reports latest unclosed block line');
  console.log('PASS: reports latest unclosed block line');
  passed += 1;
}

console.log(`\n${passed} passed`);
