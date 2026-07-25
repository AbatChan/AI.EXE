// v9.9.6 — a phase may not tick a file it never wrote; the shortfall follows the plan.
// Live: Phase 2 owed README.md, wrote nothing, and plan.md still recorded "- [x] README.md".
// The phase advanced and nothing owed the file again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'ui', 'agent-core.js'), 'utf8');

// ---- The unconditional tick is gone ----
const complete = loop.slice(loop.indexOf('const completeActivePhase = async () =>'),
  loop.indexOf('const refreshPhaseLiveProgress'));
assert.doesNotMatch(complete, /doneTasks\.forEach\(\(t\) => \{ if \(t\) t\.done = true; \}\);/,
  'tasks are no longer ticked unconditionally');
assert.match(complete, /const unmet = getKnownActivePhaseFileTaskGaps\(\);/,
  'the phase checks which declared files actually exist');
assert.match(complete, /if \(unmetTexts\.has\(String\(t\.text \|\| t \|\| ''\)\.trim\(\)\)\) return;/,
  'a missing deliverable is left unchecked');
// The shortfall must travel, or "not ticked" just wedges the same phase forever.
assert.match(complete, /const carryTo = phaseState\.phases\[idx \+ 1\];/, 'it carries into the next phase');
assert.match(complete, /carryTo\.tasks\.push\(\{ text, done: false \}\)/, 'as a real unchecked task');
assert.match(complete, /agent_phase_unmet_deliverables_carried/, 'and it is traced');
assert.match(complete, /carriedForward: unmet\.map/, 'the caller learns what was carried');

// ---- The message may not claim a phase is finished when it is not ----
const handoff = loop.slice(loop.indexOf('function buildPhaseHandoffMessage'), loop.indexOf('function shouldForcePhaseValidation'));
assert.match(handoff, /options\.carriedForward/, 'the handoff message knows about a shortfall');
assert.ok(loop.includes('carriedForward: res.carriedForward'), 'and both completion paths pass it');
assert.equal((loop.match(/carriedForward: res\.carriedForward/g) || []).length, 2,
  'BOTH phase-completion call sites pass it (model-final and phase-budget)');

// ---- Behavioural: run the real functions on the exact live scenario ----
const ctx = { module: { exports: {} }, window: {}, console };
vm.createContext(ctx);
// buildPhaseHandoffMessage + buildAgentPlanMarkdown are what produced the false record.
vm.runInContext(loop.slice(loop.indexOf('function buildPhaseHandoffMessage'), loop.indexOf('function shouldForcePhaseValidation')), ctx);
vm.runInContext(core.slice(core.indexOf('function buildAgentPlanMarkdown'), core.indexOf('// Read plan.md back into phases')).replace(/formatAgentPlanSentence/g, 'String'), ctx);

// The message when README.md is carried from Phase 2 into Phase 3.
const carriedMsg = vm.runInContext(
  "buildPhaseHandoffMessage(1, 'Insights, settings, and guide', 2, 'Remaining deliverables', { carriedForward: ['/README.md'] })",
  ctx,
);
assert.match(carriedMsg, /never got written/, 'the user is told it was not written');
assert.match(carriedMsg, /moved it into Phase 3/, 'and where it went');
assert.doesNotMatch(carriedMsg, /is all built|That's Phase 2 finished|is done and in place/,
  'it must not read as a completed phase');

// Last phase with a shortfall: nextIdx === doneIdx, so it must say the phase still owes it.
const stuckMsg = vm.runInContext(
  "buildPhaseHandoffMessage(2, 'Remaining deliverables', 2, 'Remaining deliverables', { carriedForward: ['/README.md'] })",
  ctx,
);
assert.match(stuckMsg, /still owes/, 'the final phase reports the debt instead of advancing');

// A clean phase keeps the normal celebratory handoff — no regression.
const cleanMsg = vm.runInContext("buildPhaseHandoffMessage(0, 'Foundation', 1, 'Insights', {})", ctx);
assert.match(cleanMsg, /Phase 1/, 'a clean phase still hands off normally');
assert.doesNotMatch(cleanMsg, /never got written|still owes/, 'with no shortfall wording');

