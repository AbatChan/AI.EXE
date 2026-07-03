const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));

function normalizeWorkspacePath(raw) {
  const parts = String(raw || '/').replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}` : '/';
}

function createExecutor(reads, commandResult) {
  const calls = [];
  let smokeCalled = false;
  const executor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    invokeWorkspaceAction: async (action, data) => {
      calls.push({ action, data });
      if (action === 'workspaceReadFile') {
        const target = normalizeWorkspacePath(data && data.path);
        if (Object.prototype.hasOwnProperty.call(reads, target)) return { ok: true, output: reads[target] };
        return { ok: false, message: 'missing' };
      }
      if (action === 'runCommand') return commandResult;
      return { ok: true };
    },
    runWorkspaceAppSmokeTest: async () => {
      smokeCalled = true;
      return { ok: true, errors: [] };
    },
    setActiveAgentStreamStatus: () => {},
  });
  return { executor, calls, getSmokeCalled: () => smokeCalled };
}

(async () => {
  const { executor, calls, getSmokeCalled } = createExecutor({
    '/package.json': JSON.stringify({
      scripts: { dev: 'vite', build: 'tsc -b && vite build' },
      dependencies: { vite: '^5.4.3', react: '^18.3.1' },
    }),
    '/vite.config.ts': 'import { defineConfig } from "vite"; export default defineConfig({});',
  }, {
    ok: true,
    message: 'exit_code=1',
    output: 'src/main.tsx:4:16: ERROR: Failed to resolve import "./App"',
  });

  const result = await executor.executeDeveloperToolCall(
    'chat_vite_run_app',
    { action: 'tool', tool: 'run_app', path: '/index.html' },
    'Create a Vite React app.',
    [],
    { expectedFiles: ['/package.json', '/index.html', '/vite.config.ts', '/src/main.tsx'] }
  );

  assert.equal(result.ok, true);
  assert.equal(result.runErrorCount, 1);
  assert.match(result.observation, /Vite build failed/);
  assert.match(result.observation, /Failed to resolve import "\.\/App"/);
  assert.equal(getSmokeCalled(), false, 'Vite projects should use native build verification, not offline HTML smoke test');
  assert.deepEqual(
    calls.find((call) => call.action === 'runCommand').data,
    { program: 'npm', argsLine: 'run\nbuild' }
  );

  console.log('PASS: run_app verifies Vite projects with captured npm build output');
})();
