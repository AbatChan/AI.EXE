#!/usr/bin/env node
// Reader for data/logs/agent_raw.jsonl — the raw inference transcript
// (every prompt in, every generation out).
//
//   node scripts/raw_log.js                     last 20 calls, one line each
//   node scripts/raw_log.js --list              runs (chatId) with call counts
//   node scripts/raw_log.js --chat <chatId>     one run, one line per call
//   node scripts/raw_log.js --show 3            full prompt + output of entry #3
//   node scripts/raw_log.js --purpose completion_message --show last
//   node scripts/raw_log.js --grep "ReactCurrentOwner"
//
// --file points at another log (defaults to data/logs/agent_raw.jsonl, and
// falls back to the rotated .1 when the live file is missing).

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const repoRoot = path.resolve(__dirname, '..');
const defaultLog = path.join(repoRoot, 'data', 'logs', 'agent_raw.jsonl');
let logPath = flag('file', defaultLog);
if (!fs.existsSync(logPath) && fs.existsSync(`${logPath}.1`)) logPath = `${logPath}.1`;

if (!fs.existsSync(logPath)) {
  console.error(`No raw log at ${logPath}.`);
  console.error('It is written on every inference once the app runs a build of v10.0.1 or later.');
  process.exit(1);
}

const rows = [];
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try { rows.push(JSON.parse(trimmed)); } catch (_) { /* skip a torn tail line */ }
}

let selected = rows;
const chat = flag('chat');
if (chat) selected = selected.filter((r) => String(r.chatId || '').includes(chat));
const purpose = flag('purpose');
if (purpose) selected = selected.filter((r) => String(r.purpose || '').includes(purpose));
const grep = flag('grep');
if (grep) {
  const rx = new RegExp(grep, 'i');
  selected = selected.filter((r) => rx.test(String(r.prompt || '')) || rx.test(String(r.output || '')));
}

if (has('list')) {
  const runs = new Map();
  rows.forEach((r) => {
    const key = String(r.chatId || '(none)');
    const entry = runs.get(key) || { calls: 0, chars: 0, first: r.ts, last: r.ts };
    entry.calls += 1;
    entry.chars += Number(r.promptChars || 0) + Number(r.outputChars || 0);
    entry.last = r.ts;
    runs.set(key, entry);
  });
  const shown = path.relative(repoRoot, logPath);
  console.log(`${rows.length} calls in ${shown.startsWith('..') ? logPath : shown}\n`);
  for (const [id, e] of runs) {
    console.log(`${id.padEnd(24)} ${String(e.calls).padStart(4)} calls  ${(e.chars / 1000).toFixed(0).padStart(6)}k chars  ${e.first} → ${e.last}`);
  }
  process.exit(0);
}

const show = flag('show');
if (show) {
  const index = show === 'last' ? selected.length - 1 : Number(show);
  const row = selected[index];
  if (!row) {
    console.error(`No entry ${show} (have ${selected.length}).`);
    process.exit(1);
  }
  const rule = (label) => `\n${'='.repeat(20)} ${label} ${'='.repeat(20)}`;
  console.log(`#${index}  ${row.ts}  ${row.purpose}  model=${row.model || '?'}  ok=${row.ok}  ${row.ms}ms  chat=${row.chatId || '-'}`);
  if (row.error) console.log(`error: ${row.error}`);
  if (row.systemPrompt) { console.log(rule('SYSTEM')); console.log(row.systemPrompt); }
  console.log(rule(`PROMPT (${row.promptChars} chars)`));
  console.log(row.prompt || '(empty)');
  console.log(rule(`OUTPUT (${row.outputChars} chars)`));
  console.log(row.output || '(empty)');
  process.exit(0);
}

const tail = Number(flag('tail', 20));
const view = selected.slice(-Math.max(1, tail));
console.log(`${selected.length} matching calls — showing last ${view.length}. Use --show <n> for the full text.\n`);
view.forEach((row, offset) => {
  const index = selected.length - view.length + offset;
  const preview = String(row.output || '').replace(/\s+/g, ' ').slice(0, 70);
  console.log(
    `${String(index).padStart(4)}  ${String(row.ts || '').slice(11, 19)}  ${String(row.purpose || '?').padEnd(20)}`
    + `${row.ok ? 'ok ' : 'ERR'} ${String(row.promptChars || 0).padStart(7)}p ${String(row.outputChars || 0).padStart(6)}o  ${preview}`,
  );
});
