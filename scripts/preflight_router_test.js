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
    modelDecision: options.modelDecision,
    latestUserMessage: message,
    workspace: options.workspace || workspace(),
    agentEnabled: options.agentEnabled !== false,
    chatOwnsWorkspace: options.chatOwnsWorkspace,
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
    name: 'agent disabled: action request answers in chat without reading files',
    message: 'add dark mode to this project',
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    agentEnabled: false,
    expectedRoute: 'chat',
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
  // --- model-decision path (intent classified by the model, not regex) ---
  {
    name: 'model: build request the regex missed routes to agent (no workspace)',
    message: 'write me a playable snake thing in python',
    modelDecision: { route: 'agent', intent: 'create_or_build_deliverable', needs_file_mutation: 'yes', confidence: 0.95 },
    expectedRoute: 'agent',
  },
  {
    name: 'model: build request in a foreign open workspace asks for scope confirmation',
    message: 'write me a playable snake thing in python',
    modelDecision: { route: 'agent', intent: 'create_or_build_deliverable', needs_file_mutation: 'yes', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'markdown site', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'confirm',
  },
  {
    name: 'model: "build on your last answer" stays chat despite the word build',
    message: 'build on your last answer',
    modelDecision: { route: 'chat', intent: 'general_answer', needs_file_mutation: 'no', confidence: 0.93 },
    workspace: workspace({ workspaceRootName: 'markdown site', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'chat',
  },
  {
    name: 'model: how do I run this routes to inspect',
    message: 'how do I run this?',
    modelDecision: { route: 'inspect', intent: 'workspace_question', needs_file_mutation: 'no', confidence: 0.94 },
    workspace: workspace({ workspaceRootName: 'markdown site', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'inspect',
  },
  {
    name: 'pasted error overrides model inspect -> agent (fix it)',
    message: 'script.js:11 Uncaught ReferenceError: SimulationGrid is not defined',
    modelDecision: { route: 'inspect', intent: 'workspace_question', needs_file_mutation: 'no', confidence: 0.85 },
    workspace: workspace({ workspaceRootName: 'factory-logistics-simulator', rootEntryCount: 4, rootLoaded: true }),
    expectedRoute: 'agent',
  },
  {
    name: '"why is it broken" overrides model inspect -> agent',
    message: 'why is the app broken? nothing happens when I click',
    modelDecision: { route: 'inspect', intent: 'workspace_question', needs_file_mutation: 'no', confidence: 0.9 },
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'agent',
  },
  {
    name: 'genuine understanding question (no error) stays inspect',
    message: 'how does the tick loop work in this code?',
    modelDecision: { route: 'inspect', intent: 'workspace_question', needs_file_mutation: 'no', confidence: 0.9 },
    workspace: workspace({ workspaceRootName: 'demo-app', rootEntryCount: 5, rootLoaded: true }),
    expectedRoute: 'inspect',
  },
  {
    name: 'pasted error with NO open workspace does not force agent',
    message: 'TypeError: cannot read properties of null',
    modelDecision: { route: 'chat', intent: 'general_answer', needs_file_mutation: 'no', confidence: 0.9 },
    expectedRoute: 'chat',
  },
  {
    name: 'model: agent OFF cannot create files, so build request falls back to chat',
    message: 'write me a snake game',
    modelDecision: { route: 'agent', intent: 'create_or_build_deliverable', needs_file_mutation: 'yes', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'markdown site', rootEntryCount: 5, rootLoaded: true }),
    agentEnabled: false,
    expectedRoute: 'chat',
  },
  {
    name: 'model: agent OFF + modify request answers in chat (no file reads) in open workspace',
    message: 'fix the title bug in site.py',
    modelDecision: { route: 'agent', intent: 'modify_existing_workspace', needs_file_mutation: 'yes', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'markdown site', rootEntryCount: 5, rootLoaded: true }),
    agentEnabled: false,
    expectedRoute: 'chat',
  },
  {
    name: 'agent OFF: even a workspace QUESTION stays in chat (no file reads when agent is off)',
    message: 'how does the theme toggle work in this project?',
    modelDecision: { route: 'inspect', intent: 'workspace_question', needs_file_mutation: 'no', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'markdown site', rootEntryCount: 5, rootLoaded: true }),
    agentEnabled: false,
    expectedRoute: 'chat',
  },
  {
    name: 'model: low-confidence decision is ignored (falls back to regex features)',
    message: 'make me a calculator website',
    modelDecision: { route: 'chat', intent: 'casual_chat', confidence: 0.1 },
    expectedRoute: 'agent',
  },
  {
    name: 'model: question in a chat-owned workspace routes to inspect, not agent',
    message: "why'd you name the project that?",
    modelDecision: { route: 'inspect', intent: 'workspace_question', needs_file_mutation: 'no', confidence: 0.94 },
    workspace: workspace({ workspaceRootName: 'snakegame', rootEntryCount: 1, rootLoaded: true }),
    chatOwnsWorkspace: true,
    expectedRoute: 'inspect',
  },
  {
    name: 'model: actionable follow-up in a chat-owned workspace still routes to agent',
    message: 'add a high score display',
    modelDecision: { route: 'agent', intent: 'modify_existing_workspace', needs_file_mutation: 'yes', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'snakegame', rootEntryCount: 1, rootLoaded: true }),
    chatOwnsWorkspace: true,
    expectedRoute: 'agent',
  },
  {
    name: 'chat-owned workspace: a create-intent follow-up (add a file) goes straight to agent, NOT confirm',
    message: 'can you add a dummy csv file i can test with?',
    modelDecision: { route: 'agent', intent: 'create_or_build_deliverable', needs_file_mutation: 'yes', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'budget tracker', rootEntryCount: 4, rootLoaded: true }),
    chatOwnsWorkspace: true,
    expectedRoute: 'agent',
  },
  {
    name: 'foreign (unowned) workspace: a create-intent request still asks for scope confirmation',
    message: 'build a calculator',
    modelDecision: { route: 'agent', intent: 'create_or_build_deliverable', needs_file_mutation: 'yes', confidence: 0.95 },
    workspace: workspace({ workspaceRootName: 'invoicing app', rootEntryCount: 6, rootLoaded: true }),
    chatOwnsWorkspace: false,
    expectedRoute: 'confirm',
  },
];

let failures = 0;

cases.forEach((testCase) => {
  const result = evaluate(testCase.message, {
    advisoryDecision: testCase.advisoryDecision,
    modelDecision: testCase.modelDecision,
    workspace: testCase.workspace,
    agentEnabled: testCase.agentEnabled,
    chatOwnsWorkspace: testCase.chatOwnsWorkspace,
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
