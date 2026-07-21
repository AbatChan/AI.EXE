const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const start = source.indexOf('const compactStoredDiffPreview =');
const end = source.indexOf('\nfunction normalizeStoredPendingPreflightConfirmation', start);
assert.ok(start >= 0 && end > start, 'chat storage fallback should define compact diff persistence');
const storageFallback = source.slice(start, end);

assert.match(
  storageFallback,
  /diffPreview:\s*keepPreview\s*\?\s*compactStoredDiffPreview\(activity\.diffPreview\)\s*:\s*null/,
  'storage shedding must retain compact per-activity previews on recent assistant replies',
);
assert.match(
  storageFallback,
  /diffPreview:\s*keepPreview\s*\?\s*compactStoredDiffPreview\(file\.diffPreview,\s*120\)\s*:\s*null/,
  'storage shedding must retain aggregate file previews on recent assistant replies',
);
assert.match(
  storageFallback,
  /preserveRecentPreviewAiCount/,
  'storage shedding may discard only older previews under escalating quota pressure',
);
assert.match(
  storageFallback,
  /content:\s*''/,
  'storage shedding should still remove heavyweight full-file revert snapshots',
);

console.log('Passed edit-preview persistence storage tests.');
