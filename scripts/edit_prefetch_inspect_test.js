// Mini Sheets follow-up: the plan named /script.js|/index.html to inspect, yet the loop
// spent two model round trips reading them one by one. Edit runs now batch them first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const block = loop.slice(loop.indexOf('// Edit runs: read the plan'), loop.indexOf("raw: '[prefetch-files-to-inspect]'"));
assert.ok(block.length > 0, 'prefetch block present');
assert.match(block, /!inspectPrefetchDone && String\(planSpec && planSpec\.taskKind \|\| ''\)\.toLowerCase\(\) === 'edit'/, 'edit runs only, once');
assert.match(block, /inspect\.length >= 2 && !readAlready/, 'only when 2+ files and nothing read yet');
assert.match(block, /\.slice\(0, 6\)/, 'capped like the prompt says (3-6 vital files)');
assert.match(block, /tool: 'read_files',\s+paths: inspect/, 'one read_files batch');
assert.ok(loop.indexOf('let inspectPrefetchDone = false;') < loop.indexOf('for (let step = 1; step <= executionStepLimit'), 'flag lives outside the step loop');
console.log('PASS: edit runs batch-read the planned files_to_inspect in one step');

// Tip Split: with every planned file written, the directive ordered "return the final result"
// and the model never ran the PyInstaller build the user asked for.
{
  const planner = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-planner.js'), 'utf8');
  assert.doesNotMatch(planner, /NOW: return the final result; do not invent optional work/);
  assert.match(planner, /if the task asked you to run, test, build, or package something and TOOL_RESULTS don't show it succeeding yet, do that next/);
  console.log('PASS: "files done" no longer means "stop" when a requested build/run is still pending');
}
