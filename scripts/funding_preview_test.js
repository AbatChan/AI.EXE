const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('ui/ai-exe.js', 'utf8');
const start = source.indexOf('function bindFundingPreview()');
const end = source.indexOf('let lastAIResearchResult', start);
const listeners = {};
const output = { innerHTML: '' };
let valid = true;
let values = { direction: 'deposit', amount: '100' };
const form = {
  addEventListener: (name, handler) => { listeners[name] = handler; },
  reportValidity: () => valid,
};
const context = vm.createContext({
  document: { getElementById: id => id === 'fundingPreviewForm' ? form : output },
  FormData: class { get(key) { return values[key]; } },
  formatFinanceMoney: cents => `$${(cents / 100).toFixed(2)}`,
  fetch: () => { throw new Error('A preview must never contact a provider'); },
});
vm.runInContext(source.slice(start, end) + '\nbindFundingPreview();', context);
const submit = () => listeners.submit({ preventDefault() {} });
submit();
assert.match(output.innerHTML, /Deposit preview: \$100.00/);
assert.match(output.innerHTML, /not submitted/);
listeners.input();
assert.equal(output.innerHTML, '');
values.direction = 'withdrawal';
submit();
assert.match(output.innerHTML, /Withdrawal preview: \$100.00/);
assert.match(output.innerHTML, /verified bank/);
for (const amount of ['0', '-1', 'NaN', 'Infinity', '1000001']) {
  listeners.input();
  values.amount = amount;
  submit();
  assert.equal(output.innerHTML, '');
}
valid = false;
values.amount = '100';
submit();
assert.equal(output.innerHTML, '');
console.log('Funding preview: deposit, withdrawal, stale review and invalid amounts passed');
