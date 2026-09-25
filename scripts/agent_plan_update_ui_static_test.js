const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-core.js'), 'utf8');
const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const prompt = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompts', 'developer_agent_decision.md'), 'utf8');

assert.match(core, /planUpdate: String\(planUpdate \|\| ''\)\.trim\(\)/, 'decision parser preserves plan updates');
assert.match(prompt, /plan_update.*replaces your internal done criteria \(the user does not see them\)/i, 'planner is told plan updates refine its internal criteria');
assert.match(loop, /const applyDecisionPlanUpdate = \(decision, step\)/, 'plan-update application path takes step as a parameter (loop-scoped `step` is not visible to the closure)');
assert.match(loop, /applyDecisionPlanUpdate\(decision, step\)/, 'plan-update call site passes the loop step');
assert.match(loop, /planSpec\.doneCriteria = items\.slice\(\)/, 'plan update replaces the active checklist contract');
assert.doesNotMatch(loop, /kind: 'checklist'/, 'no flat Plan card is posted (the final audit alone ticked it, so it sat at 0/N)');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat-renderer.js'), 'utf8');
assert.match(renderer, /&& activity\.kind !== 'checklist'/, 'older saved Plan cards are not rendered either');
assert.match(loop, /autoFinalSummaryNudgeUsed/, 'clean validation requests a model final before deterministic fallback');

console.log('PASS: plan updates refine the internal done criteria; no flat Plan card is shown.');
