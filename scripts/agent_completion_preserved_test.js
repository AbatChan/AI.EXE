// v9.7.6 — the completion truth-gate must correct a message that lies, and keep one that
// already tells the truth.
//
// Regression: the model wrote "Heads up — not verified yet: these files changed after the
// last successful build, so the current code hasn't been confirmed to compile… Also one
// real issue: ControlDock.tsx imports @/lib/store, but the store lives at
// @/store/useSwarmStore. Next step: npm install && npm run build." — i.e. exactly what the
// gate exists to enforce, plus the actual defect and the actual command. The gate replaced
// it wholesale with a generic sentence, so the user lost the only actionable detail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'ui', 'agent-runtime.js'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');

// ---- Wiring ----
assert.match(runtime, /function completionAlreadyDisclosesRisk\(text, outcome = null\)/, 'the gate can recognize a compliant message');
assert.match(runtime, /function openContractIssueLines\(toolEvents, max = 2\)/, 'a replaced message can still name real findings');
assert.match(runtime, /agent_completion_truth_gate_kept/, 'keeping a message is traced, not silent');
assert.match(runtime, /Still open: \$\{openIssues\.join\('; '\)\}/, 'the replacement carries the open findings');

// ---- Behaviour: run the real predicate ----
const start = runtime.indexOf('function completionAlreadyDisclosesRisk(text, outcome = null)');
const end = runtime.indexOf('function openContractIssueLines(');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${runtime.slice(start, end)}\nthis.api = { completionAlreadyDisclosesRisk };`, sandbox);
const { completionAlreadyDisclosesRisk: discloses } = sandbox.api;

// The real message from the run that triggered this fix.
const realMessage = `SWARM is wired up, mathew! Here's what just landed:
- /src/lib/droneEngine.ts — boid flocking engine
Heads up — not verified yet: the validator flagged that these files changed after the last
successful build, so the current code hasn't been confirmed to compile/pass. Also one real
issue: /src/components/ControlDock.tsx imports from @/lib/store, but the store lives at
@/store/useSwarmStore. Next step: run npm install && npm run build.`;
assert.equal(discloses(realMessage), true, 'the message that started this is kept');

[
  'I changed three files. They have not been verified yet — run the build to confirm.',
  'Wrote the store and the scene. This still needs to be built and checked before it is done.',
  'Added the timeline. Not confirmed working yet; press Run to try it.',
].forEach((text) => assert.equal(discloses(text), true, `honest message kept: ${text.slice(0, 40)}`));

// A success claim always wins over a disclosure — anything ambiguous is still replaced.
[
  'All done! The app is complete and working.',
  'Fixed it — the build passes cleanly now.',
  'Everything is now working. It has not been verified on mobile, but desktop is complete.',
  'Task complete. Not verified on Windows.',
  'The drone show is fully functional and ready to ship.',
  '',
  'Updated the files.',
  'I created the store, the engine, and the scene components.',
].forEach((text) => assert.equal(discloses(text), false, `claim or silence is replaced: ${text.slice(0, 40) || '(empty)'}`));

// A scoped fix reported alongside an explicit "still failing" is honest on both counts.
// Regression: "The PostCSS error is resolved, but the build is still failing" was replaced
// because of the first clause, losing an accurate and far more useful message.
assert.equal(discloses('The PostCSS error is resolved, but the build is still failing on type errors.'), true,
  'a scoped fix plus an explicit current failure is kept');
assert.equal(discloses('Fixed the imports. The build still fails — nine type errors remain in ColorPanel.'), true,
  'naming the current failure keeps the message');
// Still replaced when the message claims overall success with no current-failure statement.
assert.equal(discloses('Fixed the PostCSS config — the build passes cleanly now.'), false,
  'an overall success claim with no failure statement is still replaced');

// ---- "Still open" must not quote findings the run already repaired ----
// Regression: the gate's own replacement said ColorPanel imports "@/lib/store" after the
// run had edited that exact import — the truth-gate asserting something untrue.
assert.match(runtime, /const touchedSince = new Set\(\);/, 'files changed since the check are tracked');
assert.match(runtime, /events\.slice\(i \+ 1\)/, 'only events AFTER the check count');
const openFn = runtime.slice(runtime.indexOf('function openContractIssueLines'), runtime.indexOf('function enforceCompletionTruth'));
assert.match(openFn, /\['write_file', 'edit_file', 'write_files', 'move', 'delete'\]/, 'every kind of mutation clears a finding');
assert.match(openFn, /autoWrittenFiles/, 'batch-written files clear their findings too');
assert.match(openFn, /!touchedSince\.has\(deps\.normalizeWorkspacePath\(owner\)\)/, 'a repaired file is dropped from "Still open"');

// ---- The polish guard must not block a REPAIR of a truncated write ----
// Regression: a component saved cut off mid-file; the model correctly asked to regenerate
// it whole and got "full rewrite prevented — targeted edit required".
assert.match(loop, /if \(String\(event\.structuralIssue \|\| ''\)\.trim\(\)\) return false;/,
  'a structurally incomplete write does not count as a clean write');
const guardFn = loop.slice(loop.indexOf('const lastWriteWithoutFailureSince'), loop.indexOf('return sawCleanWrite;'));
assert.ok(guardFn.indexOf('structuralIssue') < guardFn.indexOf('sawCleanWrite = true'),
  'the incompleteness check runs BEFORE the write is treated as clean');

console.log('PASS: a completion that already states it is unverified survives the gate; claims and silence are still replaced, now naming the open findings; regenerating a truncated file is no longer blocked');

// ---- v9.7.8: a wrong VERDICT must not destroy a correct analysis ----
// Regression: the model opened "Fixed the ReactCurrentOwner crash" (false — no browser run)
// but the same message carried the correct root cause and the real fix ("upgrade
// @react-three/fiber to v9"). Replacing wholesale threw the useful half away.
assert.match(runtime, /const survivingDetail = String\(text \|\| ''\)\.split\('\\n'\)/, 'the message is salvaged line by line');
assert.match(runtime, /survivingDetail\.length >= 80 \? `\$\{corrected\}/, 'the correction leads, the detail follows');
const salvage = runtime.slice(runtime.indexOf('const survivingDetail'), runtime.indexOf('// The correction leads'));
assert.match(salvage, /fixed\|resolved\|solved\|done\|complete/, 'claim lines are the ones dropped');
assert.match(salvage, /before\|until\|once\|unless\|when\|after\|not\|never/, 'negated/conditional lines are not falsely dropped');

