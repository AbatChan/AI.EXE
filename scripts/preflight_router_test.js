const assert = require('node:assert/strict');
const path = require('node:path');

const router = require(path.join(__dirname, '..', 'ui', 'preflight-router.js'));

function workspace(overrides = {}) {
  return {
    workspaceRootName: '',
    currentPath: '/',
    currentKind: 'folder',
    rootEntryCount: 0,
    rootLoaded: false,
    rootEntries: [],
    ...overrides,
  };
}

function evaluate(message, options = {}) {
  return router.evaluate({
    advisoryDecision: options.advisoryDecision || { route: 'chat' },
    latestUserMessage: message,
    workspace: options.workspace || workspace(),
    agentEnabled: options.agentEnabled !== false,
  });
}

const cases = [
  {
    name: 'design a calculator site',
    message: 'design a calculator site',
    expectedRoute: 'agent',
  },
  {
    name: 'make me a simple calculator website',
    message: 'make me a simple calculator website',
    expectedRoute: 'agent',
  },
  {
    name: 'build a landing page',
    message: 'build a landing page',
    expectedRoute: 'agent',
  },
  {
    name: 'start a new project for a calculator',
    message: 'start a new project for a calculator',
    expectedRoute: 'agent',
  },
  {
    name: 'add dark mode to this project',
    message: 'add dark mode to this project',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'agent',
  },
  {
    name: 'improve the current UI',
    message: 'improve the current UI',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'agent',
  },
  {
    name: 'inspect this repo',
    message: 'inspect this repo',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'inspect',
  },
  {
    name: 'how do I run this on mac',
    message: 'how do I run this on mac',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'inspect',
  },
  {
    name: 'hello',
    message: 'hello',
    expectedRoute: 'chat',
  },
  {
    name: 'what is python',
    message: 'what is python',
    expectedRoute: 'chat',
  },
  {
    name: 'i need a nice-looking calculator for the browser',
    message: 'i need a nice-looking calculator for the browser',
    expectedRoute: 'agent',
  },
  {
    name: 'make it better',
    message: 'make it better',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'agent',
  },
  {
    name: 'agent disabled blocks agent route',
    message: 'add dark mode to this project',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    agentEnabled: false,
    expectedRoute: 'inspect',
  },
  {
    name: 'chat advisory overridden for create intent',
    message: 'make me a calculator website',
    advisoryDecision: { route: 'chat' },
    expectedRoute: 'agent',
    expectOverride: true,
  },
  {
    name: 'unrelated open workspace requires confirmation',
    message: 'design a calculator site simple calculator with nice designs',
    workspace: workspace({
      workspaceRootName: 'SnakeGame',
      rootEntryCount: 2,
      rootLoaded: true,
      rootEntries: [
        { kind: 'file', path: '/snake_game.py', name: 'snake_game.py' },
        { kind: 'file', path: '/README.md', name: 'README.md' },
      ],
    }),
    expectedRoute: 'confirm',
    expectOverride: true,
  },
  {
    name: 'explicit current workspace choice skips confirmation loop',
    message: 'use the current project to build the calculator page',
    workspace: workspace({
      workspaceRootName: 'SnakeGame',
      rootEntryCount: 2,
      rootLoaded: true,
      rootEntries: [
        { kind: 'file', path: '/snake_game.py', name: 'snake_game.py' },
      ],
    }),
    expectedRoute: 'agent',
  },
];

let failures = 0;

cases.forEach((testCase) => {
  const result = evaluate(testCase.message, {
    advisoryDecision: testCase.advisoryDecision,
    workspace: testCase.workspace,
    agentEnabled: testCase.agentEnabled,
  });

  try {
    assert.equal(result.decision.route, testCase.expectedRoute);
    if (typeof testCase.expectOverride === 'boolean') {
      assert.equal(Boolean(result.debug && result.debug.overridden), testCase.expectOverride);
    }
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${testCase.name}`);
    console.error(`  expected route: ${testCase.expectedRoute}`);
    console.error(`  actual route:   ${result.decision.route}`);
    console.error(`  debug: ${JSON.stringify(result.debug)}`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} preflight router test(s) failed.`);
  process.exit(1);
}

console.log(`Passed ${cases.length} preflight router tests.`);
