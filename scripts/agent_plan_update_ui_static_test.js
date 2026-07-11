const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-core.js'), 'utf8');
const loop = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const prompt = fs.readFileSync(path.join(__dirname, '..', 'ui', 'prompts', 'developer_agent_decision.md'), 'utf8');

assert.match(core, /planUpdate: String\(planUpdate \|\| ''\)\.trim\(\)/, 'decision parser preserves plan updates');
assert.match(prompt, /plan_update.*visible Plan card directly/i, 'planner is told to send structured plan updates');
assert.match(loop, /const applyDecisionPlanUpdate = \(decision, step\)/, 'plan-update application path takes step as a parameter (loop-scoped `step` is not visible to the closure)');
assert.match(loop, /applyDecisionPlanUpdate\(decision, step\)/, 'plan-update call site passes the loop step');
assert.match(loop, /planSpec\.doneCriteria = items\.slice\(\)/, 'plan update replaces the active checklist contract');
assert.match(loop, /title: planUpdatePending \? 'Plan updated' : 'Plan'/, 'work panel labels the refined checklist');
assert.match(loop, /autoFinalSummaryNudgeUsed/, 'clean validation requests a model final before deterministic fallback');

console.log('PASS: post-analysis plan updates reach the visible checklist and final summary decision.');
