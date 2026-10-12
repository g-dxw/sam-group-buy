import test from 'node:test';
import assert from 'node:assert/strict';
import { packSnapshot } from '../server/split-groups.js';

const rule = { partsPerPack: 3, portionSpec: '约600g', priceCents: 6300 };
const product = { id: 'beef', name: '牛肉卷', spec: '1.8kg', unit: '盒', priceCents: 18900,
  originalPriceCents: 18000, source: { priceCents: 17000 } };

test('split procurement reference uses original price while the portion selling price stays independent', () => {
  const snapshot = packSnapshot(product, rule);
  assert.equal(snapshot.packPriceCents, 18000);
  assert.equal(snapshot.packPriceSource, 'reference');
  assert.equal(rule.priceCents, 6300);
  assert.equal(product.priceCents, 18900);
});

test('explicitly missing reference uses labelled sale fallback; legacy objects can use their captured source price', () => {
  const snapshot = packSnapshot({ ...product, originalPriceCents: null }, rule);
  assert.equal(snapshot.packPriceCents, 18900);
  assert.equal(snapshot.packPriceSource, 'sale_fallback');
  const { originalPriceCents, ...legacy } = product;
  const old = packSnapshot(legacy, rule);
  assert.equal(old.packPriceCents, 17000);
  assert.equal(old.packPriceSource, 'reference');
});
