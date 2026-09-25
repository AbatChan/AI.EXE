// Model picker: no "Free" without price data; a direct provider is its own vendor; close button styled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.css'), 'utf8');
assert.match(ui, /function providerReportsModelPricing\(provider\) \{\s+const priced = liveProviderPricedModels\[provider\];\s+return Array\.isArray\(priced\) && priced\.length > 0;/);
assert.match(ui, /if \(providerReportsModelPricing\(c\.provider\)\) \{\s+const priceBadge/, 'price badge only with real price data');
assert.match(ui, /\/venice\|huggingface\|customopenai\/i\.test\(String\(c\.provider \|\| ''\)\)\s+\? composerModelProviderLabel\(option\.name\)/);
assert.match(css, /\.composer-model-close \{[\s\S]{0,200}width: 28px;/);
assert.match(css, /\.composer-model-close svg \{ width: 15px; height: 15px; \}/);
console.log('PASS: picker shows prices only when known, real vendor names, a proper close button');

// Updater: graphite badge states; Windows window text stays ASCII (PowerShell mojibake).
{
  const win = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui_main_win_webview.cpp'), 'utf8');
  const start = win.indexOf('bool LaunchUpdater(');
  const script = win.slice(start, win.indexOf('Remove-Item -LiteralPath $status', start))
    .split('\n').filter((l) => /<< L"/.test(l) && !/UL\('/.test(l)).join('\n');
  assert.equal([...script].filter((c) => c.charCodeAt(0) > 127).length, 0, 'window text is ASCII');
  assert.match(script, /Size=New-Object Drawing\.Size\(420,128\)/);
  assert.doesNotMatch(script, /\$si\b|\$left\b|script:spin/, 'old spinner box and logo panel are gone');
  assert.match(ui, /status\.classList\.toggle\('ready', !options\.disabled && !options\.hidden\)/);
  assert.match(css, /\.update-badge\.ready \{ color: var\(--text\); border-color: var\(--accent-32\)/);
  console.log('PASS: updater window + badge follow the graphite design; window text is ASCII');
}
