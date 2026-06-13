// Unit tests for two agent reliability mechanisms:
//   1. selectRelevantOlderEvents (agent-planner.js) — relevance-ranked context:
//      task-relevant OLDER tool results are carried forward instead of being
//      dropped by the pure last-N recency window.
//   2. deriveAgentFailureSignature (agent-loop.js) — the bounded self-correction
//      circuit breaker's failure signature: same file + same issue must produce a
//      stable streakKey (so repeats accumulate), and a different issue / passing
//      validation must produce a different (or null) signature (so a real fix
//      resets the streak instead of stopping the run).
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-planner.js'));
require(path.join(__dirname, '..', 'ui', 'agent-loop.js'));
require(path.join(__dirname, '..', 'ui', 'agent-runtime.js'));

function normalizeWorkspacePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s) return '/';
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

// selectRelevantOlderEvents is a pure helper; createAgentPlanner only binds deps
// to consts, so an empty deps object is enough to obtain the API.
const planner = global.AIExeAgentPlanner.createAgentPlanner({ normalizeWorkspacePath });
const { selectRelevantOlderEvents } = planner;
const { deriveAgentFailureSignature } = global.AIExeAgentLoop;
const runtime = global.AIExeAgentRuntime.createAgentRuntime({});
const { looksTruncatedFileContent, stitchFileContinuation } = runtime;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`PASS: ${name}`);
  passed += 1;
}

// ---------------------------------------------------------------------------
// 1. selectRelevantOlderEvents
// ---------------------------------------------------------------------------

// Older events: a relevant style.css read buried early, plus noise.
const olderEvents = [
  { tool: 'list_dir', path: '/', ok: true, observation: 'index.html style.css script.js' },
  { tool: 'read_file', path: '/style.css', ok: true, observation: '.totals-row { color: red; } dark mode theme toggle' },
  { tool: 'read_file', path: '/unrelated-notes.txt', ok: true, observation: 'lorem ipsum dolor sit amet' },
  { tool: 'search_files', path: '/', ok: true, observation: 'no matches for foobar' },
];

// Task focuses on the totals row styling — should surface /style.css.
const focusedTask = 'tweak the styling on the totals row to look cleaner';
const planSpec = { affectedFiles: ['/style.css'], filesToInspect: [], expectedFiles: [] };

const relevant = selectRelevantOlderEvents(olderEvents, focusedTask, planSpec, 3);
ok('relevant older selection surfaces the matching /style.css read',
  relevant.some((e) => e.path === '/style.css'));
ok('relevant older selection drops the unrelated notes file',
  !relevant.some((e) => e.path === '/unrelated-notes.txt'));
ok('relevant older selection preserves chronological order',
  relevant.map((e) => olderEvents.indexOf(e)).every((v, i, a) => i === 0 || a[i - 1] < v));

// A failure in the older window should be boosted even with weak keyword overlap.
const olderWithFailure = [
  { tool: 'edit_file', path: '/app.js', ok: false, observation: 'edit_file blocked for /app.js: unterminated string' },
  { tool: 'read_file', path: '/misc.md', ok: true, observation: 'changelog notes' },
];
const relevantFail = selectRelevantOlderEvents(olderWithFailure, 'fix the app', { affectedFiles: ['/app.js'] }, 2);
ok('failures in the older window are carried forward',
  relevantFail.some((e) => e.path === '/app.js' && e.ok === false));

// No keyword overlap / empty inputs must not throw and must return [].
ok('empty older events returns empty', selectRelevantOlderEvents([], focusedTask, planSpec, 3).length === 0);
ok('no focus keywords returns empty', selectRelevantOlderEvents(olderEvents, '', {}, 3).length === 0);

// ---------------------------------------------------------------------------
// 2. deriveAgentFailureSignature
// ---------------------------------------------------------------------------

