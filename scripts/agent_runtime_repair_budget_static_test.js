const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const planner = fs.readFileSync(path.join(root, 'ui', 'agent-planner.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const executor = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');

assert.match(loop, /let executionStepLimit = Number\(deps\.agentMaxSteps\) \|\| 28/);
assert.match(loop, /const runtimeRepairGraceSteps = 10/);
assert.match(loop, /String\(decision\.tool \|\| ''\)\.toLowerCase\(\) === 'run_app'/);
assert.match(loop, /Number\(toolResult\.runErrorCount \|\| 0\) > 0/);
assert.match(loop, /countRunMutations\(\) > 0/);
assert.match(loop, /executionStepLimit \+= runtimeRepairGraceSteps/);
// Progress-based grace: re-arms on a NEW error signature, capped.
assert.match(loop, /const runtimeRepairGraceMax = 3/);
assert.match(loop, /repairErrorSignature !== lastRepairErrorSignature/);
assert.match(planner, /effectiveAgentMaxSteps/);
assert.match(planner, /planSpec\._executionStepLimit/);

// validationPassed is only meaningful on validate_files events; a boolean false
// on every other tool made ALL terminal results read as FAILED downstream.
assert.match(loop, /validationPassed: String\(decision\.tool \|\| ''\)\.toLowerCase\(\) === 'validate_files'/);
assert.match(runtime, /rowTool === 'validate_files' && item\.validationPassed === false/);

assert.match(runtime, /VERIFIED_RESULTS records real terminal\/build\/validation outcomes/);
assert.match(runtime, /successful dependency-install commands as proof that the dependency was installed/);
// A build pass never proves an in-browser runtime error fixed.
assert.match(runtime, /a passing build does NOT prove the runtime error is gone/);
assert.match(executor, /which this build cannot reproduce/);

// The package.json scaffolder never fires over an existing manifest.
assert.match(executor, /regenerating it would drop its real dependencies/);
// edit_file repairs Venice-mangled package.json versions instead of looping.
assert.match(executor, /repairPackageJsonDependencyVersions\(applied\.output\)/);
assert.match(executor, /Repaired Venice-mangled dependency versions from the known-good table/);
// Type errors are surfaced as a full batch, not one per rebuild.
assert.match(executor, /All current type errors/);
// Harness-substituted saves show the real bytes instead of claiming a match.
assert.match(executor, /The saved file differs from what you supplied/);

assert.match(app, /const sessionAlwaysAllowedAgentCommands = \[\]/);
assert.match(app, /getAlwaysAllowedAgentCommands: \(\) => sessionAlwaysAllowedAgentCommands\.slice\(\)/);
assert.doesNotMatch(app, /appSettings\.alwaysAllowedAgentCommands/);

console.log('PASS: progress-based repair grace, truthful validation/terminal facts, no-substitute package.json scaffolder, batched type errors, runtime-error proof guard');
