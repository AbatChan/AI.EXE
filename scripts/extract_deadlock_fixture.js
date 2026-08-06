#!/usr/bin/env node
// Extract real agent runs from debug_trace.jsonl into a replay fixture.
// Re-run to capture a new deadlock: node scripts/extract_deadlock_fixture.js <chatIdSuffix> [...]
// The fixture is a RECORDING, not a hand-written scenario — that is the whole point:
// a scenario invented by whoever wrote the fix can only ever confirm the fix's theory.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const root = path.join(__dirname, '..');
const LOG = path.join(root, 'data', 'logs', 'debug_trace.jsonl');
const OUT = path.join(__dirname, 'fixtures', 'agent_guard_deadlock_runs.json');

const wanted = process.argv.slice(2);
if (!wanted.length) {
  console.error('usage: node scripts/extract_deadlock_fixture.js <chatIdSuffix> [...]');
  process.exit(2);
}

const CAP = 1500; // keep fixtures reviewable; true lengths are preserved separately

const runs = new Map();
const stream = readline.createInterface({ input: fs.createReadStream(LOG) });

stream.on('line', (line) => {
  const suffix = wanted.find((w) => line.includes(w));
  if (!suffix) return;
  let entry = null;
  try { entry = JSON.parse(line); } catch (_) { return; }
  const kind = String(entry.kind || '');
  if (!/^agent_/.test(kind)) return;
  const chatId = String(entry.chatId || '');
  if (!chatId || !chatId.includes(suffix)) return;
  if (!runs.has(chatId)) runs.set(chatId, { chatId, model: '', events: [] });
  const run = runs.get(chatId);
  if (entry.plannerModel && !run.model) run.model = String(entry.plannerModel);

  const clip = (text) => {
    const full = String(text == null ? '' : text);
    return { text: full.slice(0, CAP), length: full.length };
  };

  if (kind === 'agent_planner_output') {
    const raw = clip(entry.rawPlannerOutput);
    run.events.push({
      kind, step: Number(entry.step || 0), source: String(entry.plannerSource || ''),
      rawPlannerOutput: raw.text, rawPlannerOutputLength: raw.length,
    });
    return;
  }
  if (kind === 'agent_tool_result') {
    const obs = clip(entry.observation);
    const content = clip(entry.readContent != null ? entry.readContent : entry.writtenContent);
    run.events.push({
      kind, step: Number(entry.step || 0),
      tool: String(entry.tool || ''), ok: Boolean(entry.ok),
      observation: obs.text, observationLength: obs.length,
      content: content.text, contentLength: content.length,
      path: String(entry.readPath || entry.writtenPath || ''),
      offset: Number(entry.offset || 0),
      startLine: Number(entry.startLine || 0),
      endLine: Number(entry.endLine || 0),
    });
    return;
  }
  // Guard blocks that short-circuit before the executor emit their own kind and
  // never produce an agent_tool_result — without these the timeline looks idle.
  if (/blocked|deadlock|served_from_cache|_done$/.test(kind)) {
    run.events.push({
      kind, step: Number(entry.step || 0),
      path: String(entry.path || ''), reason: String(entry.reason || ''),
      tool: String(entry.tool || ''),
      inspections: entry.inspections == null ? null : Number(entry.inspections),
    });
  }
});

stream.on('close', () => {
  // One chat can hold several runs (Continue, retry). Step numbers restart each
  // time, so segment on a step DECREASE and keep ts order — sorting by step would
  // interleave separate runs into one nonsense timeline.
  const out = [];
  [...runs.values()].forEach((run) => {
    let current = null;
    let lastStep = Infinity;
    run.events.forEach((event) => {
      if (!current || event.step < lastStep) {
        current = { chatId: run.chatId, runIndex: out.filter((r) => r.chatId === run.chatId).length, model: run.model, events: [] };
        out.push(current);
      }
      current.events.push(event);
      lastStep = event.step;
    });
  });
  const kept = out.filter((run) => new Set(run.events.map((e) => e.step)).size >= 5);
  if (!kept.length) {
    console.error('no matching runs found');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(kept, null, 1)}\n`);
  kept.forEach((run) => {
    const steps = new Set(run.events.map((e) => e.step));
    console.log(`${run.chatId}#${run.runIndex}  model=${run.model}  events=${run.events.length}  steps=${steps.size}`);
  });
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
});