const validateBadA = {
  ok: true,
  validationPassed: false,
  validationIssues: ['/script.js: unterminated string literal at line 42'],
};
const validateBadAagain = {
  ok: true,
  validationPassed: false,
  validationIssues: ['/script.js: unterminated string literal at line 99'], // different line number only
};
const validateBadAdifferentIssue = {
  ok: true,
  validationPassed: false,
  validationIssues: ['/script.js: missing semicolon'],
};
const validatePass = { ok: true, validationPassed: true, validationIssues: [] };
const writeOk = { ok: true, observation: 'write_file ok: /script.js (1200 chars)' };
const decisionValidate = { tool: 'validate_files' };

const sigA = deriveAgentFailureSignature(decisionValidate, validateBadA, normalizeWorkspacePath);
const sigAagain = deriveAgentFailureSignature(decisionValidate, validateBadAagain, normalizeWorkspacePath);
const sigAdiff = deriveAgentFailureSignature(decisionValidate, validateBadAdifferentIssue, normalizeWorkspacePath);

ok('validation failure produces a signature', sigA && typeof sigA.streakKey === 'string');
ok('same file + same issue (only line number differs) yields the SAME streakKey — so repeats accumulate',
  sigA.streakKey === sigAagain.streakKey);
ok('same file + DIFFERENT issue yields a DIFFERENT streakKey — so a real fix resets the streak',
  sigA.streakKey !== sigAdiff.streakKey);
ok('signature extracts the failing path from the issue text', sigA.streakPath === '/script.js');

ok('passing validation produces no signature (streak reset path)',
  deriveAgentFailureSignature(decisionValidate, validatePass, normalizeWorkspacePath) === null);
ok('a successful write produces no signature',
  deriveAgentFailureSignature({ tool: 'write_file' }, writeOk, normalizeWorkspacePath) === null);

// Hard edit_file failure is also a tracked signature; a guidance block on a
// read_file is not.
const editFail = { ok: false, observation: "edit_file blocked for /index.html: old_string not found" };
ok('hard edit_file failure produces a signature',
  deriveAgentFailureSignature({ tool: 'edit_file', path: '/index.html' }, editFail, normalizeWorkspacePath) !== null);
ok('a non-edit/non-validate failure is ignored by the breaker',
  deriveAgentFailureSignature({ tool: 'read_file', path: '/x' }, { ok: false, observation: 'read_file failed' }, normalizeWorkspacePath) === null);

// Simulate the streak counter to prove a 3x repeat trips, but an interleaved fix
// resets it (the behavior the live loop relies on).
function runStreak(results) {
  const streak = { key: '', count: 0 };
  let stopped = false;
  for (const r of results) {
    const sig = deriveAgentFailureSignature(r.decision, r.result, normalizeWorkspacePath);
    if (sig) {
      if (sig.streakKey === streak.key) streak.count += 1;
      else { streak.key = sig.streakKey; streak.count = 1; }
      if (streak.count >= 3) { stopped = true; break; }
    } else if (String(r.decision.tool).toLowerCase() === 'validate_files' && r.result.validationPassed === true) {
      streak.key = ''; streak.count = 0;
    }
  }
  return stopped;
}

ok('three identical failures in a row trips the breaker', runStreak([
  { decision: decisionValidate, result: validateBadA },
  { decision: decisionValidate, result: validateBadAagain },
  { decision: decisionValidate, result: validateBadA },
]) === true);

ok('a passing validation between failures prevents the breaker from tripping', runStreak([
  { decision: decisionValidate, result: validateBadA },
  { decision: decisionValidate, result: validateBadAagain },
  { decision: decisionValidate, result: validatePass },
  { decision: decisionValidate, result: validateBadA },
]) === false);

// ---------------------------------------------------------------------------
// 3. looksTruncatedFileContent + stitchFileContinuation (truncation recovery)
// ---------------------------------------------------------------------------

// The exact failure from the trace: CSS cut off mid-rule (unbalanced braces).
const truncatedCss = `.category-card {\n  background: #fff;\n  display: flex;\n  justify-content`;
ok('truncated CSS (mid-rule, unbalanced braces) is detected',
  looksTruncatedFileContent(truncatedCss, '/style.css') === true);

