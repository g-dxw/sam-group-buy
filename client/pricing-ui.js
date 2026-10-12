const MAX_PRICE_CENTS = 100_000_000;

export function moneyInput(cents) {
  return Number.isSafeInteger(cents) && cents >= 0 ? (cents / 100).toFixed(2) : '';
}

export function markupLabel(bps) {
  return Number.isSafeInteger(bps) ? String(bps / 100) : '0';
}

function decimalInput(text, max, label) {
  const clean = String(text ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return { error: `${label}请填写非负数字，最多两位小数。` };
  const [whole, fraction = ''] = clean.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value > max) return { error: label === '加价比例' ? '加价比例需在 0% 至 1000% 之间。' : `${label}需在 0 至 1,000,000 元之间。` };
  return { value };
}

export function parseMoneyInput(text, label = '售价', optional = false) {
  if (optional && !String(text ?? '').trim()) return { value: null };
  return decimalInput(text, MAX_PRICE_CENTS, label);
}

export function parseMarkupInput(text) {
  return decimalInput(text, 100_000, '加价比例');
}

export function originalFromProduct(product) {
  const original = product.originalPriceCents;
  if (Number.isSafeInteger(original) && original >= 0) return original;
  if (Object.hasOwn(product, 'originalPriceCents')) return null;
  // Legacy catalog rows can prefill the collected reference; a missing reference stays empty.
  const collected = product.source?.priceCents;
  return Number.isSafeInteger(collected) && collected >= 0 ? collected : null;
}

export function initialPricingDraft(product) {
  const original = originalFromProduct(product);
  const legacy = !['markup', 'amount'].includes(product.pricing?.mode);
  const canUseAmount = original !== null && Number.isSafeInteger(product.priceCents) && product.priceCents >= original;
  const mode = legacy ? canUseAmount ? 'amount' : 'fixed' : product.pricing.mode;
  return {
    originalPrice: moneyInput(original),
    price: moneyInput(product.priceCents),
    pricingMode: mode,
    markupPercent: markupLabel(product.pricing?.markupBps ?? 0),
    markupAmount: moneyInput(mode === 'amount' ? legacy ? product.priceCents - original : product.pricing.amountCents : 0),
    allowLegacyFixed: legacy && !canUseAmount,
  };
}

export function evaluatePricingDraft(draft) {
  const original = parseMoneyInput(draft.originalPrice, '原价', true);
  const errors = {};
  if (original.error) errors.originalPrice = original.error;
  let priceCents = null;
  let pricing;
  if (draft.pricingMode === 'markup') {
    const markup = parseMarkupInput(draft.markupPercent);
    if (markup.error) errors.markupPercent = markup.error;
    if (!original.error && original.value === null) errors.originalPrice = '按比例加价需要原价，请先补填原价。';
    if (!original.error && original.value !== null && !markup.error) {
      priceCents = Math.floor((original.value * (10_000 + markup.value) + 5_000) / 10_000);
      if (!Number.isSafeInteger(priceCents) || priceCents > MAX_PRICE_CENTS) errors.markupPercent = '计算后的售价超过 1,000,000 元，请降低加价比例。';
      pricing = { mode: 'markup', markupBps: markup.value };
    }
  } else if (draft.pricingMode === 'amount') {
    const amount = parseMoneyInput(draft.markupAmount, '加价金额');
    if (amount.error) errors.markupAmount = amount.error;
    if (!original.error && original.value === null) errors.originalPrice = '固定金额加价需要原价，请先补填原价。';
    if (!original.error && original.value !== null && !amount.error) {
      priceCents = original.value + amount.value;
      if (!Number.isSafeInteger(priceCents) || priceCents > MAX_PRICE_CENTS) errors.markupAmount = '计算后的售价超过 1,000,000 元，请降低加价金额。';
      pricing = { mode: 'amount', markupBps: null, amountCents: amount.value };
    }
  } else if (draft.pricingMode === 'fixed') {
    const price = parseMoneyInput(draft.price);
    if (price.error) errors.price = price.error;
    else priceCents = price.value;
    pricing = { mode: 'fixed', markupBps: null };
  } else {
    errors.pricingMode = '请选择定价方式。';
  }
  return { originalPriceCents: original.value ?? null, priceCents, pricing, errors, valid: !Object.keys(errors).length };
}
