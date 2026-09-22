const fs = require('fs');
const assert = require('assert');

const ui = fs.readFileSync('ui/ai-exe.js', 'utf8');
const css = fs.readFileSync('ui/ai-exe.css', 'utf8');
const broker = fs.readFileSync('backend/app/routers/broker.py', 'utf8');
const research = fs.readFileSync('backend/app/ai_portfolio.py', 'utf8');

assert.match(ui, /AI portfolio comparison/);
assert.match(ui, /\/api\/broker\/ai-research/);
assert.match(ui, /It cannot create, stage, or confirm an order/);
assert.match(ui, /Cash \/ invalid/);
assert.match(css, /\.ai-research-scoreboard/);
assert.match(broker, /def broker_ai_research/);
assert.match(broker, /Blinded model benchmark\. It has no broker or order path/);
assert.doesNotMatch(research, /paper_broker|submit_order|stage/);
assert.match(research, /return cash, False/);
assert.match(research, /Do not infer identities, dates, prices, or promise returns/);

console.log('AI portfolio research static test: ok');
