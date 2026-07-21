const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat-renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.css'), 'utf8');

assert.match(renderer, /const groupFilePaths = Array\.from\(new Set\(items\.flatMap\(activityPaths\)\)\)/);
assert.match(renderer, /return `Read \$\{groupFileCount\} files`/);
assert.match(renderer, /done: `Updated \$\{groupFileCount\} file/);
assert.match(renderer, /subgroup\.classList\.add\('compact-files'\)/);
assert.match(renderer, /buildAgentActivityRow\(chatId, activity, \{ compactGrouped: true \}\)/);
assert.match(renderer, /kind: guardSkip \? 'skip' : failKind/);
assert.match(renderer, /const redundantOpenMeta = \/\^\(Open file\|Open folder\|Open target\)\$\/i/);
assert.match(renderer, /msg-agent-subgroup-status \$\{outcomeKind\}/);

assert.match(css, /\.msg-agent-subgroup-verb\s*\{[^}]*color:\s*rgba\(220, 228, 242, 0\.88\)/s);
assert.match(css, /\.msg-agent-subgroup-meta\s*\{[^}]*color:\s*rgba\(188, 199, 218, 0\.88\)/s);
assert.match(css, /\.msg-agent-subgroup\.compact-summary\[data-expanded="true"\] \.msg-agent-subgroup-meta\.count-meta\s*\{\s*display:\s*none;/s);
assert.match(css, /\.msg-agent-subgroup\.compact-summary \.msg-agent-subgroup-drawer\s*\{[^}]*background:\s*transparent/s);
assert.match(css, /\.msg-agent-subgroup-drawer\[hidden\]\s*\{[^}]*display:\s*none\s*!important;[^}]*margin-top:\s*0;/s);
assert.match(css, /\.msg-agent-subgroup-status\.error\s*\{[^}]*color:\s*#fb7185/s);
assert.match(css, /\.msg-agent-activity-inline-path\.activity-target\s*\{[^}]*font-weight:\s*600/s);

console.log('Passed unified tool-group consistency tests.');
