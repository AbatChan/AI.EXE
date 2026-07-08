const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiExe = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const cmake = fs.readFileSync(path.join(__dirname, '..', 'CMakeLists.txt'), 'utf8');
const pkg = require('../package.json');

function indexOfOrFail(haystack, needle, label = needle) {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `missing ${label}`);
  return index;
}

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

const cleanupFn = sliceBalancedFunction(aiExe, 'function clearPreflightConfirmationLiveStatus');
assert.match(cleanupFn, /clearTypingIndicator\(\)/);
assert.match(cleanupFn, /setThinkingStatus\(''\)/);
assert.match(cleanupFn, /activeStreamRow\.remove\(\)/);
assert.match(cleanupFn, /preflight_confirmation_live_status_cleared/);

const decisionLogIndex = indexOfOrFail(aiExe, "recordDebugTrace('preflight_route_decision'");
const noWorkspaceBypassIndex = indexOfOrFail(aiExe, "preflight_confirmation_bypassed");
const confirmIndex = indexOfOrFail(aiExe, "if (preflightDecision.route === 'confirm')", "confirm branch");
const presentIndex = indexOfOrFail(aiExe, "preflight_confirmation_presented");
const showStatusIndex = indexOfOrFail(aiExe, "showPreflightRouteStatus(chatId, preflightDecision);");

assert.ok(decisionLogIndex < noWorkspaceBypassIndex, 'decision should be logged before bypass handling');
assert.ok(noWorkspaceBypassIndex < confirmIndex, 'no-workspace bypass should happen before confirm presentation');
assert.ok(confirmIndex < presentIndex, 'confirm branch should log presentation');
assert.ok(presentIndex < showStatusIndex, 'showPreflightRouteStatus must happen after confirm branch');
assert.match(aiExe, /clearPreflightConfirmationLiveStatus\(chatId, 'preflight_route_confirm'\)/);
assert.match(aiExe, /renderComposerConfirmationUi\(\)/);

assert.equal(pkg.version, (cmake.match(/AI_EXE_APP_VERSION "([^"]+)"/) || [])[1]);

console.log('PASS: preflight confirm shows composer confirmation without leaving live status loader stuck');
