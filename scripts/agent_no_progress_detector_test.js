const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const executor = fs.readFileSync(path.join(root, 'ui', 'agent-executor.js'), 'utf8');

// --- wiring: the guards that ended runs must be present in their fixed form ---

// A blocked read RE-SERVES the cached content. Refusing without it dead-ended a run
// whose earlier read had aged out of RECENT_TOOL_RESULTS.
assert.match(
  loop,
  /Its content is repeated below — do NOT read it again/,
  'duplicate read_file block re-serves the cached content',
);
assert.match(loop, /const cached = String\(lastEvent\.content \|\| ''\)\.trim\(\) \|\| obs\.trim\(\);/, 're-serve reads from the cached event');

// Warn tier before kill tier: escalate on repeat #2, terminate at 3.
assert.match(loop, /ESCALATION: this is repeat #/, 'second identical block escalates with a steer');
assert.doesNotMatch(loop, /duplicateBlockedCount >= 2/, 'kill threshold is no longer 2');
assert.equal((loop.match(/duplicateBlockedCount >= 3/g) || []).length, 2, 'both kill sites moved to 3');

// Result-aware no-progress for build/run failures (they report ok:true + runErrorCount>0,
// so the !ok rejection check never saw them).
assert.match(loop, /NO PROGRESS: this run produced the SAME failure output as/, 'identical run output is called out');
assert.match(loop, /agent_identical_run_output/, 'identical run output is traced');

// .mjs is always ESM — CommonJS in it throws at load and kills the dev server.
assert.match(executor, /is an ES module \(\.mjs\) but uses CommonJS/, 'esm/cjs mismatch blocks');
assert.match(executor, /createRequire/, 'createRequire escape hatch is honored');

// Batch reads must not be a bypass: the signature is order-insensitive and the handler
// drops paths already read. Observed loop: Scene.tsx read 4x in 40s inside rotating batches.
assert.match(loop, /decision\.paths\.slice\(\)\.sort\(\)\.join\(','\)/, 'read_files signature is order-insensitive');
assert.match(executor, /const redundantPaths = paths\.filter\(alreadyReadUnchanged\);/, 'read_files drops already-read paths');
assert.match(executor, /reshuffling the batch does not make them new/, 'fully-redundant batch is blocked with a reason');

// --- behavior: the batch signature ---

const sigSrc = loop.slice(
  loop.indexOf('const decisionPathsSignature = (decision) => {'),
  loop.indexOf('const selectVitalReadPaths ='),
);
// eslint-disable-next-line no-new-func
const decisionPathsSignature = new Function(`${sigSrc} return decisionPathsSignature;`)();
const setA = { tool: 'read_files', paths: ['/tsconfig.json', '/package.json', '/src/types/index.ts'] };
const setB = { tool: 'read_files', paths: ['/src/types/index.ts', '/tsconfig.json', '/package.json'] };
const setC = { tool: 'read_files', paths: ['/tsconfig.json', '/package.json'] };
assert.equal(decisionPathsSignature(setA), decisionPathsSignature(setB), 'reordered batch is the same read');
assert.notEqual(decisionPathsSignature(setA), decisionPathsSignature(setC), 'a genuinely different set is different');

// --- behavior: the output-key comparison used by the no-progress detector ---

const keySrc = loop.slice(
  loop.indexOf('const outputKey = (text) => String(text || \'\')'),
  loop.indexOf('const thisKey = outputKey(toolResult.observation);'),
);
assert.ok(keySrc.length > 40, 'found the outputKey helper');
// eslint-disable-next-line no-new-func
const outputKey = new Function(`${keySrc} return outputKey;`)();

// Real repeated build failures from the SWARM run: identical error, volatile timing/port.
const buildA = `run_command \`npm run build\`: exited with code 1.
Failed to compile.
./src/components/CameraRig.tsx:22:30
Type error: 'OrbitControls' refers to a value, but is being used as a type here.
   Compiled in 1240ms`;
const buildB = `run_command \`npm run build\`: exited with code 1.
Failed to compile.
./src/components/CameraRig.tsx:22:30
Type error: 'OrbitControls' refers to a value, but is being used as a type here.
   Compiled in 980ms`;
const buildDifferent = `run_command \`npm run build\`: exited with code 1.
Failed to compile.
./src/components/Drones.tsx:12:8
Type error: Module '"@/lib/boids"' has no exported member 'Swarm'.`;

assert.equal(outputKey(buildA), outputKey(buildB), 'same error with different timings is the same failure');
assert.notEqual(outputKey(buildA), outputKey(buildDifferent), 'a genuinely different type error is NOT no-progress');

// The repeated stale-cache failure from the run: byte-identical across purges → fires.
const chunk = "Error: Cannot find module './627.js' at .next/server/webpack-runtime.js";
assert.equal(outputKey(chunk), outputKey(`${chunk}   `), 'same chunk failure is the same failure');
// DELIBERATELY conservative: a DIFFERENT short numeric id is left distinct. Collapsing it
// would risk calling two genuinely different missing modules "no progress"; a miss only
// costs a silent advisory, a false positive misdirects the model.
const otherChunk = "Error: Cannot find module './935.js' at .next/server/webpack-runtime.js";
assert.notEqual(outputKey(chunk), outputKey(otherChunk), 'short numeric ids are not over-normalized');
// Long content hashes ARE volatile noise and do normalize.
assert.equal(
  outputKey('failed at chunk a1b2c3d4e5f6 line 3'),
  outputKey('failed at chunk 9f8e7d6c5b4a line 3'),
  'long hex hashes normalize together',
);

console.log('agent_no_progress_detector_test: all assertions passed');