// ---- v9.7.8: the caret-mangling phantom ----
// Regression: every view of package.json showed "^1^.17.10" while node reported 8.18.0 —
// the model spent a whole run repairing a file that was already correct.
const executorSrc = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');
assert.match(executorSrc, /function buildCaretFreeDependencyNote\(path, content\)/, 'the caret-free restatement exists');
assert.match(executorSrc, /observation: observation \+ buildCaretFreeDependencyNote\(path, body\)/, 'it is attached to every package.json read');
const noteStart = executorSrc.indexOf('function buildCaretFreeDependencyNote');
const noteSandbox = { console };
vm.createContext(noteSandbox);
vm.runInContext(`${executorSrc.slice(noteStart, executorSrc.indexOf('function repairPackageJsonDependencyVersions'))}\nthis.api = { buildCaretFreeDependencyNote };`, noteSandbox);
const note = noteSandbox.api.buildCaretFreeDependencyNote('/package.json', JSON.stringify({
  dependencies: { '@react-three/fiber': '^8.17.10', react: '^18.3.1' },
  devDependencies: { typescript: '~5.5.4' },
}));
assert.doesNotMatch(note, /\^/, 'the note contains no caret at all — the character is the trigger');
assert.match(note, /@react-three\/fiber = caret 8\.17\.10/, 'the real version is stated in words');
assert.match(note, /typescript = tilde 5\.5\.4/, 'tilde ranges are restated too');
assert.match(note, /display artifact, NOT the file/, 'the model is told the file is not corrupt');
assert.equal(noteSandbox.api.buildCaretFreeDependencyNote('/src/app/page.tsx', 'whatever'), '', 'only package.json gets the note');
assert.equal(noteSandbox.api.buildCaretFreeDependencyNote('/package.json', 'not json'), '', 'unparseable manifests are skipped');

console.log('PASS: a false verdict is corrected without discarding the analysis; package.json versions are restated in a form the render channel cannot mangle');

