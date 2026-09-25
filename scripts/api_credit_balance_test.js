const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ai-exe.js'), 'utf8');
const start = source.indexOf('function parseDeepSeekCreditBalances(');
const end = source.indexOf('function getCreditReferences(', start);
assert.ok(start > 0 && end > start, 'credit parser and progress helpers exist');
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

const balances = context.parseDeepSeekCreditBalances({ balance_infos: [
  { currency: 'USD', total_balance: '12.40' },
  { currency: 'CNY', total_balance: '0.00' },
  { currency: 'USD', total_balance: '' },
  { currency: 'USD', total_balance: 'NaN' },
  { currency: 'USD', total_balance: '-3' },
] });
assert.deepEqual(Array.from(balances, (row) => ({ ...row })), [
  { currency: 'USD', amount: 12.4 },
  { currency: 'CNY', amount: 0 },
]);
assert.equal(context.creditRemainingPercent(7.5, 10), 75);
assert.equal(context.creditRemainingPercent(12, 10), 100, 'a top-up cannot overflow the bar');
assert.equal(context.creditRemainingPercent(0, 10), 0);
assert.equal(context.creditRemainingPercent(3, 0), 0, 'no reference means no invented percentage');
assert.equal(context.creditRemainingPercent(NaN, 10), 0);

const balanceCases = [
  [{ balance_infos: null }, []],
  [{ balance_infos: [{ currency: 'usd', total_balance: '0.0001' }] }, [{ currency: 'USD', amount: 0.0001 }]],
  [{ balance_infos: [{ currency: 'USD', total_balance: '-0.01' }, { currency: 'US D', total_balance: 4 }] }, []],
];
for (const [payload, expected] of balanceCases) {
  assert.deepEqual(Array.from(context.parseDeepSeekCreditBalances(payload), (row) => ({ ...row })), expected);
}
for (const [amount, reference, expected] of [[10, 10, 100], [2.5, 10, 25], [50, 10, 100], [-1, 10, 0], [1, -1, 0]]) {
  assert.equal(context.creditRemainingPercent(amount, reference), expected);
}

const selectionStart = source.indexOf('function creditKeyTag(');
const selectionEnd = source.indexOf('function isUsageDashboardVisible(', selectionStart);
assert.ok(selectionStart > 0 && selectionEnd > selectionStart, 'selected-provider lookup exists');
let selected = 'openai';
const selection = vm.createContext({
  getSelectedInferenceProvider: () => selected,
  getProviderApiKey: (provider) => `${provider}-test-key`,
});
vm.runInContext(`const CREDIT_BALANCE_PROVIDERS = ['deepseek', 'venice'];\n${source.slice(selectionStart, selectionEnd)}`, selection);
assert.equal(selection.configuredCreditSources().length, 0, 'other configured providers stay hidden');
selected = 'deepseek';
assert.deepEqual(Array.from(selection.configuredCreditSources(), (row) => row.provider), ['deepseek']);
assert.ok(!selection.configuredCreditSources()[0].keyTag.includes('test-key'), 'reference ID does not store key characters');
selected = 'venice';
assert.deepEqual(Array.from(selection.configuredCreditSources(), (row) => row.provider), ['venice']);
selected = 'anthropic';
assert.equal(selection.configuredCreditSources().length, 0);
selected = 'gemini';
assert.equal(selection.configuredCreditSources().length, 0);
selected = 'local';
assert.equal(selection.configuredCreditSources().length, 0);

const ratesStart = source.indexOf('const CREDIT_COST_RATES =');
const ratesEnd = source.indexOf('let creditReferences =', ratesStart);
const estimateStart = source.indexOf('function estimateModelUsageCost(');
const estimateEnd = source.indexOf('function renderEstimatedProviderCost(', estimateStart);
assert.ok(ratesStart > 0 && estimateStart > ratesEnd && estimateEnd > estimateStart);
const pricing = vm.createContext({});
vm.runInContext(source.slice(ratesStart, ratesEnd) + source.slice(estimateStart, estimateEnd), pricing);
const estimate = pricing.estimateModelUsageCost('openai', 'gpt-6-luna', {
  input: 1_000_000, cached: 200_000, cache_write: 100_000, output: 100_000,
}, '2026-09');
assert.ok(Math.abs(estimate - 0.1345) < 1e-10, 'cache reads and writes replace ordinary input rates');
assert.equal(pricing.estimateModelUsageCost('openai', 'unknown', { input: 1_000_000 }, '2026-09'), null);
assert.equal(pricing.estimateModelUsageCost('gemini', 'gemini-3.8-flash', { input: 1000 }, '2027-01'), null, 'expired promotional rate is not reused');
const modelCases = [
  ['openai', 'gpt-6-astra', 10, 1, 12.5, 50],
  ['openai', 'gpt-6-sol', 2, .2, 2.5, 10],
  ['openai', 'gpt-6-luna', .1, .01, .125, .5],
  ['anthropic', 'claude-opus-5-5', 4, .2, 5, 20],
  ['anthropic', 'claude-sonnet-5', 2, .2, 2.5, 10],
  ['anthropic', 'claude-haiku-4-5-20251001', 1, .1, 1.25, 5],
  ['gemini', 'gemini-3.8-flash', .75, .075, .75, 3.75],
  ['gemini', 'gemini-3.7-flash', .75, .075, .75, 3.75],
  ['gemini', 'gemini-3.5-flash', 1.5, .15, 1.5, 9],
];
let checked = 0;
for (const [provider, model, inputRate, cacheRate, writeRate, outputRate] of modelCases) {
  for (const [row, expected] of [
    [{ input: 1_000_000 }, inputRate],
    [{ input: 1_000_000, cached: 1_000_000 }, cacheRate],
    [{ input: 1_000_000, cache_write: 1_000_000 }, writeRate],
    [{ output: 1_000_000 }, outputRate],
    [{ input: 1_000_000, cached: 500_000, cache_write: 500_000 }, (cacheRate + writeRate) / 2],
  ]) {
    const actual = pricing.estimateModelUsageCost(provider, model, row, '2026-09');
    assert.ok(Math.abs(actual - expected) < 1e-10, `${provider}/${model}: ${JSON.stringify(row)} expected ${expected}, got ${actual}`);
    checked++;
  }
}
for (const provider of ['deepseek', 'venice', 'huggingface', 'custom']) {
  assert.equal(pricing.estimateModelUsageCost(provider, 'any-model', { input: 1_000_000 }, '2026-09'), null);
  checked++;
}
for (const row of [
  { input: -1, output: -1 },
  { input: 'bad', cached: 'bad', output: 'bad' },
  { input: 100, cached: 200, cache_write: 300, output: 0 },
]) {
  const cost = pricing.estimateModelUsageCost('openai', 'gpt-6-luna', row, '2026-09');
  assert.ok(Number.isFinite(cost) && cost >= 0, 'malformed or overlapping counts cannot produce invalid cost');
  checked++;
}
assert.equal(pricing.estimateModelUsageCost('gemini', 'gemini-3.8-flash', { input: 1_000_000 }, '2026-12'), .75);
assert.equal(pricing.estimateModelUsageCost('gemini', 'gemini-3.8-flash', { input: 1_000_000 }, '2027-01'), null);
checked += 2;

