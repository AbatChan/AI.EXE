const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const mac = read('src/gui_main_mac_web.mm');
const win = read('src/gui_main_win_webview.cpp');
const manager = read('src/dev_server_manager.h');
const runner = read('src/command_runner.h');
const executor = read('ui/agent-executor.js');
const renderer = read('ui/chat-renderer.js');
const aiExe = read('ui/ai-exe.js');
const css = read('ui/ai-exe.css');
const adapter = read('backend/app/venice_adapter_server.py');

// C++ manager: tracked spawn, group kill, kill-on-close job, app-quit stop.
assert.match(manager, /class DevServerManager/);
assert.match(manager, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
assert.match(manager, /kill\(-static_cast<pid_t>\(pid\), SIGTERM\)/);
assert.match(runner, /ResolveProjectProgramExe/);

// Bridge actions on BOTH platforms + StopAll on quit.
for (const src of [mac, win]) {
  assert.match(src, /devServerStart/);
  assert.match(src, /devServerStatus/);
  assert.match(src, /devServerStop/);
  assert.match(src, /devServerList/);
  assert.match(src, /DevServerManager::Instance\(\)\.StopAll\(\)/);
}

// Executor: dev-server commands bypass the blocking runner, stay tracked, and
// tell the model not to re-run them.
assert.match(executor, /function isDevServerCommand/);
assert.match(executor, /devServerStart/);
assert.match(executor, /do NOT run this command again/i);
assert.match(executor, /devServer: \{ id: serverId/);

// UI: card with Stop/Open buttons survives activity normalization.
assert.match(renderer, /title: 'Dev server running'/);
assert.match(renderer, /devServerStop/);
assert.match(renderer, /devServerOpenUrl/);
assert.match(renderer, /devServer: item\.devServer && typeof item\.devServer === 'object'/);
assert.match(aiExe, /function handleDevServerCardClick/);
assert.match(aiExe, /devServerStop', \{ serverId \}/);
assert.match(css, /\.msg-agent-devserver-btn/);

// Adapter: idle-time cleanup of internal one-shot Venice threads.
assert.match(adapter, /_aiexe_internal_cleanup_loop/);
assert.match(adapter, /id:internal:/);
assert.match(adapter, /AIEXE_LAST_REQUEST_TS/);
assert.match(adapter, /gevent\.spawn\(_aiexe_internal_cleanup_loop\)/);

console.log('PASS: dev-server process manager (tracked start/stop, bridge actions, UI card, adapter thread cleanup)');
