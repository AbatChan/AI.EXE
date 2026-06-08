// Unit tests for the harness-driven checklist progress tracker (agent-core.js).
// The planner emits doneCriteria (user-term sub-goals); the harness marks each
// item done MECHANICALLY once a successful edit/write whose target or content
// matches the item's distinctive keywords has landed — because our model is too
// weak to self-tick a task list reliably (unlike Claude Code's model-driven Task
// tools). These tests pin: keyword->edit matching, generic-item crediting,
// not-done before work, and the rendered checkbox markdown + count.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));

const core = global.AIExeAgentCore.createAgentCore({});
const { computeAgentChecklistProgress, renderAgentChecklist } = core;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`PASS: ${name}`);
  passed += 1;
}

const items = ['resize search close icon', 'redesign movie cards', 'no class/id mismatches'];

// Nothing edited yet -> nothing done.
{
  const p = computeAgentChecklistProgress(items, []);
  ok('no work -> all items not done', p.length === 3 && p.every((x) => !x.done));
}

// An edit to style.css whose content addresses the close icon + cards marks
// those items done via keyword match; the mismatch item stays open.
{
  const events = [
    { tool: 'edit_file', ok: true, path: '/style.css',
      content: '#search-clear { width: 16px; } .movie-card { border-radius: 12px; }' },
  ];
  const p = computeAgentChecklistProgress(items, events);
  const byText = Object.fromEntries(p.map((x) => [x.text, x.done]));
  ok('close-icon item marked done by keyword (search) match', byText['resize search close icon'] === true);
  ok('cards item marked done by keyword (movie/cards) match', byText['redesign movie cards'] === true);
  ok('unaddressed mismatch item stays open', byText['no class/id mismatches'] === false);
}

// A failed edit does NOT count as progress.
{
  const events = [{ tool: 'edit_file', ok: false, path: '/style.css', content: '#search-clear {}' }];
  const p = computeAgentChecklistProgress(items, events);
  ok('failed edit does not mark items done', p.every((x) => !x.done));
}

// A generic criterion with no distinctive keyword is credited once real work
// shipped AND validation passed (the all-stopword case).
{
  const generic = ['it should look good and work'];
  const noWork = computeAgentChecklistProgress(generic, []);
  ok('generic item not done before any work', noWork[0].done === false);
  const events = [
    { tool: 'edit_file', ok: true, path: '/style.css', content: '.x{}' },
    { tool: 'validate_files', ok: true, validationPassed: true },
  ];
  const done = computeAgentChecklistProgress(generic, events);
  ok('generic item credited after shipped+validated work', done[0].done === true);
}

// Render: checkbox markdown + accurate count header.
{
  const p = computeAgentChecklistProgress(items, [
    { tool: 'edit_file', ok: true, path: '/style.css', content: '#search-clear{} .movie-card{}' },
  ]);
  const md = renderAgentChecklist(p);
  ok('render shows the progress count header', md.includes('**Plan (2/3)**'));
  ok('render uses checked + unchecked boxes', md.includes('- [x] resize search close icon') && md.includes('- [ ] no class/id mismatches'));
  ok('empty checklist renders empty string', renderAgentChecklist([]) === '');
}

console.log(`\n${passed} passed`);
