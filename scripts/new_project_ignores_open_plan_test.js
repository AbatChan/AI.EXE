// Regression: a new-project run adopted the open project's unfinished plan.md
// (Mini Sheets got Link Profile's phases and wrote prisma/auth files).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-loop.js'), 'utf8');
const guard = src.indexOf("const freshNewProject = !isResume && String(planSpec && planSpec.workspaceIntent || '') === 'new';");
assert.ok(guard > 0, 'fresh new-project guard missing');
const read = src.indexOf('const filePhases = freshNewProject ? null : await readAgentPlanFilePhases();');
assert.ok(read > guard, 'plan.md must be skipped for fresh new-project runs');
assert.strictEqual((src.match(/await readAgentPlanFilePhases\(\)/g) || []).length, 1, 'no other unguarded plan.md read at run start');
console.log('new_project_ignores_open_plan_test: ok');
