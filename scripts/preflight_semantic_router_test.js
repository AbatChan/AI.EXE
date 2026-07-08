const assert = require('node:assert/strict');
const path = require('node:path');

const router = require(path.join(__dirname, '..', 'ui', 'preflight-router.js'));

function evaluate(message, modelDecision, overrides = {}) {
  return router.evaluate({
    latestUserMessage: message,
    modelDecision,
    advisoryDecision: overrides.advisoryDecision || {},
    agentEnabled: overrides.agentEnabled !== false,
    chatOwnsWorkspace: Boolean(overrides.chatOwnsWorkspace),
    workspace: overrides.workspace || {
      currentPath: '/',
      currentKind: 'folder',
      workspaceRootName: '',
      rootEntryCount: 0,
    },
  });
}

// Non-English/slang/no-keyword creation should route through the semantic model,
// not through English keyword matching.
{
  const result = evaluate(
    'ṣe app kan fun mi, make am clean',
    {
      route: 'agent',
      intent: 'create_or_build_deliverable',
      needs_workspace: true,
      needs_file_mutation: true,
      confidence: 0.94,
      reason: 'The user wants a deliverable created.',
    }
  );

  assert.equal(result.decision.route, 'agent');
  assert.equal(result.debug.routeSource, 'model');
  assert.equal(result.debug.usedModelDecision, true);
  assert.equal(result.debug.usedFallbackDecision, false);
  assert.equal(result.debug.semanticRoute, 'agent');
}

// High-confidence semantic chat must not be overridden by English trigger words.
// This proves keyword regex is no longer the primary decision maker.
{
  const result = evaluate(
    'build me a website',
    {
      route: 'chat',
      intent: 'general_answer',
      needs_workspace: false,
      needs_file_mutation: false,
      confidence: 0.96,
      reason: 'The user is asking conceptually in this test case.',
    }
  );

  assert.equal(result.decision.route, 'chat');
  assert.equal(result.debug.routeSource, 'model');
  assert.equal(result.debug.initialRoute, 'chat');
}

// Low-confidence model output falls back to deterministic legacy scoring.
{
  const result = evaluate(
    'build me a website',
    {
      route: 'chat',
      intent: 'general_answer',
      needs_workspace: false,
      needs_file_mutation: false,
      confidence: 0.12,
      reason: 'Low-confidence guess.',
    }
  );

  assert.equal(result.debug.routeSource, 'fallback');
  assert.equal(result.debug.usedModelDecision, false);
  assert.equal(result.debug.usedFallbackDecision, true);
  assert.equal(result.decision.route, 'agent');
}

// Hard product gates still override the semantic route. Agent mode off means no
// workspace read/write route may run.
{
  const result = evaluate(
    'ṣe app kan fun mi',
    {
      route: 'agent',
      intent: 'create_or_build_deliverable',
      needs_workspace: true,
      needs_file_mutation: true,
      confidence: 0.98,
      reason: 'The user wants a deliverable created.',
    },
    { agentEnabled: false }
  );

  assert.equal(result.decision.route, 'chat');
  assert.equal(result.debug.routeSource, 'model');
  assert.equal(result.debug.initialRoute, 'agent');
  assert.match(result.decision.reason, /Agent mode/i);
}

console.log('PASS: semantic router uses LLM route as primary, fallback scoring only when model route is low-confidence/missing, and hard gates still apply');
