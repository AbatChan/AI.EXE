const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-loop.js'));
require(path.join(__dirname, '..', 'ui', 'chat-renderer.js'));

const before = [
  'import Link from "next/link";',
  '',
  'export default function Layout({ children }) {',
  '  return <main>{children}</main>;',
  '}',
].join('\n');
const intermediate = [
  'import DashboardShell from "@/components/DashboardShell";',
  '',
  'export default function Layout({ children }) {',
  '  return <DashboardShell>{children}</DashboardShell>;',
  '}',
  '',
].join('\n');
const after = intermediate.slice(0, -1);

const aggregate = global.AIExeAgentLoop.buildAgentLineDiffPreview(before, after);
const latestOnly = global.AIExeAgentLoop.buildAgentLineDiffPreview(intermediate, after);
assert.ok(aggregate.some((row) => row.type === 'remove' && row.text.includes('import Link')));
assert.ok(aggregate.some((row) => row.type === 'add' && row.text.includes('DashboardShell')));
assert.equal(latestOnly.filter((row) => row.type !== 'context' && row.type !== 'spacer').length, 1);

const renderer = global.AIExeChatRenderer.createChatRenderer({
  normalizeWorkspacePath(value) {
    const text = String(value || '').replace(/\\/g, '/');
    return text.startsWith('/') ? text : `/${text}`;
  },
});
const file = {
  path: '/src/app/dashboard/layout.tsx',
  added: 2,
  removed: 2,
  diffPreview: aggregate,
};
const activities = [{
  kind: 'edit',
  openPath: file.path,
  title: 'Edited',
  diffPreview: latestOnly,
}];
assert.deepEqual(
  renderer.getEditCardDiffPreview(file, activities),
  aggregate,
  'finished edit card must prefer the aggregate snapshot preview over the latest step',
);

const legacyFile = { path: file.path, added: 0, removed: 1 };
assert.deepEqual(
  renderer.getEditCardDiffPreview(legacyFile, activities),
  latestOnly,
  'older saved messages retain their per-step preview fallback',
);

const normalized = renderer.normalizeAgentMeta({
  startedAt: 1,
  completedAt: 2,
  revert: { files: [{ ...file, existedBefore: true, content: before }] },
});
assert.deepEqual(normalized.revert.files[0].diffPreview, aggregate);

console.log('Passed aggregate edit-preview tests.');
