// Regression test for the fuzzy-anchor "typo heal" in applyAgentEditProgram
// (agent-core.js). The dark-mode run shipped a corrupting edit: the model's
// edit program carried a hallucinated typo ("outbox-shadow") in BOTH find and
// replace. The fuzzy matcher (Levenshtein >= 0.9) matched it to the real
// "box-shadow" line, then wrote the typo into the file — and validate_files
// passed it because CSS parsers ignore unknown properties. The fix re-bases a
// keep-and-extend replacement on the real matched text so the typo can't land.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));
const core = global.AIExeAgentCore.createAgentCore({});
const { applyAgentEditProgram } = core;

let passed = 0;
const pass = (name) => { console.log(`PASS: ${name}`); passed += 1; };

// 1) THE BUG: typo'd anchor, keep-and-append replacement.
{
  const css = [
    '.testimonial:hover {',
    '  transform: translateY(-4px);',
    '  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.1);',
    '}',
    '/* ===== QUOTE ===== */',
  ].join('\n');
  // The model hallucinated "outbox-shadow" in both find and replace, then
  // appended a new dark-mode rule (keep-and-append).
  const program = { edits: [{
    op: 'replace',
    find: 'outbox-shadow: 0 12px 32px rgba(0, 0, 0, 0.1);',
    replace: 'outbox-shadow: 0 12px 32px rgba(0, 0, 0, 0.1);\n}\n[data-theme="dark"] .testimonial:hover {\n  box-shadow: 0 12px 32px rgba(0,0,0,0.45);',
  }] };
  const { output, appliedCount } = applyAgentEditProgram(css, program);
  assert.equal(appliedCount, 1, 'the fuzzy edit should still apply (anchor resolves)');
  assert.ok(!/outbox-shadow/.test(output), `the typo must NOT be written to the file; got:\n${output}`);
  assert.ok(/\bbox-shadow: 0 12px 32px rgba\(0, 0, 0, 0\.1\);/.test(output), `the real box-shadow line must survive; got:\n${output}`);
  assert.ok(/\[data-theme="dark"\] \.testimonial:hover/.test(output), 'the appended dark-mode rule must be present');
  pass('typo in a keep-and-append fuzzy anchor is healed (no corruption)');
}

// 2) Keep-and-PREPEND variant (replace ends with find).
{
  const css = '  color: #333333;';
  const program = { edits: [{
    op: 'replace',
    find: 'color: #33333;', // one digit short — fuzzy match
    replace: '/* themed */\n  color: #33333;',
  }] };
  const { output } = applyAgentEditProgram(css, program);
  assert.ok(/color: #333333;/.test(output), `real value preserved on prepend; got: ${output}`);
  assert.ok(!/#33333;/.test(output.replace('#333333', '')), `the short value must not be written; got: ${output}`);
  assert.ok(/\/\* themed \*\//.test(output), 'the prepended comment is present');
  pass('typo in a keep-and-prepend fuzzy anchor is healed');
}

// 3) Exact match is untouched (no behavior change on the common path).
{
  const src = 'const a = 1;\nconst b = 2;';
  const program = { edits: [{ op: 'replace', find: 'const a = 1;', replace: 'const a = 99;' }] };
  const { output } = applyAgentEditProgram(src, program);
  assert.equal(output, 'const a = 99;\nconst b = 2;', 'exact replace is verbatim');
  pass('exact-match replacement is unchanged (no heal applied)');
}

// 4) A genuine rewrite (replace neither starts nor ends with find) still
//    replaces with the model text — heal only protects keep-and-extend.
//    Use a whitespace-tier match (find differs by internal spacing, so it is
//    NOT an exact substring) so the anchor resolves but is non-exact.
{
  const src = 'old   line  here;';
  const program = { edits: [{ op: 'replace', find: 'old line here;', replace: 'brand new content;' }] };
  const { output, appliedCount } = applyAgentEditProgram(src, program);
  assert.equal(appliedCount, 1, 'whitespace-tier anchor should resolve');
  assert.equal(output, 'brand new content;', 'a true rewrite via non-exact anchor still applies the model replacement');
  pass('non keep-and-extend non-exact replacement is left verbatim');
}

console.log(`\n${passed} passed`);
