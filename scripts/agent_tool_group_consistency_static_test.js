const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat-renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.css'), 'utf8');

assert.match(renderer, /const groupFilePaths = Array\.from\(new Set\(items\.flatMap\(activityPaths\)\)\)/);
assert.match(renderer, /return `Read \$\{groupFileCount\} files`/);
assert.match(renderer, /done: `Updated \$\{groupFileCount\} file/);
assert.match(renderer, /subgroup\.classList\.add\('compact-files'\)/);
assert.match(renderer, /buildAgentActivityRow\(chatId, activity, phase === 'run' \? \{ runGrouped: true \} : \{ compactGrouped: true \}\)/);
assert.match(renderer, /if \(guardSkip\) return null;\n\s+return buildInlineAgentActivityBase\(\{\n\s+kind: failKind,/);
assert.match(renderer, /const redundantOpenMeta = \/\^\(Open file\|Open folder\|Open target\)\$\/i/);
assert.match(renderer, /msg-agent-subgroup-status \$\{outcomeKind\}/);

assert.match(css, /\.msg-agent-subgroup-verb\s*\{[^}]*color:\s*var\(--text\)/s);
assert.match(css, /\.msg-agent-subgroup-meta\s*\{[^}]*color:\s*var\(--text\)/s);
assert.match(css, /\.msg-agent-subgroup\.compact-summary\[data-expanded="true"\] > \.msg-agent-subgroup-toggle \.msg-agent-subgroup-meta\.count-meta\s*\{\s*display:\s*none;/s);
assert.match(css, /\.msg-agent-subgroup\.compact-summary \.msg-agent-subgroup-drawer\s*\{[^}]*background:\s*transparent/s);
assert.match(css, /\.msg-agent-subgroup-drawer\[hidden\]\s*\{[^}]*display:\s*none\s*!important;[^}]*margin-top:\s*0;/s);
assert.match(css, /\.msg-agent-files-drawer-inner\s*\{[^}]*padding:\s*0 0 0 2px;/s);
assert.match(css, /\.msg-agent-activity-row\.files-toggle\[aria-expanded="true"\] \.msg-agent-files-drawer-inner\s*\{[^}]*padding-top:\s*5px;[^}]*padding-bottom:\s*2px;/s);
assert.match(css, /\.msg-agent-subgroup-status\.error\s*\{[^}]*color:\s*var\(--bad\)/s);
assert.match(css, /\.msg-agent-activity-inline-path\.activity-target\s*\{[^}]*font-weight:\s*600/s);

console.log('Passed unified tool-group consistency tests.');