async function testProviderSwitchDuringBalanceFetch() {
  const refreshStart = source.indexOf('async function refreshCreditBalances(');
  const refreshEnd = source.indexOf('function scheduleCreditBalanceRefresh(', refreshStart);
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart);
  let provider = 'deepseek';
  let releaseFirst;
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const requests = [];
  const balance = vm.createContext({
    isUsageDashboardVisible: () => true,
    configuredCreditSources: () => [{ provider, keyTag: provider + '-key' }],
    fetchCreditBalance: (item) => {
      requests.push(item.provider);
      return item.provider === 'deepseek' ? firstResult : Promise.resolve([{ provider: item.provider, keyTag: item.keyTag, currency: 'USD', amount: 8 }]);
    },
    renderCreditBalances: () => {},
  });
  vm.runInContext(`let creditBalanceRows = []; let creditBalanceSourceKey = ''; let creditBalanceCheckedAt = 0; let creditBalancePending = null;\n${source.slice(refreshStart, refreshEnd)}`, balance);
  const first = balance.refreshCreditBalances();
  provider = 'venice';
  const switched = balance.refreshCreditBalances();
  releaseFirst([{ provider: 'deepseek', keyTag: 'deepseek-key', currency: 'USD', amount: 10 }]);
  await Promise.all([first, switched]);
  assert.deepEqual(requests, ['deepseek', 'venice'], 'switching providers while a request is pending fetches the new balance');
  await balance.refreshCreditBalances();
  assert.deepEqual(requests, ['deepseek', 'venice'], 'cached selected balance is not fetched twice');
  return 2;
}

function testRenderedSpendFallback() {
  const renderSource = source.slice(estimateEnd, source.indexOf('function renderCreditBalances(', estimateEnd));
  const view = vm.createContext({ escapeHtml: (value) => value });
  vm.runInContext(`let usageDashboardPeriod = '2026-09'; let usageDashboardCostData = null; ${source.slice(ratesStart, ratesEnd)} ${source.slice(estimateStart, estimateEnd)} ${renderSource}`, view);
  const setData = (value) => { view.usageData = value; vm.runInContext('usageDashboardCostData = usageData', view); };
  let checks = 0;
  assert.match(view.renderEstimatedProviderCost('openai'), /Checking recorded usage/); checks++;
  setData({ period: '2026-09', providers: {} });
  assert.match(view.renderEstimatedProviderCost('openai'), /No API usage recorded/); checks++;
  setData({ period: '2026-09', providers: { openai: { unknown: { calls: 3, input: 1_000_000 } } } });
  assert.match(view.renderEstimatedProviderCost('openai'), /No verified price/); checks++;
  setData({ period: '2026-09', providers: { openai: {
    'gpt-6-luna': { calls: 2, input: 1_000_000 }, unknown: { calls: 3, input: 1_000_000 },
  } } });
  const partial = view.renderEstimatedProviderCost('openai');
  assert.match(partial, /Estimated from 2 recorded calls/);
  assert.match(partial, /3 calls have no verified price/);
  assert.match(partial, /\$0\.10/);
  assert.match(partial, /Your bill may differ/); checks += 4;
  setData({ period: '2026-09', error: true });
  assert.match(view.renderEstimatedProviderCost('openai'), /unavailable while local usage data is offline/); checks++;
  setData({ period: '2026-08', providers: {} });
  assert.match(view.renderEstimatedProviderCost('openai'), /Checking recorded usage/); checks++;
  return checks;
}

testProviderSwitchDuringBalanceFetch().then((more) => {
  console.log(`api_credit_balance_test: ${checked + more + testRenderedSpendFallback()} pricing, balance, switch and display cases ok`);
}).catch((error) => { console.error(error); process.exitCode = 1; });
