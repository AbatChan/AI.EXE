const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

function sliceBalancedFunction(source, name) {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace > start, `missing opening brace for ${name}`);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`missing closing brace for ${name}`);
}

assert.match(aiExe, /function isPreflightDeferralReply/);
assert.match(aiExe, /function derivePendingPreflightOriginalTask/);

const resolveFn = sliceBalancedFunction(aiExe, 'async function resolvePendingPreflightConfirmation');
assert.match(resolveFn, /derivePendingPreflightOriginalTask\(chatId/);
assert.match(resolveFn, /isPreflightDeferralReply\(latest\)/);
assert.match(resolveFn, /preflight_confirmation_deferral_resolved/);
assert.match(resolveFn, /mode:\s*'create_new_project'/);
assert.match(resolveFn, /isolatedAdapterChat:\s*true/);
assert.match(resolveFn, /adapterChatScope:\s*'preflight-confirmation'/);

const submitFn = sliceBalancedFunction(aiExe, 'function submitPendingPreflightChoice');
assert.match(submitFn, /const effectiveTask = derivePendingPreflightOriginalTask/);
assert.match(submitFn, /latestUserOverride: String\(effectiveTask/);

const statusFn = sliceBalancedFunction(aiExe, 'function showPreflightRouteStatus');
assert.match(statusFn, /if \(route === 'confirm'\)/);
assert.match(statusFn, /preflight_route_status_skipped_for_confirm/);
assert.ok(statusFn.indexOf("if (route === 'confirm')") < statusFn.indexOf('setThinkingStatus(text)'), 'confirm skip must happen before thinking status');
assert.ok(statusFn.indexOf("if (route === 'confirm')") < statusFn.indexOf('createLiveAssistantRow(chatId)'), 'confirm skip must happen before live row creation');

const confirmIndex = aiExe.indexOf("if (preflightDecision.route === 'confirm')");
assert.ok(confirmIndex >= 0, 'missing confirm branch');
const inspectIndex = aiExe.indexOf("if (preflightDecision.route === 'inspect')", confirmIndex);
assert.ok(inspectIndex > confirmIndex, 'missing inspect branch after confirm branch');
const confirmBlock = aiExe.slice(confirmIndex, inspectIndex);
assert.match(confirmBlock, /pendingOriginalTask = derivePendingPreflightOriginalTask\(chatId, promptText\)/);
assert.match(confirmBlock, /originalTask: pendingOriginalTask/);
assert.match(confirmBlock, /endInferenceRequest\(\)/);
assert.match(confirmBlock, /renderComposerConfirmationUi\(\)/);
// A throw while presenting the confirmation must surface a fallback question,
// never a silent stop with no UI.
assert.match(confirmBlock, /preflight_confirmation_present_failed/);
assert.match(confirmBlock, /fallbackQuestion/);

const editFn = sliceBalancedFunction(aiExe, 'function saveEditedUserMessage');
assert.ok(editFn.indexOf("resetStaleInferenceRuntime('saveEditedUserMessage:start')") < editFn.indexOf('if (pendingInferenceCount > 0)'), 'edit must recover stale state before pending check');
assert.match(editFn, /requestAssistantReply\(chat\.id/);

const retryFn = sliceBalancedFunction(aiExe, 'function retryAssistantMessage');
assert.ok(retryFn.indexOf("resetStaleInferenceRuntime('retryAssistantMessage:start')") < retryFn.indexOf('if (pendingInferenceCount > 0)'), 'retry must recover stale state before pending check');
assert.match(retryFn, /requestAssistantReply\(chat\.id/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: preflight confirmation resolves deferrals, keeps real task, ends pending lifecycle, and edit/retry recover stale state');
