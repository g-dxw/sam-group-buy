import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePricingDraft, initialPricingDraft, markupLabel, originalFromProduct, parseMarkupInput, parseMoneyInput } from '../client/pricing-ui.js';

test('legacy sale becomes a difference-based amount draft without treating the sale as markup', () => {
  const draft = initialPricingDraft({ priceCents: 10900, source: { priceCents: 10000 } });
  assert.deepEqual(draft, { originalPrice: '100.00', price: '109.00', pricingMode: 'amount', markupPercent: '0', markupAmount: '9.00', allowLegacyFixed: false });
  assert.equal(evaluatePricingDraft(draft).priceCents, 10900);
  assert.equal(originalFromProduct({ originalPriceCents: null, source: { priceCents: 10000 } }), null);
  assert.equal(originalFromProduct({ originalPriceCents: 0, source: { priceCents: 10000 } }), 0);
  assert.equal(originalFromProduct({}), null);
});

test('percent parser preserves hundredths and rejects unsupported or out of range inputs', () => {
  assert.deepEqual(parseMarkupInput('1.25'), { value: 125 });
  assert.deepEqual(parseMarkupInput('0'), { value: 0 });
  assert.deepEqual(parseMarkupInput('1000.00'), { value: 100000 });
  for (const text of ['', '-1', '1000.01', '1.005', '1e2', 'Infinity', 'NaN']) assert.ok(parseMarkupInput(text).error, text);
  assert.equal(markupLabel(125), '1.25');
});

test('money inputs parse exact cents and distinguish missing original from zero', () => {
  assert.deepEqual(parseMoneyInput('29.8'), { value: 2980 });
  assert.deepEqual(parseMoneyInput('0.01'), { value: 1 });
  assert.deepEqual(parseMoneyInput('', '原价', true), { value: null });
  assert.deepEqual(parseMoneyInput('0', '原价', true), { value: 0 });
  for (const text of ['1000000.01', '29.801', '-0.01', '1e3']) assert.ok(parseMoneyInput(text).error, text);
});

test('markup computes from original with half up rounding at cent boundary', () => {
  assert.deepEqual(evaluatePricingDraft({ originalPrice: '100.00', price: '109.00', pricingMode: 'markup', markupPercent: '5' }), { originalPriceCents: 10000, priceCents: 10500, pricing: { mode: 'markup', markupBps: 500 }, errors: {}, valid: true });
  assert.equal(evaluatePricingDraft({ originalPrice: '0.50', pricingMode: 'markup', markupPercent: '1' }).priceCents, 51);
  assert.equal(evaluatePricingDraft({ originalPrice: '0.49', pricingMode: 'markup', markupPercent: '1' }).priceCents, 49);
  assert.equal(evaluatePricingDraft({ originalPrice: '100', pricingMode: 'markup', markupPercent: '0' }).priceCents, 10000);
});

test('both markup modes require original while special legacy sale remains editable without repricing', () => {
  const missing = evaluatePricingDraft({ originalPrice: '', pricingMode: 'markup', markupPercent: '5' });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.originalPrice);
  const missingAmount = evaluatePricingDraft({ originalPrice: '', pricingMode: 'amount', markupAmount: '5' });
  assert.equal(missingAmount.valid, false);
  assert.ok(missingAmount.errors.originalPrice);
  const fixed = evaluatePricingDraft({ originalPrice: '', price: '109', pricingMode: 'fixed' });
  assert.equal(fixed.valid, true);
  assert.equal(fixed.originalPriceCents, null);
  const discount = evaluatePricingDraft({ originalPrice: '100', price: '99', pricingMode: 'fixed' });
  assert.equal(discount.valid, true);
  assert.equal(discount.priceCents, 9900);
  const noOriginal = initialPricingDraft({ originalPriceCents: null, priceCents: 10900, pricing: { mode: 'fixed', markupBps: null } });
  assert.equal(noOriginal.pricingMode, 'fixed');
  assert.equal(noOriginal.allowLegacyFixed, true);
  assert.equal(evaluatePricingDraft(noOriginal).priceCents, 10900);
  const belowOriginal = initialPricingDraft({ originalPriceCents: 10000, priceCents: 9900, pricing: { mode: 'fixed', markupBps: null } });
  assert.equal(belowOriginal.pricingMode, 'fixed');
  assert.equal(belowOriginal.allowLegacyFixed, true);
  assert.equal(evaluatePricingDraft(belowOriginal).priceCents, 9900);
});

test('amount pricing adds exact nonnegative cents and accepts zero as original-price sale', () => {
  const priced = evaluatePricingDraft({ originalPrice: '100.00', pricingMode: 'amount', markupAmount: '5.25' });
  assert.deepEqual(priced, { originalPriceCents: 10000, priceCents: 10525, pricing: { mode: 'amount', markupBps: null, amountCents: 525 }, errors: {}, valid: true });
  assert.equal(evaluatePricingDraft({ originalPrice: '29.80', pricingMode: 'amount', markupAmount: '0' }).priceCents, 2980);
  assert.equal(evaluatePricingDraft({ originalPrice: '0', pricingMode: 'amount', markupAmount: '0.01' }).priceCents, 1);
  for (const amount of ['-0.01', '0.005', '1e2']) {
    const rejected = evaluatePricingDraft({ originalPrice: '100', pricingMode: 'amount', markupAmount: amount });
    assert.equal(rejected.valid, false, amount);
    assert.ok(rejected.errors.markupAmount, amount);
  }
});

test('canonical amount drafts preserve their rule and reprice from the edited original', () => {
  const draft = initialPricingDraft({ originalPriceCents: 10000, priceCents: 10500, pricing: { mode: 'amount', markupBps: null, amountCents: 500 } });
  assert.equal(draft.pricingMode, 'amount');
  assert.equal(draft.markupAmount, '5.00');
  assert.equal(draft.allowLegacyFixed, false);
  assert.equal(evaluatePricingDraft({ ...draft, originalPrice: '110' }).priceCents, 11500);
  const zeroDelta = initialPricingDraft({ originalPriceCents: 10000, priceCents: 10000, pricing: { mode: 'fixed', markupBps: null } });
  assert.equal(zeroDelta.markupAmount, '0.00');
  assert.equal(evaluatePricingDraft(zeroDelta).priceCents, 10000);
});

test('calculated prices cannot exceed the supported range even for valid original and percentage', () => {
  const tooLarge = evaluatePricingDraft({ originalPrice: '1000000', pricingMode: 'markup', markupPercent: '1000' });
  assert.equal(tooLarge.valid, false);
  assert.ok(tooLarge.errors.markupPercent);
  const zeroOriginal = evaluatePricingDraft({ originalPrice: '0', pricingMode: 'markup', markupPercent: '1000' });
  assert.equal(zeroOriginal.valid, true);
  assert.equal(zeroOriginal.priceCents, 0);
  const amountTooLarge = evaluatePricingDraft({ originalPrice: '1000000', pricingMode: 'amount', markupAmount: '0.01' });
  assert.equal(amountTooLarge.valid, false);
  assert.ok(amountTooLarge.errors.markupAmount);
  const maximum = evaluatePricingDraft({ originalPrice: '999999.99', pricingMode: 'amount', markupAmount: '0.01' });
  assert.equal(maximum.valid, true);
  assert.equal(maximum.priceCents, 100_000_000);
});
