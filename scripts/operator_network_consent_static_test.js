const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const html = fs.readFileSync('ui/ai-exe.html', 'utf8');
const prices = fs.readFileSync('backend/app/prices.py', 'utf8');
const windows = fs.readFileSync('src/gui_main_win_webview.cpp', 'utf8');
const releaseWorkflow = fs.readFileSync('.github/workflows/build-windows.yml', 'utf8');

const start = source.indexOf('(function setupUpdateCheck()');
const end = source.indexOf('// Boot nudge:', start);
assert.ok(start >= 0 && end > start, 'update-check block must exist');
const update = source.slice(start, end);

assert.match(update, /setTimeout\(\(\) => \{ void checkForUpdate\(false\); \}, 8000\)/);
assert.match(update, /setInterval\(\(\) => \{ void checkForUpdate\(false\); \}, AUTO_CHECK_INTERVAL_MS\)/);
assert.match(update, /armUpdateOnQuit/);
assert.match(update, /validSha256/);
assert.doesNotMatch(html, /id="updateBadge"/);
assert.match(html, /id="updateStatus"[^>]*hidden/);
assert.match(html, /id="settingsUpdateCheckBtn"/);

assert.match(windows, /Get-FileHash -Algorithm SHA256/);
assert.match(windows, /case WM_CLOSE:[\s\S]*LaunchPendingUpdateOnQuit/);
assert.match(windows, /LaunchUpdater\(pending->url, pending->version, pending->sha256, false/);
assert.match(releaseWorkflow, /AI\.EXE-Windows\.zip\.sha256/);

const marketHosts = [...prices.matchAll(/https:\/\/([^/"']+)/g)].map((match) => match[1]);
assert.deepEqual([...new Set(marketHosts)].sort(), ['api.coingecko.com', 'api.nasdaq.com']);

console.log('PASS: verified automatic updates install on quit and market data hosts are allowlisted');
