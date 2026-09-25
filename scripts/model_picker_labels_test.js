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
