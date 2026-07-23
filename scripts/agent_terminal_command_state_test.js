const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));
require(path.join(__dirname, '..', 'ui', 'chat-renderer.js'));

function normalizeWorkspacePath(raw) {
  const parts = String(raw || '/').replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}` : '/';
}

function createExecutor(commandResult, alwaysAllowed = []) {
  const statuses = [];
  const calls = [];
  const executor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    invokeWorkspaceAction: async (action, data) => {
      calls.push({ action, data });
      if (action === 'runCommand') return commandResult;
      if (action === 'workspaceReadFile') return { ok: false, message: 'missing' };
      return { ok: true };
    },
    setActiveAgentStreamStatus: (_chatId, text) => statuses.push(String(text || '')),
    getAlwaysAllowedAgentCommands: () => alwaysAllowed,
  });
  return { executor, statuses, calls };
}

function createRenderer() {
  return global.AIExeChatRenderer.createChatRenderer({
    normalizeWorkspacePath,
    describeAgentToolTarget: (decision) => normalizeWorkspacePath(decision && decision.path ? decision.path : ''),
    describeAgentToolPhase: (tool) => String(tool || ''),
    nowTs: () => 12345,
  });
}

(async () => {
  const commandResult = {
    ok: true,
    message: 'exit_code=0',
    output: 'Syntax OK\n',
  };
  const { executor, statuses, calls } = createExecutor(commandResult);

  const result = await executor.executeDeveloperToolCall(
    'chat_terminal_state',
    { action: 'tool', tool: 'run_command', command: 'node --check script.js' },
    'Check the script syntax.',
    [],
    null,
  );

  assert.equal(result.ok, true);
  assert.equal(result.runErrorCount, 0);
  assert.equal(result.terminalCommand, 'node --check script.js');
  assert.deepEqual(result.terminalProof, {
    command: 'node --check script.js',
    exitCode: 0,
    timedOut: false,
    outputPreview: 'Syntax OK',
  });
  assert.deepEqual(calls.find((call) => call.action === 'runCommand').data, {
    program: 'node',
    argsLine: '--check\nscript.js',
  });
  assert.deepEqual(statuses, ['Running terminal command: node --check script.js']);

  const renderer = createRenderer();
  const pending = renderer.buildAgentPendingActivity({ action: 'tool', tool: 'run_command', command: 'node --check script.js' });
  assert.equal(pending.kind, 'command');
  assert.equal(pending.title, 'Running command');
  assert.equal(pending.terminal.command, 'node --check script.js');
  assert.equal(pending.status, 'pending');

  const done = renderer.buildAgentActivityFromToolResult(
    { action: 'tool', tool: 'run_command', command: 'node --check script.js' },
    result,
    [],
  );
  assert.equal(done.kind, 'command');
  assert.equal(done.title, 'Ran command');
  assert.equal(done.detail, 'node --check script.js');
  assert.equal(done.meta, 'exit 0');
  assert.equal(done.terminal.outputPreview, 'Syntax OK');

  const list = [];
  renderer.mergeAgentActivityIntoList(list, pending);
  renderer.mergeAgentActivityIntoList(list, done);
  assert.equal(list.length, 1, 'completed command should replace its pending row');
  assert.equal(list[0].title, 'Ran command');
  assert.equal(list[0].status, 'done');

  const installCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'this should not run',
  });
  const installResult = await installCase.executor.executeDeveloperToolCall(
    'chat_terminal_policy',
    { action: 'tool', tool: 'run_command', command: 'npm install' },
    'Install dependencies.',
    [],
    null,
  );

  assert.equal(installResult.ok, true);
  assert.equal(installResult.permissionRequired, true);
  assert.equal(installResult.commandPolicy, 'ask_first');
  assert.equal(installResult.runErrorCount, 1);
  assert.equal(installResult.terminalCommand, 'npm install');
  assert.equal(
    installCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'ask-first install command must not execute automatically'
  );
  assert.match(installResult.observation, /needs permission/i);

  const permissionRow = renderer.buildAgentActivityFromToolResult(
    { action: 'tool', tool: 'run_command', command: 'npm install' },
    installResult,
    [],
  );
  assert.equal(permissionRow, null, 'the composer approval card is the only permission UI; no duplicate timeline row');

  const alwaysInstallCase = createExecutor(commandResult, ['npm install framer-motion']);
  const alwaysInstallResult = await alwaysInstallCase.executor.executeDeveloperToolCall(
    'chat_terminal_policy_scope',
    { action: 'tool', tool: 'run_command', command: 'npm install @react-three/drei@9.114.0' },
    'Install another dependency.',
    [],
    null,
  );
  assert.equal(alwaysInstallResult.permissionRequired, undefined);
  assert.equal(alwaysInstallResult.runErrorCount, 0);
  assert.equal(
    alwaysInstallCase.calls.some((call) => call.action === 'runCommand'),
    true,
    'Always allow for npm install covers later npm install packages',
  );

  const alwaysDoesNotBroadenCase = createExecutor(commandResult, ['scope:npm:install']);
  const uninstallResult = await alwaysDoesNotBroadenCase.executor.executeDeveloperToolCall(
    'chat_terminal_policy_scope_boundary',
    { action: 'tool', tool: 'run_command', command: 'npm uninstall react' },
    'Remove a dependency.',
    [],
    null,
  );
  assert.equal(uninstallResult.permissionRequired, true, 'npm install approval never covers uninstall');

  const corruptedVersionCase = createExecutor(commandResult, ['scope:npm:install']);
  const corruptedVersionResult = await corruptedVersionCase.executor.executeDeveloperToolCall(
    'chat_terminal_corrupted_version',
    { action: 'tool', tool: 'run_command', command: 'npm install @react-three/drei@^1^.114.0' },
    'Install a dependency.',
    [],
    null,
  );
  assert.equal(corruptedVersionResult.ok, false);
  assert.equal(corruptedVersionResult.commandPolicy, 'blocked');
  assert.match(corruptedVersionResult.observation, /corrupted caret-version marker/i);
  assert.equal(
    corruptedVersionCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'a Venice-corrupted semver command must never execute even after npm-install approval',
  );

  const blockedCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'this should not run',
  });
  const blockedResult = await blockedCase.executor.executeDeveloperToolCall(
    'chat_terminal_policy_blocked',
    { action: 'tool', tool: 'run_command', command: 'node script.js && rm -rf .' },
    'Run a chained command.',
    [],
    null,
  );

  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.commandPolicy, 'blocked');
  assert.match(blockedResult.observation, /blocked/i);
  assert.equal(
    blockedCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'blocked shell syntax must not execute'
  );


  const phpCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'No syntax errors detected in index.php\n',
  });
  const phpResult = await phpCase.executor.executeDeveloperToolCall(
    'chat_terminal_php_policy',
    { action: 'tool', tool: 'run_command', command: 'php -l index.php' },
    'Check PHP syntax.',
    [],
    null,
  );

  assert.equal(phpResult.ok, true);
  assert.equal(phpResult.runErrorCount, 0);
  assert.equal(phpResult.terminalCommand, 'php -l index.php');
  assert.deepEqual(
    phpCase.calls.find((call) => call.action === 'runCommand').data,
    { program: 'php', argsLine: '-l\nindex.php' },
  );

  const goAskCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'this should not run',
  });
  const goAskResult = await goAskCase.executor.executeDeveloperToolCall(
    'chat_terminal_go_policy',
    { action: 'tool', tool: 'run_command', command: 'go mod tidy' },
    'Tidy Go modules.',
    [],
    null,
  );

  assert.equal(goAskResult.ok, true);
  assert.equal(goAskResult.permissionRequired, true);
  assert.equal(goAskResult.commandPolicy, 'ask_first');
  assert.equal(
    goAskCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'go mod tidy must be ask-first and must not execute automatically',
  );

  const cargoAskCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'this should not run',
  });
  const cargoAskResult = await cargoAskCase.executor.executeDeveloperToolCall(
    'chat_terminal_cargo_policy',
    { action: 'tool', tool: 'run_command', command: 'cargo update' },
    'Update Rust dependencies.',
    [],
    null,
  );

  assert.equal(cargoAskResult.ok, true);
  assert.equal(cargoAskResult.permissionRequired, true);
  assert.equal(cargoAskResult.commandPolicy, 'ask_first');
  assert.equal(
    cargoAskCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'cargo update must be ask-first and must not execute automatically',
  );

  const dotnetAskCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'this should not run',
  });
  const dotnetAskResult = await dotnetAskCase.executor.executeDeveloperToolCall(
    'chat_terminal_dotnet_policy',
    { action: 'tool', tool: 'run_command', command: 'dotnet restore' },
    'Restore .NET packages.',
    [],
    null,
  );

  assert.equal(dotnetAskResult.ok, true);
  assert.equal(dotnetAskResult.permissionRequired, true);
  assert.equal(dotnetAskResult.commandPolicy, 'ask_first');
  assert.equal(
    dotnetAskCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'dotnet restore must be ask-first and must not execute automatically',
  );



  const approvedInstallCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'installed\n',
  });
  const approvedInstallResult = await approvedInstallCase.executor.executeDeveloperToolCall(
    'chat_terminal_approved_install_policy',
    { action: 'tool', tool: 'run_command', command: 'npm install' },
    'Run approved install once.',
    [],
    null,
    { approvedCommand: 'npm install' },
  );

  assert.equal(approvedInstallResult.ok, true);
  assert.equal(approvedInstallResult.permissionRequired, undefined);
  assert.equal(approvedInstallResult.runErrorCount, 0);
  assert.equal(approvedInstallResult.terminalCommand, 'npm install');
  assert.deepEqual(
    approvedInstallCase.calls.find((call) => call.action === 'runCommand').data,
    { program: 'npm', argsLine: 'install' },
    'exactly-approved npm install should execute once',
  );

  const mismatchedApprovalCase = createExecutor({
    ok: true,
    message: 'exit_code=0',
    output: 'this should not run',
  });
  const mismatchedApprovalResult = await mismatchedApprovalCase.executor.executeDeveloperToolCall(
    'chat_terminal_mismatched_approval_policy',
    { action: 'tool', tool: 'run_command', command: 'npm install' },
    'Try mismatched approval.',
    [],
    null,
    { approvedCommand: 'npm update' },
  );

  assert.equal(mismatchedApprovalResult.ok, true);
  assert.equal(mismatchedApprovalResult.permissionRequired, true);
  assert.equal(
    mismatchedApprovalCase.calls.some((call) => call.action === 'runCommand'),
    false,
    'mismatched approval must not execute ask-first command',
  );


  const longOutput = `${'PRIMARY ERROR\\n'.repeat(140)}${'stack tail\\n'.repeat(500)}`;
  const longOutputCase = createExecutor({
    ok: true,
    message: 'exit_code=1',
    output: longOutput,
  });
  const longOutputResult = await longOutputCase.executor.executeDeveloperToolCall(
    'chat_terminal_output_digest',
    { action: 'tool', tool: 'run_command', command: 'npm run build' },
    'Build the app.',
    [],
    null,
  );
  assert.match(longOutputResult.observation, /PRIMARY ERROR/);
  assert.match(longOutputResult.observation, /stack tail/);
  assert.match(longOutputResult.observation, /chars omitted/);

  console.log('PASS: terminal state carries proof metadata, scoped approvals, corrupted-semver blocking, and head+tail failure diagnostics');
})();
