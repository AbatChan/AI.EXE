// Regression test for validateWebProjectConsistency (agent-executor.js) — the
// multi-page false positive that deadlocked the recipe-app run (v2.6.1).
// A shared data.js referenced #recipe-detail, which is defined in recipe.html,
// but the validator only checked the first HTML page (index.html) and flagged
// it as undefined — triggering an unbreakable repair loop. The fix checks JS
// id/class/data-action references against the UNION of all HTML pages.
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'ui', 'agent-executor.js'));
const exec = global.AIExeAgentExecutor.createAgentExecutor({});
const { validateWebProjectConsistency, getHtmlStructureIssue } = exec;

let passed = 0;
const pass = (name) => { console.log(`PASS: ${name}`); passed += 1; };

const indexHtml = `<!doctype html><html><head>
  <link rel="stylesheet" href="styles.css">
</head><body>
  <main id="recipe-list" class="recipe-grid"></main>
  <script src="data.js"></script>
</body></html>`;

const recipeHtml = `<!doctype html><html><head>
  <link rel="stylesheet" href="styles.css">
</head><body>
  <article id="recipe-detail" class="recipe-detail"></article>
  <script src="data.js"></script>
</body></html>`;

// Shared JS touches an id that lives only on recipe.html and one only on index.html.
const dataJs = `
  const list = document.getElementById('recipe-list');
  const detail = document.getElementById('recipe-detail');
  if (list) renderList(list);
  if (detail) renderDetail(detail);
`;

const stylesCss = `.recipe-grid{display:grid}.recipe-detail{max-width:60ch}`;

const planSpec = { expectedFiles: ['/index.html', '/recipe.html', '/data.js', '/styles.css'] };

// 1) THE FIX: an id defined on the OTHER page must NOT be flagged.
{
  const fileContents = {
    '/index.html': indexHtml,
    '/recipe.html': recipeHtml,
    '/data.js': dataJs,
    '/styles.css': stylesCss,
  };
  const issues = validateWebProjectConsistency(fileContents, planSpec);
  assert.ok(
    !issues.some((i) => /recipe-detail/.test(i)),
    `recipe-detail (defined in recipe.html) must not be flagged; got: ${JSON.stringify(issues)}`,
  );
  assert.ok(
    !issues.some((i) => /recipe-list/.test(i)),
    `recipe-list (defined in index.html) must not be flagged; got: ${JSON.stringify(issues)}`,
  );
  assert.equal(issues.length, 0, `expected zero issues for a valid multi-page app; got: ${JSON.stringify(issues)}`);
  pass('shared JS id defined on a sibling page is not a false positive');
}

// 2) REGRESSION GUARD: an id referenced in JS but defined on NO page is still flagged.
{
  const brokenJs = dataJs + `\n  const ghost = document.getElementById('nonexistent-node');\n  ghost.textContent = 'x';\n`;
  const fileContents = {
    '/index.html': indexHtml,
    '/recipe.html': recipeHtml,
    '/data.js': brokenJs,
    '/styles.css': stylesCss,
  };
  const issues = validateWebProjectConsistency(fileContents, planSpec);
  assert.ok(
    issues.some((i) => /nonexistent-node/.test(i)),
    `a truly-undefined id must still be flagged; got: ${JSON.stringify(issues)}`,
  );
  // And the message should name both pages it checked, not just index.html.
  assert.ok(
    issues.some((i) => /nonexistent-node/.test(i) && i.includes('index.html') && i.includes('recipe.html')),
    `issue message should name all HTML pages checked; got: ${JSON.stringify(issues)}`,
  );
  pass('genuinely undefined id is still flagged, message names all pages');
}

// 3) Single-page projects keep their original behavior (only one HTML file).
{
  const single = { expectedFiles: ['/index.html', '/data.js', '/styles.css'] };
  const fileContents = {
    '/index.html': indexHtml,
    '/data.js': `const detail = document.getElementById('recipe-detail');\ndetail.textContent='x';`,
    '/styles.css': stylesCss,
  };
  const issues = validateWebProjectConsistency(fileContents, single);
  assert.ok(
    issues.some((i) => /recipe-detail/.test(i)),
    `single-page: id absent from the only HTML page is still flagged; got: ${JSON.stringify(issues)}`,
  );
  pass('single-page behavior unchanged (absent id still flagged)');
}

// 4) getHtmlStructureIssue: raw CSS/JS dumped after </html> must be flagged.
//    (The dark-mode run appended a stylesheet after </html> and validate_files
//    reported "no issues found" — this closes that gap.)
{
  const bad = '<!doctype html><html><head></head><body><main></main></body></html>\n\n'
    + '/* ===== DARK MODE ===== */\n[data-theme="dark"] { background: #1a1a2e; }';
  const issue = getHtmlStructureIssue(bad);
  assert.ok(/after the closing <\/html>/.test(issue), `must flag content after </html>; got: ${JSON.stringify(issue)}`);
  pass('raw CSS dumped after </html> is flagged');

  const good = '<!doctype html><html><head></head><body><main></main></body></html>\n  \n<!-- ok -->\n';
  assert.equal(getHtmlStructureIssue(good), '', `trailing whitespace/comment must not flag; got: ${JSON.stringify(getHtmlStructureIssue(good))}`);
  pass('trailing whitespace + comment after </html> is fine');
}

console.log(`\n${passed} passed`);
