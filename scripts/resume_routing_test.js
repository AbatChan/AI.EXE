// v9.9.5 — "bet" after a finished phase must continue the build, not answer in chat.
// Live: the router saw no pending-build context, called it casual_chat at 0.90, and the
// chat reply narrated work it could not run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const router = fs.readFileSync(path.join(root, 'ui', 'preflight-router.js'), 'utf8');
const promptMd = fs.readFileSync(path.join(root, 'ui', 'prompts', 'chat_main.md'), 'utf8');
const promptJs = fs.readFileSync(path.join(root, 'ui', 'prompt-core.js'), 'utf8');

// ---- 1. The router is TOLD about the paused build (the actual root cause) ----
assert.match(aiExe, /function describePausedBuildForRouting\(chatId\)/, 'paused-build state is described for the router');
assert.match(aiExe, /`Paused build: \$\{context\.pausedBuild \? `yes — \$\{context\.pausedBuildSummary\}` : 'no'\}`/,
  'and reaches the router prompt');
assert.match(aiExe, /pausedBuild: Boolean\(pausedBuild\)/, 'the flag is passed at the call site');
assert.match(aiExe, /intent="resume_paused_build"/, 'the prompt names the resume intent');

// The rule must define a DECISION BOUNDARY, not a vocabulary. A synonym list in the prompt
// is the same brittleness as the regex it replaced, and it silently drops the other
// direction: "not now" / "hold on" / "change the plan" are equally short replies here.
const ruleStart = aiExe.indexOf("'- PAUSED BUILD:");
const ruleEnd = aiExe.indexOf("'- When \"Paused build\" says no");
assert.ok(ruleStart > 0 && ruleEnd > ruleStart, 'the paused-build rule block is present');
const pausedRule = aiExe.slice(ruleStart, ruleEnd + 200);
assert.match(pausedRule, /gives the go-ahead, accepts, urges you on, or asks for the remainder/,
  'the accept direction is described by intent');
assert.match(pausedRule, /declines, defers, says wait\/later\/stop, or changes the plan => do NOT resume/,
  'the DECLINE direction exists — the original rule resumed on anything agreement-shaped');
assert.match(pausedRule, /asks a question, raises a new topic, or reports a problem/,
  'and a question mid-pause is routed on its own terms');
assert.match(pausedRule, /do not pattern-match vocabulary/, 'the model is told to read meaning');
// Guard the principle: no enumerated synonym list may creep back into this rule.
const synonyms = ['"go"', '"sure"', '"do it"', '"next"', '"yes please"', '"ok"', '"yeah"', '"yep"', '👍'];
const leaked = synonyms.filter((word) => pausedRule.includes(word));
assert.deepEqual(leaked, [], `the rule must not enumerate phrasings (found ${leaked.join(', ')})`);

// Examples teach the boundary: the SAME message on both sides, plus the decline direction.
assert.match(aiExe, /User: "bet" \(Paused build: yes\)[\s\S]{0,200}resume_paused_build/, 'accepting with work pending resumes');
assert.match(aiExe, /User: "bet" \(Paused build: no\)[\s\S]{0,200}"route":"chat"/, 'the same word with nothing pending is chat');
assert.match(aiExe, /User: "not now" \(Paused build: yes\)[\s\S]{0,200}"route":"chat"/, 'declining does not resume');
assert.match(router, /'resume_paused_build',/, 'the fallback router accepts the intent');
assert.match(router, /m\.intent === 'resume_paused_build' \? 'agent'/, 'and maps it to the agent route');

// ---- 2. A router-recognised agreement resumes instead of planning from scratch ----
assert.match(aiExe, /const routedResume = String\(\(preflightDecision && preflightDecision\.intent\)/,
  'the agent branch reads the resume intent');
assert.match(aiExe, /requestToken\.routedResume = true;/, 'and flags the request');
assert.match(aiExe, /const routerSaidResume = Boolean\(requestToken && requestToken\.routedResume\);/,
  'the agent entry point honours it');
assert.match(aiExe, /routerSaidResume \|\| shouldTreatAsAgentResumeRequest\(chatId, rawPromptText\)/,
  'the phrase list is now one of two ways in, not the only one');
assert.match(aiExe, /resolveAgentResumeTaskText\(chatId, rawPromptText, \{ isResume: routerSaidResume \}\)/,
  'the ORIGINAL task is recovered — planning against the word "bet" finalizes as a no-op');

// ---- 3. Chat must never narrate work it cannot do ----
for (const [name, text] of [['chat_main.md', promptMd], ['prompt-core.js', promptJs]]) {
  assert.match(text, /You are in CHAT, so you cannot run tools this turn/, `${name} carries the rule`);
  // prompt-core.js carries the same line inside a JS string, so the quotes are escaped.
  assert.match(text, /no \\?"starting now\\?", \\?"continuing the build\\?"/, `${name} names the exact failure`);
  assert.match(text, /tell them to press Continue/, `${name} says what to do instead`);
}

// ---- Behavioural: the invented status tag never reaches the bubble ----
// Extract the two real replace() lines and run them, so this tests the shipped regexes.
const stripLines = aiExe
  .split('\n')
  .filter((line) => /agent_status\|tool_status\|task_status/.test(line))
  .map((line) => line.trim().replace(/^clean = /, 'clean = '));
assert.equal(stripLines.length, 2, 'both strip rules are present');
const strip = (input) => {
  const ctx = { clean: input };
  vm.createContext(ctx);
  stripLines.forEach((line) => vm.runInContext(line, ctx));
  return ctx.clean.trim();
};

assert.equal(
  strip('Starting now.\n\n<agent_status>working</agent_status>'),
  'Starting now.',
  'the leaked tag is removed',
);
assert.equal(strip('<agent_status>working</agent_status>'), '', 'a tag-only reply collapses to empty');
assert.equal(strip('done\n<tool_status>idle</tool_status>\ntail'), 'done\n\ntail', 'sibling invented tags too');
// Never eat real prose: the tag name inside a sentence or a fence must survive.
const prose = 'The model emitted an agent_status tag we do not define.';
assert.equal(strip(prose), prose, 'prose mentioning the tag name is untouched');
const fenced = '```html\n<div>hello</div>\n```';
assert.equal(strip(fenced), fenced, 'ordinary markup is untouched');

console.log('PASS: the router is told when a build is paused and routes an agreement like "bet" to resume with the original task, chat can no longer narrate work it cannot run, and invented status tags never render');
