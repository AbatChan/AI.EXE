// Replay of a real Luna plan (link-profile app): Phase 1 listed 30 files, but a 6-task
// cap kept only config files and dumped auth/db/profile into "Remaining deliverables".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-core.js'), 'utf8');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_link_profile_plan.json'), 'utf8'));
const norm = (p) => { let s = String(p || '').trim().replace(/\\/g, '/'); if (!s) return ''; if (!s.startsWith('/')) s = `/${s}`; return s.replace(/\/+/g, '/').replace(/\/$/, '') || '/'; };
const ctx = { normalizeWorkspacePath: norm };
vm.createContext(ctx);
for (const f of ['stripPhaseTitlePrefix', 'formatAgentPlanSentence', 'parseAgentPlanPhases', 'extractPlannedPathFromPhaseTask', 'extractPlannedPathsFromPhaseTask', 'phaseTaskForPath', 'normalizeWebProjectPhases']) {
  const m = core.match(new RegExp(`    function ${f}\\([^]*?\\n    }`));
  assert.ok(m, `missing ${f}`);
  vm.runInContext(m[0], ctx);
}
const expected = plan.expected.split('|').map(norm);
const parsed = ctx.parseAgentPlanPhases(plan.phases);
assert.equal(parsed[0].tasks.length, 30, 'every Phase 1 file survives parsing');
const phases = ctx.normalizeWebProjectPhases(parsed, expected, 'web');
const titles = phases.map((p) => p.title);
assert.equal(JSON.stringify(titles), JSON.stringify(['Core account and public profile', 'Analytics dashboard', 'Bio suggestions and setup guide']), 'model order kept; no catch-all phase');
const p1 = phases[0].tasks.map((t) => t.text);
for (const f of ['prisma/schema.prisma', 'src/lib/auth.ts', 'src/app/(auth)/login/page.tsx', 'src/app/[username]/page.tsx', 'src/app/go/[linkId]/route.ts']) {
  assert.ok(p1.includes(f), `Phase 1 keeps ${f}`);
}
const all = phases.flatMap((p) => p.tasks.map((t) => norm(t.text)));
assert.equal(all.length, new Set(all).size, 'each file in exactly one phase');
assert.deepEqual([...all].sort(), [...expected].sort(), 'phases cover every expected file');

// A task naming two files assigns both to its phase.
const multi = ctx.normalizeWebProjectPhases([
  { title: 'Foundation', tasks: [{ text: '/package.json' }, { text: '/src/lib/prisma.ts and /src/lib/auth.ts shared setup' }] },
  { title: 'Screens', tasks: [{ text: '/src/app/(auth)/login/page.tsx and /src/app/(auth)/signup/page.tsx account screens' }] },
], ['/package.json', '/next.config.ts', '/src/lib/prisma.ts', '/src/lib/auth.ts', '/src/app/(auth)/login/page.tsx', '/src/app/(auth)/signup/page.tsx'], 'web');
assert.equal(JSON.stringify(multi.map((p) => p.title)), JSON.stringify(['Foundation', 'Screens']));
assert.ok(multi[0].tasks.some((t) => t.text === 'src/lib/auth.ts'));
assert.equal(multi[1].tasks.length, 2);
console.log('PASS: real Luna plan keeps its phase order and every Phase 1 file; multi-file tasks count every file');
