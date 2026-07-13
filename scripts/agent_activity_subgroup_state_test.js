const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'chat-renderer.js'));

const renderer = global.AIExeChatRenderer.createChatRenderer({});
const resolve = renderer.resolveActivitySubgroupDisclosure;
const set = renderer.setActivitySubgroupDisclosure;

assert.equal(resolve('active', { finished: false, startExpanded: true }), true);
set('active', false);
assert.equal(
  resolve('active', { finished: false, startExpanded: true }),
  false,
  'a live rerender must not reopen a subgroup the user closed'
);

set('active', true);
assert.equal(
  resolve('active', { finished: true, startExpanded: true }),
  false,
  'a successful subgroup must auto-collapse once when its phase finishes'
);
set('active', true);
assert.equal(
  resolve('active', { finished: true, startExpanded: false }),
  true,
  'after completion, rerenders must preserve the user disclosure choice'
);

assert.equal(
  resolve('historical', { finished: true, startExpanded: true }),
  false,
  'already-completed successful subgroups start collapsed'
);
assert.equal(
  resolve('error', { finished: true, hasError: true, startExpanded: false }),
  true,
  'failed subgroups remain visible for diagnosis'
);

console.log('PASS: agent activity subgroups auto-collapse once and preserve manual disclosure state');
