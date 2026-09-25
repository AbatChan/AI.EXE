const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = process.argv[2] || '/Users/macbookair2020/Downloads/parcel bench qa';
const ctx = { localStorage: { getItem: () => null, setItem: () => {} } };
ctx.window = ctx;
vm.createContext(ctx);
for (const file of ['state', 'csv']) vm.runInContext(fs.readFileSync(`${root}/js/${file}.js`, 'utf8'), ctx);
const p = ctx.PB;
let failed = 0;
function test(name, fn) { try { p.resetDemo(); fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message); } }
const snapshot = () => JSON.stringify(p.getState());
test('order/cancel/repeated cancel/undo', () => {
  const result = p.confirmOrder('QA', [{ sku: 'T', qty: 2 }, { sku: 'M', qty: 1 }]);
  assert.equal(result.ok, true); assert.equal(p.activeSalesTotalCents(), 2800);
  assert.equal(p.findProduct('T').stock, 3); assert.equal(p.findProduct('M').stock, 2);
  assert.equal(p.cancelOrder(result.order.id).ok, true); assert.equal(p.findProduct('T').stock, 5);
  const before = snapshot(); assert.equal(p.cancelOrder(result.order.id).ok, false); assert.equal(snapshot(), before);
  p.undo(); assert.equal(p.activeSalesTotalCents(), 2800); assert.equal(p.findProduct('M').stock, 2);
});
test('invalid orders never partially mutate', () => {
  for (const lines of [[], [{sku:'T',qty:1},{sku:'M',qty:99}], [{sku:'T',qty:0.5}], [{sku:'T',qty:-1}], [{sku:'T',qty:3},{sku:'t',qty:3}]]) {
    const before = snapshot(); assert.equal(p.confirmOrder('QA', lines).ok, false); assert.equal(snapshot(), before);
  }
});
test('quoted CSV and atomic rejection', () => {
  const parsed = p.parseProductCsv('sku,name,price,stock\nX,"Tea, green",2.00,4');
  assert.equal(parsed.ok, true); assert.equal(parsed.products[0].name, 'Tea, green');
  for (const csv of ['sku,name,price,stock\nX,Tea,2,4\nx,Duplicate,3,2', 'sku,name,price,stock\nX,Tea,2,4\nY,Bad,-2,3']) {
    const before = snapshot(); assert.equal(p.importCsv(csv).ok, false); assert.equal(snapshot(), before);
  }
});
test('historical prices remain immutable', () => {
  p.confirmOrder('QA', [{sku:'T',qty:2}]);
  p.replaceProducts([{sku:'T',name:'Tea',priceCents:9999,stock:3}]);
  assert.equal(p.activeSalesTotalCents(), 2050);
});
test('special SKU duplicates are rejected', () => {
  assert.equal(p.parseProductCsv('sku,name,price,stock\n__proto__,A,1,4\n__proto__,B,2,5').ok, false);
});
test('special SKUs create real order lines', () => {
  for (const sku of ['constructor','__proto__','toString']) {
    p.replaceProducts([{sku,name:'Special',priceCents:100,stock:4}]);
    const result = p.confirmOrder('QA', [{sku,qty:1}]);
    assert.equal(result.ok, true); assert.equal(result.order.lines.length, 1); assert.equal(p.findProduct(sku).stock, 3);
  }
});
process.exitCode = failed ? 1 : 0;
