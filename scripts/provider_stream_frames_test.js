const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync(require('node:path').join(__dirname, '../ui/ai-exe.js'), 'utf8');
const context = { TextDecoder };
vm.createContext(context);
vm.runInContext(ui.slice(ui.indexOf('async function* readProviderSseFrames('), ui.indexOf('// Real token usage from each provider')), context);

(async () => {
  let released = false;
  const bytes = new TextEncoder().encode('data: {"text":"café"}\r\n\r\ndata: {"usage":{"prompt_tokens":42}}');
  let offset = 0;
  const body = { getReader: () => ({
    read: async () => offset < bytes.length ? {value: bytes.slice(offset, ++offset), done:false} : {done:true},
    releaseLock: () => { released = true; },
  }) };
  const frames = [];
  for await (const frame of context.readProviderSseFrames(body)) frames.push(frame);
  assert.deepEqual(frames, ['data: {"text":"café"}', 'data: {"usage":{"prompt_tokens":42}}']);
  assert.equal(released, true);
  assert.equal((ui.match(/for await \(const frame of readProviderSseFrames\(response.body\)\)/g) || []).length, 2);
  const native = ui.slice(ui.indexOf('async function requestNativeOpenAiCompatibleCompletion'), ui.indexOf('// Preserve split event'));
  assert.match(native, /recordProviderUsage\(provider, model, parsed && parsed.usage, usageChatId\)/);
  assert.ok(native.indexOf('recordProviderUsage(') < native.indexOf('if (!text)'), 'empty paid responses still record usage');
  console.log('PASS: split CRLF, split Unicode, EOF usage frame, released reader and native usage');
})().catch(error => { console.error(error); process.exitCode = 1; });
