// Agent: the pre-work Thought survives the live-feed reset; conclusions see Canvas docs and searches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');

const reset = loop.indexOf('deps.resetActiveAgentStreamState();');
assert.notEqual(reset, -1);
const after = loop.slice(reset, reset + 400);
assert.match(after, /activity\.kind === 'reasoning'[\s\S]*pushActiveAgentStreamActivity/, 'Thought re-pushed right after the reset');

assert.match(runtime, /tool === 'create_canvas'[\s\S]{0,400}Created Canvas document/, 'Canvas docs count as delivered changes');
assert.match(runtime, /'trading', 'web_search'\]\.includes/, 'searches reach VERIFIED_RESULTS');

// Stop messages are model-written with a canned fallback.
assert.match(loop, /buildStoppedWithWorkText = async \(blockerNote, stopReason = ''\)/);
assert.match(loop, /_completionLimitations: `The run stopped before finishing/);
assert.match(loop, /toolTimeoutsByPath\[timedOutPath\] < 2/, 'one retry before stopping on a stall');
console.log('PASS: Thought stays first in live Agent feed; Canvas/search evidence reaches conclusions; stops are model-written');

// Chat always gets the open project's layout (not gated on the Agent router) and is told to offer Agent.
{
  const ui = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
  const line = ui.slice(ui.indexOf('    getOpenProjectLine: () => {'), ui.indexOf('    getLiveReminder: buildLiveReminder,'));
  assert.doesNotMatch(line, /workspaceContextEnabled/, 'project skeleton is not gated on routing');
  assert.match(line, /bring it up only when the user asks/);
  assert.match(line, /offer Agent/);
  assert.match(ui, /requestToken\.openProjectTree = await getWorkspaceFileTreeSummary\(\)/);
  console.log('PASS: chat sees the open project skeleton and offers Agent for real work');
}
