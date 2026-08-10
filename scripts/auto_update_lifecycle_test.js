const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const start = source.indexOf('(function setupUpdateCheck()');
const end = source.indexOf('// Boot nudge:', start);
assert.ok(start >= 0 && end > start, 'update lifecycle block must exist');

const elements = new Map();
for (const id of ['updateStatus', 'updateStatusText', 'settingsUpdateStatus', 'settingsUpdateCheckBtn']) {
  elements.set(id, {
    id,
    hidden: false,
    disabled: false,
    dataset: {},
    textContent: '',
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
  });
}

let latest = '10.3.0';
const sha = 'a'.repeat(64);
const nativeCalls = [];
const notices = [];
const intervals = [];
const timeouts = [];
let timerId = 0;

const context = {
  AI_EXE_VERSION: '10.2.0',
  console: { log() {} },
  document: {
    readyState: 'complete',
    hidden: false,
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {},
  },
  fetch: async () => ({
    ok: true,
    async json() {
      return {
        tag_name: `v${latest}`,
        html_url: `https://github.com/AbatChan/AI.EXE/releases/tag/v${latest}`,
        assets: [{
          name: 'AI.EXE-Windows.zip',
          browser_download_url: `https://example.test/v${latest}.zip`,
          size: 1000,
          digest: `sha256:${sha}`,
        }],
      };
    },
  }),
  nativeBridge: {
    available: () => true,
    async invoke(action, data) {
      nativeCalls.push({ action, data });
      if (action === 'updateStageStatus') {
        return { ok: true, output: JSON.stringify({ staged: true, bytes: 1000 }) };
      }
      return { ok: true };
    },
  },
  showAppNotification(options) { notices.push(options); },
  recordDebugTrace() {},
  setTimeout(fn, ms) { const id = ++timerId; timeouts.push({ id, fn, ms }); return id; },
  clearTimeout() {},
  setInterval(fn, ms) { const id = ++timerId; intervals.push({ id, fn, ms, cleared: false }); return id; },
  clearInterval(id) { const timer = intervals.find((item) => item.id === id); if (timer) timer.cleared = true; },
};

vm.runInNewContext(source.slice(start, end), context);

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const startup = timeouts.find((timer) => timer.ms === 8000);
  assert.ok(startup, 'startup check must be scheduled');
  await startup.fn();
  await flush();

  let poll = intervals.find((timer) => timer.ms === 2000 && !timer.cleared);
  assert.ok(poll, 'background stage status must be polled');
  await poll.fn();
  await flush();

  assert.ok(nativeCalls.some((call) => call.action === 'stageUpdate' && call.data.version === '10.3.0' && call.data.sha256 === sha));
  assert.ok(nativeCalls.some((call) => call.action === 'armUpdateOnQuit' && call.data.version === '10.3.0'));
  assert.equal(elements.get('updateStatusText').textContent, 'Update ready');
  assert.match(elements.get('settingsUpdateStatus').textContent, /v10\.3\.0 is downloaded and verified/);

  latest = '10.4.0';
  const periodic = intervals.find((timer) => timer.ms === 6 * 60 * 60 * 1000);
  assert.ok(periodic, 'periodic latest-release check must be scheduled');
  await periodic.fn();
  await flush();

  poll = [...intervals].reverse().find((timer) => timer.ms === 2000 && !timer.cleared);
  assert.ok(poll, 'newer release must start a replacement stage');
  await poll.fn();
  await flush();

  assert.ok(nativeCalls.some((call) => call.action === 'stageUpdate' && call.data.version === '10.4.0'));
  assert.ok(nativeCalls.some((call) => call.action === 'armUpdateOnQuit' && call.data.version === '10.4.0'));
  assert.match(elements.get('settingsUpdateStatus').textContent, /v10\.4\.0 is downloaded and verified/);

  elements.get('updateStatus').listeners.click();
  await flush();
  assert.ok(nativeCalls.some((call) => call.action === 'applyUpdate' && call.data.version === '10.4.0'));
  assert.ok(notices.some((notice) => /v10\.4\.0 is ready/.test(notice.title)));

  console.log('PASS: latest verified update replaces an older stage and installs on quit or restart');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
