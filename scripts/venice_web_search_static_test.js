const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('ui/ai-exe.js');
const html = read('ui/ai-exe.html');
const adapter = read('backend/app/venice_adapter_server.py');
const models = read('backend/app/models.py');
const usage = read('backend/app/routers/usage.py');
const llm = read('backend/app/llm.py');

assert.match(html, /id="menuWebSearchBtn"/, 'Web Search is available in the composer action menu');
assert.match(html, /id="webSearchBtn"/, 'active Web Search renders as a removable composer chip');
assert.match(app, /webSearchActive: Boolean\(webSearchEnabled\)/, 'the send path snapshots Web Search for the full turn');
assert.match(app, /web_search: options\.webSearchActive \? 'on' : 'off'/, 'stream requests carry explicit on/off state');
assert.match(app, /!completionOptions\.stopOnCompleteJson && !completionOptions\.isolatedAdapterChat/, 'isolated and structured internal calls cannot inherit web search');
assert.match(models, /web_search: str = ""/, 'the backend request model accepts Web Search state');
assert.match(usage, /body\["aiexe_web_search"\] = payload\.web_search/, 'stream relay forwards Web Search state');
assert.match(llm, /payload\["aiexe_web_search"\] = web_search/, 'non-stream relay forwards Web Search state');
assert.match(adapter, /_aiexe_set_switch\(driver, "Web Enabled", bool\(web_enabled\)\)/, 'Venice Web Enabled follows the requested state');
assert.match(adapter, /_skey = "%s\|%s\|%s"/, 'settings cache distinguishes Think and Web combinations');
assert.match(adapter, /_aiexe_forget_chat_settings\(_chat_key\)/, 'a fresh temporary chat reapplies requested settings');

console.log('PASS: Venice Web Search is request-scoped and isolated from structured agent calls.');
