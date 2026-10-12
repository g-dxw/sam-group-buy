import { createHash } from 'node:crypto';
import { DomainError } from './order-service.js';
import { addCents, cents } from './order-billing.js';

const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
export const excludedSplitStatus = status => ['已取消', '缺货'].includes(status);

export function normalizeSplitRules(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 200) {
    throw new DomainError(400, 'INVALID_SPLIT_RULES', '本期拼份设置无效。');
  }
  const result = {};
  for (const id of Object.keys(input).sort()) {
    const rule = input[id];
    if (!PRODUCT_ID.test(id) || !rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).some(key => !['partsPerPack', 'portionSpec', 'priceCents'].includes(key))
      || !Number.isSafeInteger(rule.partsPerPack) || rule.partsPerPack < 2 || rule.partsPerPack > 1000
      || typeof rule.portionSpec !== 'string' || !rule.portionSpec.trim() || rule.portionSpec.trim().length > 200
      || !Number.isSafeInteger(rule.priceCents) || rule.priceCents < 0 || rule.priceCents > 100_000_000) {
      throw new DomainError(400, 'INVALID_SPLIT_RULES', '每包需拆为 2 至 1000 份，填写每份规格及有效的每份售价。');
    }
    Object.defineProperty(result, id, { enumerable: true, writable: true, configurable: true,
      value: { partsPerPack: rule.partsPerPack, portionSpec: rule.portionSpec.trim(), priceCents: rule.priceCents } });
  }
  return result;
}

export function splitVersion(version, rule, settlement = null) {
  return createHash('sha256').update(JSON.stringify([version, rule, settlement?.settledAt || null])).digest('hex');
}
export function packSnapshot(product, rule) {
  const reference = Object.hasOwn(product, 'originalPriceCents') ? product.originalPriceCents : product.source?.priceCents;
  const hasReference = Number.isSafeInteger(reference) && reference >= 0 && reference <= 100_000_000;
  return { partsPerPack: rule.partsPerPack, portionSpec: rule.portionSpec,
    packProductId: product.id, packProductName: product.name,
    packSpec: product.spec, packUnit: product.unit, packPriceCents: hasReference ? reference : product.priceCents,
    packPriceSource: hasReference ? 'reference' : 'sale_fallback' };
}
export function splitLine(line, settlement) {
  const split = line.snapshot?.split;
  if (!split) return undefined;
  const requestedQuantity = line.quantity;
  const formedQuantity = settlement ? settlement.allocations[line.lineId] || 0 : 0;
  const pendingQuantity = !settlement && !excludedSplitStatus(line.status) ? requestedQuantity : 0;
  return { ...split, requestedQuantity, formedQuantity, pendingQuantity,
    unformedQuantity: requestedQuantity - formedQuantity - pendingQuantity, settledAt: settlement?.settledAt || null };
}
export function pendingSplitSummary(lines) {
  return { pendingGoodsCents: addCents(lines.map(line => line.pendingGoodsCents || 0)),
    pendingQuantity: lines.reduce((sum, line) => sum + (line.split?.pendingQuantity || 0), 0) };
}
export function splitProgress(rule, lines, settlement) {
  const active = lines.filter(line => !excludedSplitStatus(line.status));
  const totalPortions = settlement ? settlement.totalPortions : active.reduce((sum, line) => sum + line.quantity, 0);
  const remainingPortions = totalPortions % rule.partsPerPack;
  const formedPortions = settlement ? settlement.formedPortions : 0;
  return { totalPortions, fullPacks: Math.floor(totalPortions / rule.partsPerPack), remainingPortions,
    neededPortions: remainingPortions ? rule.partsPerPack - remainingPortions : 0,
    settled: Boolean(settlement), purchasedPacks: settlement?.purchasedPacks || 0,
    topUpPortions: settlement?.topUpPortions || 0, formedPortions,
    unformedPortions: settlement ? totalPortions - formedPortions : 0,
    retainedPortions: settlement ? lines.filter(line => excludedSplitStatus(line.status))
      .reduce((sum, line) => sum + (settlement.allocations[line.lineId] || 0), 0) : 0 };
}

// Confirmation freezes FIFO allocations so later cancellations never move a
// customer's reservation into a different purchased pack.
export function allocateSplit(lines, partsPerPack, remainderPolicy, settledAt) {
  const ordered = lines.filter(line => !excludedSplitStatus(line.status)).sort((a, b) =>
    a.submittedAt.localeCompare(b.submittedAt) || a.lineId.localeCompare(b.lineId));
  const totalPortions = ordered.reduce((sum, line) => sum + line.quantity, 0);
  const purchasedPacks = remainderPolicy === 'topUp' ? Math.ceil(totalPortions / partsPerPack) : Math.floor(totalPortions / partsPerPack);
  const formedPortions = Math.min(totalPortions, purchasedPacks * partsPerPack);
  let remaining = formedPortions;
  const allocations = {};
  for (const line of ordered) {
    allocations[line.lineId] = Math.min(line.quantity, remaining);
    remaining -= allocations[line.lineId];
  }
  return { remainderPolicy, settledAt, totalPortions, purchasedPacks, formedPortions,
    topUpPortions: purchasedPacks * partsPerPack - formedPortions, allocations };
}
export function splitAmount(price, quantity) { return cents(BigInt(price) * BigInt(quantity)); }