// ---- v9.8.0: never auto-finalize on top of a RED build ----
// Regression: the run ended at step 19 of 28 with the build failing and its own message
// listing the remaining type errors as "next steps" — the harness stopped instead.
assert.match(loop, /const latestBuildIsFailing = \(\) => \{/, 'the latest build outcome is checked');
assert.match(loop, /if \(!redBuildContinuationUsed && latestBuildIsFailing\(\) && \(executionStepLimit - step\) >= 3\)/,
  'auto-finalize is blocked once while the build is red and steps remain');
assert.match(loop, /agent_autofinal_blocked_red_build/, 'the override is traced');
const redGuard = loop.slice(loop.indexOf('if (!redBuildContinuationUsed'), loop.indexOf('agent_autofinal_blocked_red_build'));
assert.match(redGuard, /redBuildContinuationUsed = true;/, 'it is granted only ONCE so an unfixable error still ends the run');
assert.match(loop, /If they cannot be fixed, say so plainly instead of finishing quietly/,
  'the model is told to disclose rather than finish quietly');

console.log('PASS: a red build blocks one auto-finalization instead of ending the run with unused steps');

// ---- v9.8.1: no caret in the manifest the model has to emit ----
// Proven live: Venice returns "^1^.0.0" even inside a ```json fence, so the corruption is
// upstream of the DOM and the Copy payload carries it too. Exact pins have no range
// character, so nothing can be renumbered.
const core = fs.readFileSync(path.join(root, 'ui', 'agent-core.js'), 'utf8');
assert.match(core, /if \(\/\(\?:\^\|\\\/\)package\\\.json\$\/i\.test\(normalized\)\) \{/, 'package.json gets its own generation rule');
assert.match(core, /EXACT version with no range prefix/, 'exact pins are required');
assert.match(core, /corrupted in transit/, 'the reason is stated so it is not "cleaned up" later');

console.log('PASS: package.json generation asks for exact pins, removing the character the channel corrupts');

// ---- v9.9.8: the verdict is a token, not prose ----
// Prose matching is English-only; the verdict now rides a fixed token instead.
assert.match(runtime, /COMPLETION_STATUS_TOKENS = \{/, 'the status token exists');
assert.match(runtime, /statusLineRule/, 'the completion prompt asks for it');
assert.match(runtime, /if \(declared === 'UNVERIFIED'\)/, 'a declared-unverified message is kept');
assert.ok(runtime.indexOf("if (declared === 'UNVERIFIED')") < runtime.indexOf('completionAlreadyDisclosesRisk(text, o)'),
  'the token is read BEFORE any prose matching');
assert.match(runtime, /!declared && completionAlreadyDisclosesRisk/, 'prose heuristics are the fallback only');
const aiExeSrc = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
assert.match(aiExeSrc, /AIEXE_STATUS/, 'the renderer strips the token as a backstop');

const tokenStart = runtime.indexOf('const COMPLETION_STATUS_TOKENS');
const tokenEnd = runtime.indexOf('// Keyed to the held outcome');
const tokenSandbox = { console };
vm.createContext(tokenSandbox);
vm.runInContext(`${runtime.slice(tokenStart, tokenEnd)}\nthis.api = { readCompletionStatusToken, stripCompletionStatusToken };`, tokenSandbox);
const { readCompletionStatusToken: readTok, stripCompletionStatusToken: stripTok } = tokenSandbox.api;
const UNV = '[[AIEXE_STATUS:UNVERIFIED]]';
[
  ['english', `Wrote the store. Build still red.\n${UNV}`],
  ['pidgin', `I don write the files but e never build finish o.\n${UNV}`],
  ['yoruba', `Mo ti kọ àwọn fáìlì náà, ṣùgbọ́n kò tíì ṣiṣẹ́.\n${UNV}`],
  ['french', `J'ai écrit les fichiers, mais la compilation échoue encore.\n${UNV}`],
  ['chinese', `已写入文件，但构建仍然失败。\n${UNV}`],
].forEach(([lang, text]) => {
  assert.equal(readTok(text), 'UNVERIFIED', `${lang} verdict is read without parsing prose`);
  assert.doesNotMatch(stripTok(text), /AIEXE_STATUS/, `${lang} token never reaches the user`);
});
assert.equal(readTok('All done, it works!\n[[AIEXE_STATUS:VERIFIED]]'), 'VERIFIED', 'a success claim still declares VERIFIED');
assert.equal(readTok('Wrote the store.'), '', 'no token falls back to the prose heuristics');

console.log('PASS: the completion verdict is read from a fixed token, so an honest message survives in any language');
