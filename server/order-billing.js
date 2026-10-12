import { createHash } from 'node:crypto';
import { DomainError } from './order-service.js';

const BPS = 10_000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const CATEGORIES = ['recommended', 'selfSelected'];
export const DEFAULT_FEE_POLICY = Object.freeze({ recommendedRateBps: 0, selfSelectedRateBps: null });

export function normalizeFeePolicy(value = DEFAULT_FEE_POLICY) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['recommendedRateBps', 'selfSelectedRateBps'].includes(key))
    || !Number.isInteger(value.recommendedRateBps) || value.recommendedRateBps < 0 || value.recommendedRateBps > 10_000
    || !(value.selfSelectedRateBps === null || Number.isInteger(value.selfSelectedRateBps)
      && value.selfSelectedRateBps >= 0 && value.selfSelectedRateBps <= 10_000)) {
    throw new DomainError(400, 'INVALID_FEE_POLICY', '代购比例需为 0% 至 100%，最多保留两位小数；自选比例可选择跟随本期。');
  }
  return { recommendedRateBps: value.recommendedRateBps, selfSelectedRateBps: value.selfSelectedRateBps };
}
export function feePolicyVersion(batch) {
  return createHash('sha256').update(JSON.stringify([batch.code, normalizeFeePolicy(batch.feePolicy),
    [...batch.productIds].sort()])).digest('hex');
}
export function feeRate(batch, category) {
  const policy = normalizeFeePolicy(batch.feePolicy);
  return category === 'selfSelected' ? policy.selfSelectedRateBps ?? policy.recommendedRateBps : policy.recommendedRateBps;
}
export function cents(value) {
  if (value < 0n || value > MAX) throw new DomainError(400, 'AMOUNT_TOO_LARGE', '订单金额过大，暂时无法计算，请联系团长。');
  return Number(value);
}
export function addCents(values) {
  if (values.some(value => value === null)) return null;
  return cents(values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new DomainError(400, 'INVALID_AMOUNT', '订单金额无效。');
    return sum + BigInt(value);
  }, 0n));
}
export function lineCategory(line) {
  if (CATEGORIES.includes(line.snapshot?.feeCategory)) return line.snapshot.feeCategory;
  if (CATEGORIES.includes(line.feeCategory)) return line.feeCategory;
  return line.snapshot?.selfSelected === true ? 'selfSelected' : 'recommended';
}

// A fee is rounded once per customer, period, frozen category and frozen rate.
// Largest-remainder allocation preserves that exact total in exported lines.
export function billLines(input) {
  const lines = input.map(line => ({ ...line, selfSelected: line.snapshot?.selfSelected === true || line.selfSelected === true,
    feeCategory: lineCategory(line), feeRateBps: line.snapshot?.feeRateBps ?? line.feeRateBps ?? 0,
    feeCents: 0, payableCents: line.amountCents }));
  const groups = new Map();
  for (const line of lines) {
    if (!Number.isInteger(line.feeRateBps) || line.feeRateBps < 0 || line.feeRateBps > 10_000) {
      throw new DomainError(500, 'INVALID_SAVED_FEE', '已保存的收费比例无效，请联系团长。');
    }
    if (line.amountCents === null) continue;
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents < 0) throw new DomainError(400, 'INVALID_AMOUNT', '订单金额无效。');
    const key = JSON.stringify([line.batchCode || '', line.phone || '', line.feeCategory, line.feeRateBps]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  for (const group of groups.values()) {
    const rate = BigInt(group[0].feeRateBps);
    const amount = group.reduce((sum, line) => sum + BigInt(line.amountCents), 0n);
    const totalFee = (amount * rate + BPS / 2n) / BPS;
    let floorTotal = 0n;
    const allocation = group.map(line => {
      const exact = BigInt(line.amountCents) * rate;
      const floor = exact / BPS;
      floorTotal += floor;
      return { line, floor, remainder: exact % BPS };
    }).sort((a, b) => a.remainder === b.remainder
      ? String(a.line.lineId) < String(b.line.lineId) ? -1 : String(a.line.lineId) > String(b.line.lineId) ? 1 : 0
      : a.remainder > b.remainder ? -1 : 1);
    let remaining = totalFee - floorTotal;
    for (const entry of allocation) {
      const extra = remaining > 0n ? 1n : 0n;
      remaining -= extra;
      entry.line.feeCents = cents(entry.floor + extra);
      entry.line.payableCents = cents(BigInt(entry.line.amountCents) + BigInt(entry.line.feeCents));
    }
  }
  return lines;
}

export function billingSummary(lines) {
  const groups = new Map();
  for (const line of lines) {
    const category = line.feeCategory || lineCategory(line);
    const rateBps = line.feeRateBps ?? 0;
    const key = JSON.stringify([category, rateBps]);
    if (!groups.has(key)) groups.set(key, { category, rateBps, goods: [], fees: [] });
    groups.get(key).goods.push(line.amountCents);
    groups.get(key).fees.push(line.feeCents ?? 0);
  }
  const feeBreakdown = [...groups.values()].map(group => ({ category: group.category, rateBps: group.rateBps,
    goodsCents: addCents(group.goods), feeCents: addCents(group.fees) })).sort((a, b) =>
    CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.rateBps - b.rateBps);
  const goodsTotalCents = addCents(lines.map(line => line.amountCents));
  const feeTotalCents = addCents(lines.map(line => line.feeCents ?? 0));
  return { goodsTotalCents, feeTotalCents,
    recommendedFeeCents: addCents(feeBreakdown.filter(row => row.category === 'recommended').map(row => row.feeCents)),
    selfSelectedFeeCents: addCents(feeBreakdown.filter(row => row.category === 'selfSelected').map(row => row.feeCents)),
    totalCents: goodsTotalCents === null ? null : addCents([goodsTotalCents, feeTotalCents]), feeBreakdown };
}

export function incrementalBilling(existing, additions) {
  const before = billingSummary(billLines(existing));
  const after = billingSummary(billLines([...existing, ...additions]));
  const goodsTotalCents = addCents(additions.map(line => line.amountCents));
  const feeBreakdown = billingSummary(billLines(additions)).feeBreakdown.map(group => {
    const match = row => row.category === group.category && row.rateBps === group.rateBps;
    return { ...group, feeCents: (after.feeBreakdown.find(match)?.feeCents || 0)
      - (before.feeBreakdown.find(match)?.feeCents || 0) };
  });
  const feeTotalCents = after.feeTotalCents - before.feeTotalCents;
  return { goodsTotalCents, feeTotalCents, totalCents: addCents([goodsTotalCents, feeTotalCents]), feeBreakdown,
    recommendedFeeCents: addCents(feeBreakdown.filter(row => row.category === 'recommended').map(row => row.feeCents)),
    selfSelectedFeeCents: addCents(feeBreakdown.filter(row => row.category === 'selfSelected').map(row => row.feeCents)) };
}
