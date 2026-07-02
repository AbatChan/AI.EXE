// Test for harvestFoundationVocabulary (agent-core.js) — the demand-driven half of
// the structure-first pipeline (v5.3.0). It extracts the shared vocabulary from
// files already built in earlier phases (stylesheets, design tokens, component
// classes, shell hooks) so later pages REFERENCE real names instead of inventing a
// divergent header/footer/color scheme per page.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-core.js'));
const core = global.AIExeAgentCore.createAgentCore({});
const { harvestFoundationVocabulary } = core;

let passed = 0;
const pass = (name) => { console.log(`PASS: ${name}`); passed += 1; };

// One shared stylesheet that contains the design tokens (:root) AND the components.
const styleCss = `:root{
  --primary:#4f46e5; --bg:#0b0b0f; --text:#e5e7eb; --space-4:1rem; --radius-lg:12px;
  background-image:url(logo.svg);
}
.btn{padding:.5rem} .btn-primary{background:var(--primary)} .btn-secondary{border:1px solid}
.card{border-radius:var(--radius-lg)} .nav{display:flex} .container{max-width:1100px} .footer{margin-top:4rem}`;
const componentsJs = `export function mount(){
  document.querySelector('[data-site-header]').innerHTML = '<header class="nav">...</header>';
  document.querySelector('[data-site-footer]').innerHTML = '<footer class="footer">...</footer>';
}`;
const indexHtml = `<!doctype html><html><head>
  <link rel="stylesheet" href="css/style.css">
</head><body><div data-site-header></div><main></main><div data-site-footer></div>
<script src="js/components.js"></script></body></html>`;

const vocab = harvestFoundationVocabulary({
  '/css/style.css': styleCss,
  '/js/components.js': componentsJs,
  '/index.html': indexHtml,
});

// Shared stylesheet surfaced for linking.
assert.match(vocab, /css\/style\.css/);
pass('lists the shared stylesheet');

// Design tokens harvested.
['--primary', '--bg', '--text', '--space-4', '--radius-lg'].forEach((t) => assert.ok(vocab.includes(t), `token ${t} present`));
pass('harvests design tokens');

// Component classes harvested (the reuse vocabulary).
['.btn-primary', '.btn-secondary', '.card', '.nav', '.container', '.footer'].forEach((c) => assert.ok(vocab.includes(c), `class ${c} present`));
pass('harvests component classes');

// Shared shell hooks + component script surfaced.
assert.match(vocab, /data-site-header/);
assert.match(vocab, /data-site-footer/);
assert.match(vocab, /js\/components\.js/);
pass('surfaces shared shell hooks and component script');

// False positives (file extensions / units picked up by the class regex) excluded.
assert.ok(!/\.svg\b/.test(vocab), 'no .svg false positive');
assert.ok(!/(^|[^-\w])\.5\b/.test(vocab), 'no .5 unit false positive');
pass('excludes extension/unit false positives');

// Nothing built yet (phase 1) → empty, so no injection.
assert.equal(harvestFoundationVocabulary({}), '');
assert.equal(harvestFoundationVocabulary({ '/index.html': '   ' }), '');
pass('empty when nothing is built');

console.log(`\n${passed} checks passed.`);
