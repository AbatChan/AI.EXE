// v9.7.9 — structured (agent-decision) replies must be allowed the raw-copy upgrade when
// the DOM scrape shows footnote-renumbering artifacts.
//
// Root cause found by reading the real trace: the scrape renumbers caret semver
// SEQUENTIALLY by first appearance — ^15.0.0→^1^.0.0, ^18.3.1→^2^.3.1 (twice, same index),
// ^4.5.5→^3^.5.5, ^8.17.10→^4^.17.10, ^11.5.4→^5^.5.4, ^9.114.0→^6^.114.0, ^22.0.0→^7^.0.0.
// That is markdown footnote-reference numbering, not random corruption.
//
// The chain that made it reach the model, all in our code:
//   ai-exe.js  -> stopOnCompleteJson => structured_output: true   (every planner decision)
//   usage.py   -> aiexe_structured_output / aiexe_max_output_chars
//   adapter    -> _structured_limit > 0
//   adapter    -> `if not _structured_limit` SKIPPED the raw-copy upgrade
// so decisions always kept the lossy rendered-DOM text, while plain prose/file-content
// calls got the clean Copy. That is why only some runs looked corrupted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'backend', 'app', 'venice_adapter_server.py'), 'utf8');
const usage = fs.readFileSync(path.join(root, 'backend', 'app', 'routers', 'usage.py'), 'utf8');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');

// ---- The chain still exists (if any link is renamed, this test should be revisited) ----
assert.match(aiExe, /stopOnCompleteJson \? \{ structured_output: true \} : \{\}/, 'structured flag still originates in the UI');
assert.match(usage, /body\["aiexe_structured_output"\] = True/, 'the backend still forwards it');
assert.match(adapter, /_structured_limit = int\(data\.get\('aiexe_max_output_chars'\)/, 'the adapter still reads it');

// ---- The gate no longer blocks the upgrade outright ----
assert.doesNotMatch(adapter, /if not _structured_limit and eval_count and response_format/,
  'the unconditional structured skip is gone');
assert.match(adapter, /_scrape_has_ordinals = bool\(re\.search\(r"\\\^\\d\+\\\^"/,
  'the scrape is checked for footnote-ordinal artifacts');
assert.match(adapter, /if \(\(not _structured_limit or _scrape_has_ordinals\)/,
  'a mangled structured scrape is allowed to consult Copy');
// A bounded turn must stay bounded.
assert.match(adapter, /if _raw and _structured_limit and len\(_raw\) > _structured_limit:/,
  'an accepted copy is clipped to the structured bound');

// ---- The fidelity guard must accept a clean copy over a mangled scrape ----
// Ported from the Python so the direction is pinned in CI.
function safeUpgrade(scraped, copied) {
  const source = String(scraped || '');
  const candidate = String(copied || '');
  if (!source.trim() || !candidate.trim()) return false;
  const ord = (s) => new Set(s.match(/\^\d+\^/g) || []);
  const introduced = [...ord(candidate)].filter((o) => !ord(source).has(o));
  if (introduced.length) return false;
  const ver = (s) => new Set(s.match(/\^(?:\d+)(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?/g) || []);
  const sv = ver(source);
  if (sv.size) {
    const cv = ver(candidate);
    for (const v of sv) if (!cv.has(v)) return false;
  }
  return true;
}
const mangled = '{"next":"^1^.0.0","react":"^2^.3.1","@react-three/fiber":"^4^.17.10"}';
const clean = '{"next":"^15.0.0","react":"^18.3.1","@react-three/fiber":"^8.17.10"}';
assert.equal(safeUpgrade(mangled, clean), true, 'a clean copy replaces a mangled scrape');
assert.equal(safeUpgrade(clean, mangled), false, 'a mangled copy never replaces a clean scrape');
assert.equal(safeUpgrade(clean, clean.replace('^8.17.10', '^9.0.0')), false,
  'a copy that drops a version present in the scrape is rejected');

// ---- The renumbering is sequential by first appearance (documents the signature) ----
const observed = { '^15.0.0': '^1^.0.0', '^18.3.1': '^2^.3.1', '^4.5.5': '^3^.5.5', '^8.17.10': '^4^.17.10' };
const order = [];
Object.keys(observed).forEach((real) => {
  const major = real.match(/^\^(\d+)/)[1];
  if (!order.includes(major)) order.push(major);
  const idx = order.indexOf(major) + 1;
  assert.equal(observed[real], real.replace(new RegExp(`^\\^${major}`), `^${idx}^`),
    `${real} renumbers to index ${idx} by first appearance`);
});

console.log('PASS: structured agent decisions are no longer locked to the footnote-mangling DOM scrape; the fidelity guard prefers the clean copy and stays bounded');