const completeCss = `:root { --x: 1px; }\n.card {\n  display: flex;\n  gap: var(--x);\n}\n`;
ok('complete, brace-balanced CSS is NOT flagged as truncated',
  looksTruncatedFileContent(completeCss, '/style.css') === false);

// JS cut off mid-function (the trace's script.js ended at "// ===== Render:").
const truncatedJs = `function renderAll() {\n  renderSummary();\n  // ===== Render:`;
ok('truncated JS (unbalanced braces) is detected',
  looksTruncatedFileContent(truncatedJs, '/script.js') === true);

const completeJs = `function add(a, b) {\n  return a + b;\n}\nadd(1, 2);\n`;
ok('complete JS is NOT flagged as truncated',
  looksTruncatedFileContent(completeJs, '/script.js') === false);

const unterminatedComment = `/* Ledgerly stylesheet */\n:root { --x: 1px; }\n.card { color: red; }\n/* TODO: dark theme`;
ok('CSS with an unterminated /* comment is detected as truncated',
  looksTruncatedFileContent(unterminatedComment, '/style.css') === true);

const truncatedHtml = `<!DOCTYPE html>\n<html lang="en">\n<head><title>x</title></head>\n<body>\n<header>`;
ok('HTML with an open <html> and no closing tag is detected as truncated',
  looksTruncatedFileContent(truncatedHtml, '/index.html') === true);

ok('empty content is not treated as truncated (handled elsewhere)',
  looksTruncatedFileContent('', '/style.css') === false);

// Stitching: a continuation that repeats the shown tail should not duplicate it.
const base = 'aaa.card {\n  display: flex;\n  justify-content';
const cont = ': center;\n}\n.footer { color: red; }\n';
ok('stitching appends the continuation', stitchFileContinuation(base, cont).endsWith('.footer { color: red; }\n'));
ok('stitched result starts with the base', stitchFileContinuation(base, cont).startsWith('aaa.card {'));

const overlap = base.slice(-40) + ': center;\n}\n';
ok('stitching drops a repeated tail seam (no duplication)',
  (stitchFileContinuation(base, overlap).match(/justify-content/g) || []).length === 1);

// countInspectionsSinceMutation (agent-loop.js) — drives the inspection-budget
// guard. Counts ok read_file + search_files since the last ok mutation; the
// weak model evaded the per-file read guard by switching read->search and
// hopping files, so both inspection kinds must count, and a mutation must reset.
const { countInspectionsSinceMutation } = global.AIExeAgentLoop;

ok('no events -> zero inspections', countInspectionsSinceMutation([]) === 0);

ok('read + search both count toward the budget',
  countInspectionsSinceMutation([
    { tool: 'read_file', ok: true },
    { tool: 'search_files', ok: true },
    { tool: 'read_file', ok: true },
  ]) === 3);

ok('a successful mutation resets the count (only post-mutation inspections count)',
  countInspectionsSinceMutation([
    { tool: 'read_file', ok: true },
    { tool: 'read_file', ok: true },
    { tool: 'edit_file', ok: true },
    { tool: 'search_files', ok: true },
  ]) === 1);

ok('failed/blocked inspections do not count',
  countInspectionsSinceMutation([
    { tool: 'read_file', ok: true },
    { tool: 'read_file', ok: false },
    { tool: 'search_files', ok: false },
  ]) === 1);

ok('the movie-library evasion pattern (read+search hopping) trips the >=8 budget',
  countInspectionsSinceMutation([
    { tool: 'read_file', ok: true, path: '/index.html' },
    { tool: 'read_file', ok: true, path: '/style.css' },
    { tool: 'read_file', ok: true, path: '/script.js' },
    { tool: 'read_file', ok: true, path: '/style.css' },
    { tool: 'search_files', ok: true, path: '/' },
    { tool: 'read_file', ok: true, path: '/index.html' },
    { tool: 'search_files', ok: true, path: '/style.css' },
    { tool: 'search_files', ok: true, path: '/script.js' },
  ]) >= 8);

