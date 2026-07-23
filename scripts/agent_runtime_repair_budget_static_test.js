const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');

assert.match(loop, /let executionStepLimit = Number\(deps\.agentMaxSteps\) \|\| 28/);
assert.match(loop, /const runtimeRepairGraceSteps = 10/);
assert.match(loop, /String\(decision\.tool \|\| ''\)\.toLowerCase\(\) === 'run_app'/);
assert.match(loop, /Number\(toolResult\.runErrorCount \|\| 0\) > 0/);
assert.match(loop, /countRunMutations\(\) > 0/);
assert.match(loop, /executionStepLimit \+= runtimeRepairGraceSteps/);
assert.match(planner, /effectiveAgentMaxSteps/);
assert.match(planner, /planSpec\._executionStepLimit/);

assert.match(runtime, /VERIFIED_RESULTS records real terminal\/build\/validation outcomes/);
assert.match(runtime, /successful dependency-install commands as proof that the dependency was installed/);

assert.match(app, /const sessionAlwaysAllowedAgentCommands = \[\]/);
assert.match(app, /getAlwaysAllowedAgentCommands: \(\) => sessionAlwaysAllowedAgentCommands\.slice\(\)/);
assert.doesNotMatch(app, /appSettings\.alwaysAllowedAgentCommands/);

console.log('PASS: failed final runs receive bounded repair grace, completion sees verified terminal facts, and Always allow is session-scoped');
