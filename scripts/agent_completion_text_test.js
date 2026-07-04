const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-runtime.js'));

function normalizeWorkspacePath(raw) {
  const value = String(raw || '/').replace(/\\/g, '/').trim();
  const parts = value.split('/').filter((part) => part && part !== '.');
  return parts.length ? `/${parts.join('/')}` : '/';
}

(async () => {
  const completion = [
    'Built the Ronaldo Football Dream landing page with three files:',
    '',
    '- `/index.html` — hero, career stats, iconic highlights, a journey timeline, and a subscribe section',
    '- `/style.css` — gold/crimson theme, responsive grid layouts, hover states, and reveal animations',
    '- `/script.js` — smooth scrolling, stat counters, sticky header behavior, and basic form feedback',
  ].join('\n');

  const runtime = global.AIExeAgentRuntime.createAgentRuntime({
    normalizeWorkspacePath,
    deriveProjectNameFromTask: () => 'ronaldo-football-dream',
    sanitizeAssistantText: (value) => String(value || '').trim(),
    requestSelectedRemoteTextCompletion: async () => ({ ok: true, output: completion }),
  });

  const text = await runtime.generateAgentCompletionText(
    'create simple landing page for ronaldo football dream',
    [
      { tool: 'write_file', ok: true, path: '/index.html', writtenContent: '<!doctype html>' },
      { tool: 'write_file', ok: true, path: '/style.css', writtenContent: 'body{}' },
      { tool: 'write_file', ok: true, path: '/script.js', writtenContent: 'console.log("ok")' },
      { tool: 'validate_files', ok: true, validationPassed: true },
      { tool: 'run_app', ok: true, runErrorCount: 0 },
    ],
    'ronaldo football dream',
    { summary: 'A single-page landing site' }
  );

  assert.equal(text, completion, 'complete bullet-list completion should not be rejected as incomplete');
  console.log('PASS: complete bullet-list completion text is accepted');
})();
