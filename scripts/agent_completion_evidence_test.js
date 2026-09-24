const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('ui/agent-runtime.js', 'utf8');
let prompt;
const ctx = { recordDebugTrace() {}, runBoundedAgentJsonInference: async (value) => {
  prompt = value;
  return { verified: ['Install completes'], unmet: [] };
}};
vm.createContext(ctx);
vm.runInContext(source.match(/    async function verifyAgentDoneCriteria\([^]*?\n    }/)[0], ctx);
(async () => {
  const install = {tool: 'run_command', ok: true, terminalProof: {command: 'npm install --no-audit --no-fund', exitCode: 0}, observation: 'installed successfully'};
  const events = [install, {tool: 'read_file', ok: true, path: '/package.json', content: '{"dependencies":{"next":"15"}}'}];
  for (let i = 0; i < 24; i++) events.push({tool:'read_file', ok:true, path:`/${i}.ts`, observation:'read'});
  events.push({tool:'run_command', ok:false, terminalProof:{command:'npm run build', exitCode:1}, observation:'compiler failed'});
  await ctx.verifyAgentDoneCriteria('Repair build', events, {doneCriteria:['Install completes']});
  const evidence = JSON.parse(prompt.split('TOOL_RESULTS:\n')[1]);
  assert.ok(evidence.some(e => e.terminalProof?.command === install.terminalProof.command && e.terminalProof.exitCode === 0));
  assert.ok(evidence.some(e => e.path === '/package.json' && e.content.includes('next')));
  assert.ok(evidence.some(e => e.ok === false && e.terminalProof?.exitCode === 1));
  console.log('PASS: completion review retains early install evidence, current file contents and failed terminal results');
})();
