const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const html = fs.readFileSync('ui/ai-exe.html', 'utf8');
const prices = fs.readFileSync('backend/app/prices.py', 'utf8');

const start = source.indexOf('(function setupUpdateCheck()');
const end = source.indexOf('// Boot nudge:', start);
assert.ok(start >= 0 && end > start, 'update-check block must exist');
const update = source.slice(start, end);

assert.doesNotMatch(update, /setTimeout\s*\(\s*checkForUpdate/);
assert.doesNotMatch(update, /setInterval\s*\(\s*checkForUpdate/);
assert.match(update, /async function onBadgeClick\(\)[\s\S]*await checkForUpdate\(\)/);
assert.match(html, /id="updateBadge"[^>]*data-tooltip="Check GitHub/);
assert.doesNotMatch(html, /id="updateBadge"[^>]*display\s*:\s*none/);

const marketHosts = [...prices.matchAll(/https:\/\/([^/"']+)/g)].map((match) => match[1]);
assert.deepEqual([...new Set(marketHosts)].sort(), ['api.coingecko.com', 'api.nasdaq.com']);

console.log('PASS: startup update traffic is disabled and market data hosts are allowlisted');
