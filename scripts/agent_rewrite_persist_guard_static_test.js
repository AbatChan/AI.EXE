const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-runtime.js'), 'utf8');
const executor = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-executor.js'), 'utf8');

// A partial generation pass must never overwrite an existing file before the
// executor's revert/structure guards run — a first-pass model refusal once
// replaced a 43K app.js with its own prose (v7.8.6 chess-app data loss).
assert.match(runtime, /const persistPartials = Boolean\(options && options\.persistPartials === true\);/, 'generateFullAgentFile requires an explicit partial-persistence opt-in');
assert.match(runtime, /if \(!persistPartials\) return;/, 'persistPartial honors the switch');
assert.match(runtime, /generateFullAgentFile\(prompt, path, \{ persistPartials: false \}\)/, 'rewrite-existing path never persists partial passes');
assert.doesNotMatch(executor, /\{ persistPartials: creatingNewFile \}/, 'new-file generation does not save incomplete passes to disk');
assert.match(executor, /generateAgentWriteFileContent\([\s\S]{0,240}\{ persistPartials: false \}\)/, 'write path commits only the completed generated file');
assert.match(executor, /originalContent\.length > 22000/, 'oversized files are blocked from the whole-file rewrite fallback');

console.log('PASS: partial generations cannot clobber existing files; oversized rewrites are refused.');