// And plan.md must render the carried task UNCHECKED — the record that was wrong before.
const planMd = vm.runInContext(`buildAgentPlanMarkdown({
  projectName: 'drone-light-show',
  phases: [
    { title: 'Foundation and dashboard', tasks: [{ text: 'package.json', done: true }] },
    { title: 'Insights, settings, and guide', tasks: [{ text: 'README.md', done: false }] },
    { title: 'Remaining deliverables', tasks: [
      { text: 'src/components/Scene.tsx', done: true },
      { text: 'README.md', done: false },
    ] },
  ],
})`, ctx);
assert.match(planMd, /## Phase 2 · Insights, settings, and guide\n- \[ \] README\.md/,
  'the unwritten deliverable stays unchecked where it was declared');
assert.match(planMd, /## Phase 3 · Remaining deliverables[\s\S]*- \[ \] README\.md/,
  'and appears as outstanding work in the phase it was carried into');
assert.ok(!/- \[x\] README\.md/.test(planMd), 'README.md is never recorded as done while missing');

// ---- v9.9.7: the run that "resumed" and then finalized after two list_dir calls ----
// Real toolEvents at agent_done were: new_project(synthetic, ok) | list_dir | final_check |
// list_dir. Zero files written, README.md owed — and it finalized anyway, because the
// synthetic resume event satisfied agentHasWorkspaceMutations().
const mutations = loop.slice(loop.indexOf('const agentHasWorkspaceMutations'), loop.indexOf('const agentHasUsefulInspectionEvidence'));
assert.match(mutations, /!event\._syntheticResumeContext/,
  'a workspace-rebind marker is not counted as work done this run');
// Behavioural: run the real predicate over the exact event list from the failed run.
const mutCtx = {};
vm.createContext(mutCtx);
vm.runInContext(`${mutations.replace('const agentHasWorkspaceMutations', 'var agentHasWorkspaceMutations')}`.replace(/toolEvents/g, 'EVENTS'), mutCtx);
const check = (events) => {
  mutCtx.EVENTS = events;
  return vm.runInContext('agentHasWorkspaceMutations()', mutCtx);
};
assert.equal(
  check([
    { tool: 'new_project', ok: true, path: '/', _syntheticResumeContext: true },
    { tool: 'list_dir', ok: true }, { tool: 'final_check', ok: true }, { tool: 'list_dir', ok: true },
  ]),
  false,
  'the exact failing run now reports NO mutations',
);
assert.equal(check([{ tool: 'new_project', ok: true, path: '/' }]), true, 'a real new_project still counts');
assert.equal(check([{ tool: 'write_file', ok: true, path: '/README.md' }]), true, 'a real write still counts');
assert.equal(check([{ tool: 'write_file', ok: false, path: '/x' }]), false, 'a failed write does not count');

// Independent of any mutation signal: an owed deliverable blocks auto-finalization.
assert.match(loop, /if \(phaseState && phaseDeliverableNudges < phaseDeliverableNudgeLimit\) \{/,
  'auto-finalize consults the phase file contract');
assert.match(loop, /agent_autofinal_blocked_phase_deliverable/, 'and traces the block');
assert.match(loop, /Do NOT finish yet: this phase still owes/, 'the model is told exactly what is missing');
assert.match(loop, /const phaseDeliverableNudgeLimit = 2;/, 'bounded so an impossible file still ends the run');
const guardBlock = loop.slice(loop.indexOf('if (phaseState && phaseDeliverableNudges < phaseDeliverableNudgeLimit)'),
  loop.indexOf('// Never finish on a red build'));
assert.match(guardBlock, /continue;/, 'it keeps working instead of finalizing');

console.log('PASS: a phase only ticks deliverables that exist, an unwritten one is carried forward instead of vanishing, plan.md never records a missing file as done, a resume marker no longer counts as work, and a phase cannot auto-finish while it still owes a declared file');