// evaluateRepeatedRead (agent-loop.js) — the range/truncation-aware read-loop
// guard. It must let a model PAGE through a file too big for one read window
// (the truncation that forced the spiral the user asked about) while still
// blocking redundant re-reads, fully-seen re-reads, and runaway paging.
const { evaluateRepeatedRead } = global.AIExeAgentLoop;
const rd = (startLine, endLine, offset, truncated) => ({
  tool: 'read_file', ok: true, path: '/script.js',
  startLine, endLine, offset,
  observation: truncated ? 'read_file /script.js ...[file continues — call read_file with offset:...]' : 'read_file /script.js (complete)',
});

ok('first read of a file is always allowed',
  evaluateRepeatedRead([], '/script.js', '0:0:0') === null);

ok('exact same range read again is blocked as a redundant re-read',
  evaluateRepeatedRead([rd(10, 50, 0, false)], '/script.js', '10:50:0') === 'exact-repeat');

ok('paging forward while the last read was truncated is ALLOWED (the fix)',
  evaluateRepeatedRead([rd(0, 0, 0, true), rd(0, 0, 16000, true)], '/script.js', '0:0:32000') === null);

ok('a BROAD (full) re-read of a fully-seen file is blocked as already-seen',
  evaluateRepeatedRead([rd(1, 200, 0, false), rd(201, 400, 0, false)], '/script.js', '0:0:0') === 'already-seen');

// Changed contract (v2.5.5): a ranged read fully covered by a recent untruncated
// read is pure waste — the expanded in-prompt content serves "focusing to edit".
ok('a TARGETED subset of a fully-seen file is blocked as subset-of-recent-read',
  evaluateRepeatedRead([rd(0, 0, 0, false), rd(0, 0, 0, false)], '/script.js', '469:600:0') === 'subset-of-recent-read');

ok('the overlapping 1-50 then 1-30 pattern is blocked',
  evaluateRepeatedRead([rd(1, 50, 0, false)], '/script.js', '1:30:0') === 'subset-of-recent-read');

ok('a ranged read BEYOND the prior range is still allowed',
  evaluateRepeatedRead([rd(1, 50, 0, false)], '/script.js', '40:120:0') === null);

ok('a subset of a TRUNCATED read is still allowed (content was incomplete)',
  evaluateRepeatedRead([rd(0, 0, 0, true)], '/script.js', '10:20:0') === null);

ok('a single prior full read blocks covered ranges too',
  evaluateRepeatedRead([rd(0, 0, 0, false)], '/script.js', '240:350:0') === 'subset-of-recent-read');

ok('runaway paging hits the hard cap',
  evaluateRepeatedRead(
    [rd(0, 0, 0, true), rd(0, 0, 5000, true), rd(0, 0, 10000, true), rd(0, 0, 15000, true), rd(0, 0, 20000, true), rd(0, 0, 25000, true)],
    '/script.js', '0:0:30000') === 'hard-cap');

ok('reads of a DIFFERENT file do not count toward this file',
  evaluateRepeatedRead([
    { tool: 'read_file', ok: true, path: '/style.css', startLine: 0, endLine: 0, offset: 0, observation: 'x' },
    { tool: 'read_file', ok: true, path: '/style.css', startLine: 0, endLine: 0, offset: 5000, observation: 'x' },
  ], '/script.js', '0:0:0') === null);

// Mutation resets the read count: after the agent EDITS a file, re-reading it to
// verify the change is legitimate — earlier (stale) reads must not block it.
ok('an edit resets prior reads — re-read after edit is allowed',
  evaluateRepeatedRead([
    rd(0, 0, 0, false), rd(1, 200, 0, false),            // fully seen (would be "already-seen")
    { tool: 'edit_file', ok: true, path: '/script.js' }, // ...but then we edit it
  ], '/script.js', '1:200:0') === null);

ok('exact-repeat still blocks AFTER an edit if that same range was re-read post-edit',
  evaluateRepeatedRead([
    rd(0, 0, 0, false),
    { tool: 'edit_file', ok: true, path: '/script.js' },
    rd(1, 50, 0, false),                                 // post-edit read of 1-50
  ], '/script.js', '1:50:0') === 'exact-repeat');

console.log(`\nPassed ${passed} agent retry/context tests.`);
