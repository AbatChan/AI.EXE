const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));
const exec = global.AIExeAgentExecutor.createAgentExecutor({
  normalizeWorkspacePath: (value) => String(value || '/').replace(/\\/g, '/').replace(/^\/?/, '/'),
});
const { getHtmlStructureIssue, validateGeneratedFile, validateWebProjectConsistency } = exec;
const plan = { expectedFiles: ['/index.html', '/app.js', '/styles.css'] };

assert.deepEqual(validateGeneratedFile('/README.md', '# Guide\n\n```js\nconst x = 1;\n```', '', plan), []);
assert.deepEqual(validateGeneratedFile('/styles.css', '.preview::before { content: "<div>"; }', '', plan), []);
assert.deepEqual(validateGeneratedFile('/app.js', 'const html = "<html><body>preview</body></html>"; render(html);', '', plan), []);
assert.match(getHtmlStructureIssue('<html><body></body></html>\nbody { color: red; }'), /after the closing <\/html>/);
console.log('PASS: content examples are not validation blockers');

const advisory = [];
const issues = validateWebProjectConsistency({
  '/index.html': '<!doctype html><html><head><style>.local{color:red}</style></head><body><main></main></body></html>',
  '/app.js': 'fetch("/fragment").then(render); document.getElementById("server-rendered");',
  '/styles.css': '.shared{display:block}',
}, plan, advisory);
assert.deepEqual(issues, []);
assert.ok(advisory.some((item) => /page-local <style>/.test(item)));
assert.ok(advisory.some((item) => /server-rendered/.test(item)));
console.log('PASS: static architecture and DOM checks are advisory');

(async () => {
  const files = {
    '/app.py': 'import requests\nprint("ok")\n',
    '/example.js': '// import "./generated.js"\nconsole.log("ok");\n',
  };
  const validationExecutor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath: (value) => String(value || '/').replace(/\\/g, '/').replace(/^\/?/, '/'),
    invokeWorkspaceAction: async (action, data) => action === 'workspaceReadFile'
      ? { ok: Object.prototype.hasOwnProperty.call(files, data.path), output: files[data.path] || '' }
      : { ok: true },
    isLikelyCompletePrimarySource: () => true,
    reviewAgentProjectCoherence: async () => [],
  });
  const result = await validationExecutor.executeDeveloperToolCall('test', { tool: 'validate_files' }, '', [], {
    expectedFiles: Object.keys(files),
    _allExpectedFiles: Object.keys(files),
  });
  assert.equal(result.validationPassed, true);
  assert.match(result.observation, /requirements\.txt automatically synchronized from imports: requests/);
  assert.match(result.observation, /static scan could not resolve/);
  console.log('PASS: dependency and import scans are advisory');

  const missingAliasFiles = {
    '/src/app/layout.tsx': "import { Providers } from '@/components/providers';\nexport default function Layout({ children }) { return children; }\n",
  };
  const aliasExecutor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath: (value) => String(value || '/').replace(/\\/g, '/').replace(/^\/?/, '/'),
    invokeWorkspaceAction: async (action, data) => action === 'workspaceReadFile'
      ? { ok: Object.prototype.hasOwnProperty.call(missingAliasFiles, data.path), output: missingAliasFiles[data.path] || '' }
      : { ok: true },
    isLikelyCompletePrimarySource: () => true,
    reviewAgentProjectCoherence: async () => [],
  });
  const aliasResult = await aliasExecutor.executeDeveloperToolCall('test', { tool: 'validate_files' }, '', [], {
    expectedFiles: ['/src/app/layout.tsx'],
    _allExpectedFiles: ['/src/app/layout.tsx'],
  });
  assert.equal(aliasResult.validationPassed, false);
  assert.match(aliasResult.observation, /imports @\/components\/providers, but none of its local files exist/);
  console.log('PASS: unresolved @/ aliases are blocking build errors');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
