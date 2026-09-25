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
  let smokeTarget = '';
  const executor = global.AIExeAgentExecutor.createAgentExecutor({
    normalizeWorkspacePath,
    invokeWorkspaceAction: async (action, data) => {
      calls.push({ action, data });
      if (action === 'workspaceReadFile') {
        const target = normalizeWorkspacePath(data && data.path);
        if (Object.prototype.hasOwnProperty.call(reads, target)) return { ok: true, output: reads[target] };
        return { ok: false, message: 'missing' };
      }
      if (action === 'runCommand') return typeof commandResult === 'function' ? commandResult(data) : commandResult;
      return { ok: true };
    },
    runWorkspaceAppSmokeTest: async (target) => {
      smokeTarget = normalizeWorkspacePath(target || '/index.html');
      return { ok: true, errors: [] };
    },
    setActiveAgentStreamStatus: () => {},
  });
  return { executor, calls, getSmokeTarget: () => smokeTarget };
}

(async () => {
  {
    const { executor, calls, getSmokeTarget } = createExecutor({
      '/package.json': JSON.stringify({
        scripts: { build: 'node build.js' },
        dependencies: {},
      }),
    }, {
      ok: true,
      message: 'exit_code=0',
      output: 'built\n',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_node_build_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this Node project.',
      [],
      { expectedFiles: ['/package.json', '/src/index.js'] },
    );

    assert.equal(result.ok, true);
    assert.equal(result.runErrorCount, 0);
    assert.equal(result.terminalCommand, 'npm run build');
    assert.equal(result.terminalProof.command, 'npm run build');
    assert.match(result.observation, /Node build passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'npm', argsLine: 'run\nbuild' },
    );
    assert.equal(getSmokeTarget(), '');
  }

  {
    const { executor, calls, getSmokeTarget } = createExecutor({
      '/main.py': 'print("hello")\n',
    }, {
      ok: true,
      message: 'exit_code=0',
      output: '',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_python_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this Python project.',
      [],
      { expectedFiles: ['/main.py'] },
    );

    assert.equal(result.ok, true);
    assert.equal(result.runErrorCount, 0);
    assert.equal(result.terminalCommand, 'python -m py_compile main.py');
    assert.match(result.observation, /Python syntax proof passed/);
    assert.match(result.observation, /syntax only — it does not run the program/, 'syntax-only proof says so');
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'python', argsLine: '-m\npy_compile\nmain.py' },
    );
    assert.equal(getSmokeTarget(), '');
  }

  // Habit Tracker: Vite build passed but Vitest never ran. A real test script runs after the build.
  for (const testsPass of [true, false]) {
    const { executor, calls } = createExecutor({
      '/package.json': JSON.stringify({ scripts: { build: 'tsc -b && vite build', test: 'vitest run' }, devDependencies: { vite: '^5.4.3', vitest: '^2.1.9' } }),
      '/vite.config.ts': 'export default {}\n',
    }, (data) => (/test/.test(data.argsLine)
      ? { ok: true, message: `exit_code=${testsPass ? 0 : 1}`, output: testsPass ? '16 passed\n' : 'FAIL src/lib/habits.test.ts > streak\n' }
      : { ok: true, message: 'exit_code=0', output: 'built\n' }));
    const result = await executor.executeDeveloperToolCall('chat_vite_tests', { action: 'tool', tool: 'run_app', path: '/' }, 'Verify.', [], { expectedFiles: ['/package.json'] });
    const ran = calls.filter((c) => c.action === 'runCommand').map((c) => c.data.argsLine.replace(/\n/g, ' '));
    assert.deepEqual(ran, ['run build', 'test'], 'build, then npm test');
    assert.equal(result.runErrorCount, testsPass ? 0 : 1);
    assert.match(result.observation, testsPass ? /Vite build passed[\s\S]*tests passed \(npm test exited 0\)/ : /tests failed \(npm test exited 1\)[\s\S]*habits\.test\.ts/);
  }
  // npm's placeholder test script is not a test suite.
  {
    const { executor, calls } = createExecutor({
      '/package.json': JSON.stringify({ scripts: { build: 'vite build', test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { vite: '^5.4.3' } }),
    }, { ok: true, message: 'exit_code=0', output: 'built\n' });
    await executor.executeDeveloperToolCall('chat_vite_notest', { action: 'tool', tool: 'run_app', path: '/' }, 'Verify.', [], { expectedFiles: ['/package.json'] });
    assert.equal(calls.filter((c) => c.action === 'runCommand').length, 1, 'placeholder test script is skipped');
  }

  // Ledger CLI: Luna shipped a failing unittest suite it never ran. Tests present -> run_app runs them.
  {
    const { executor, calls } = createExecutor({
      '/ledger.py': 'def main():\n    return 0\n',
      '/tests/test_ledger.py': 'import unittest\n',
    }, {
      ok: true,
      message: 'exit_code=1',
      output: 'FAIL: test_invalid_amount (test_ledger.CommandLineTests)\nAssertionError: SystemExit not raised\nFAILED (failures=1)\n',
    });
    const result = await executor.executeDeveloperToolCall(
      'chat_python_tests_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this Python project.',
      [],
      { expectedFiles: ['/ledger.py', '/tests/test_ledger.py'] },
    );
    assert.equal(result.terminalCommand, 'python -m unittest discover -s tests -v');
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'python', argsLine: '-m\nunittest\ndiscover\n-s\ntests\n-v' },
    );
    assert.equal(result.runErrorCount, 1, 'failing tests are a run error');
    assert.match(result.observation, /Python unit tests failed[\s\S]*SystemExit not raised/);
  }

  {
    const { executor, calls, getSmokeTarget } = createExecutor({
      '/index.html': '<!doctype html><title>OK</title>',
    }, {
      ok: true,
      message: 'exit_code=0',
      output: 'this should not run',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_html_stack',
      { action: 'tool', tool: 'run_app', path: '/index.html' },
      'Verify this HTML project.',
      [],
      { expectedFiles: ['/index.html'] },
    );

    assert.equal(result.ok, true);
    assert.equal(result.runErrorCount, 0);
    assert.equal(getSmokeTarget(), '/index.html');
    assert.equal(
      calls.some((call) => call.action === 'runCommand'),
      false,
      'plain HTML should use smoke preview, not terminal command proof',
    );
  }

  {
    const { executor, calls } = createExecutor({ '/index.php': '<?php echo "ok";' }, {
      ok: true,
      message: 'exit_code=0',
      output: 'No syntax errors detected\n',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_php_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this PHP project.',
      [],
      { expectedFiles: ['/index.php'] },
    );

    assert.equal(result.terminalCommand, 'php -l index.php');
    assert.match(result.observation, /PHP syntax proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'php', argsLine: '-l\nindex.php' },
    );
  }

  {
    const { executor, calls } = createExecutor({}, {
      ok: true,
      message: 'exit_code=0',
      output: '',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_java_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this Java project.',
      [],
      { expectedFiles: ['/Main.java'] },
    );

    assert.equal(result.terminalCommand, 'javac Main.java');
    assert.match(result.observation, /Java compile proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'javac', argsLine: 'Main.java' },
    );
  }

  {
    const { executor, calls } = createExecutor({}, {
      ok: true,
      message: 'exit_code=0',
      output: '',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_c_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this C project.',
      [],
      { expectedFiles: ['/main.c'] },
    );

    assert.equal(result.terminalCommand, 'gcc -fsyntax-only main.c');
    assert.match(result.observation, /C syntax proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'gcc', argsLine: '-fsyntax-only\nmain.c' },
    );
  }

  {
    const { executor, calls } = createExecutor({}, {
      ok: true,
      message: 'exit_code=0',
      output: '',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_cpp_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this C++ project.',
      [],
      { expectedFiles: ['/main.cpp'] },
    );

    assert.equal(result.terminalCommand, 'g++ -fsyntax-only main.cpp');
    assert.match(result.observation, /C\+\+ syntax proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'g++', argsLine: '-fsyntax-only\nmain.cpp' },
    );
  }

  {
    const { executor, calls } = createExecutor({ '/go.mod': 'module example.com/app\n' }, {
      ok: true,
      message: 'exit_code=0',
      output: 'ok example.com/app\n',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_go_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this Go project.',
      [],
      { expectedFiles: ['/main.go'] },
    );

    assert.equal(result.terminalCommand, 'go test -mod=readonly ./...');
    assert.match(result.observation, /Go test proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'go', argsLine: 'test\n-mod=readonly\n./...' },
    );
  }

  {
    const { executor, calls } = createExecutor({ '/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n' }, {
      ok: true,
      message: 'exit_code=0',
      output: 'Finished dev profile\n',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_rust_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this Rust project.',
      [],
      { expectedFiles: ['/src/main.rs'] },
    );

    assert.equal(result.terminalCommand, 'cargo check --offline --locked');
    assert.match(result.observation, /Rust cargo proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'cargo', argsLine: 'check\n--offline\n--locked' },
    );
  }

  {
    const { executor, calls } = createExecutor({}, {
      ok: true,
      message: 'exit_code=0',
      output: 'Build succeeded.\n',
    });

    const result = await executor.executeDeveloperToolCall(
      'chat_dotnet_stack',
      { action: 'tool', tool: 'run_app', path: '/' },
      'Verify this .NET project.',
      [],
      { expectedFiles: ['/App.csproj'] },
    );

    assert.equal(result.terminalCommand, 'dotnet build --no-restore App.csproj');
    assert.match(result.observation, /\.NET build proof passed/);
    assert.deepEqual(
      calls.find((call) => call.action === 'runCommand').data,
      { program: 'dotnet', argsLine: 'build\n--no-restore\nApp.csproj' },
    );
  }

  console.log('PASS: stack proof planner detects Node, Python, HTML, PHP, Java, C/C++, Go, Rust, and .NET verification paths');
})();
