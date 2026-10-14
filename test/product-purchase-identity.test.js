import test from 'node:test';
import assert from 'node:assert/strict';
import {
  purchaseIdentityKey, sameWholePurchase, indexFeaturedWholeProducts, canonicalWholeProduct,
  normalizePurchaseCart, purchaseCartStampKey, MAX_PURCHASE_QUANTITY,
} from '../client/product-purchase-identity.js';

const identity = { platform: 'samsclub_cn', storeType: 2, storeId: '6505', spuId: '111', kind: 'whole' };
const featured = { id: 'sam_111', name: '精选整包', unit: '盒', priceCents: 4000, feeCategory: 'recommended', purchaseIdentity: identity };
const personal = { id: 'self_2_6505_111', name: '原私人整包', unit: '件', priceCents: 2980, feeCategory: 'selfSelected', purchaseIdentity: { ...identity } };
const portion = { ...featured, id: 'split-beef', unit: '份', priceCents: 1000,
  split: { partsPerPack: 3 }, purchaseIdentity: { ...identity, kind: 'portion' } };

test('only complete matching whole purchase identities count as the same goods', () => {
  assert.equal(sameWholePurchase(featured, personal), true);
  assert.equal(sameWholePurchase(featured, portion), false);
  for (const difference of [{ storeId: '6506' }, { storeType: 4 }, { spuId: '222' }, { platform: 'other' }]) {
    assert.equal(sameWholePurchase(featured, { ...personal, purchaseIdentity: { ...identity, ...difference } }), false);
  }
});

test('missing provenance or conflicting split metadata cannot silently merge a private SKU', () => {
  for (const purchaseIdentity of [undefined, { spuId: '111' }, { ...identity, storeId: '' }, { ...identity, storeType: '2' }, { ...identity, kind: undefined }]) {
    const unconfirmed = { ...personal, purchaseIdentity };
    assert.equal(purchaseIdentityKey(unconfirmed), null); assert.equal(sameWholePurchase(featured, unconfirmed), false);
  }
  const inconsistent = { ...personal, split: { partsPerPack: 3 } };
  assert.equal(purchaseIdentityKey(inconsistent), null); assert.equal(sameWholePurchase(featured, inconsistent), false);
});

test('whole query aliases use the complete featured product so its price and fee category win together', () => {
  const index = indexFeaturedWholeProducts([portion, featured]);
  assert.equal(index.size, 1);
  assert.strictEqual(canonicalWholeProduct(personal, index), featured);
  assert.strictEqual(canonicalWholeProduct(portion, index), portion);
  const anotherStore = { ...personal, purchaseIdentity: { ...identity, storeId: '6506' } };
  assert.strictEqual(canonicalWholeProduct(anotherStore, index), anotherStore);
});

test('switching between whole query and featured tabs combines quantity without changing the original cart', () => {
  const cart = { sam_111: 2, self_2_6505_111: 3, untouched: 4 };
  const result = normalizePurchaseCart(cart, [featured], [personal]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.cart, { sam_111: 5, untouched: 4 });
  assert.deepEqual(result.moved, [{ from: personal.id, to: featured.id, quantity: 3 }]);
  assert.deepEqual(result.overLimit, []);
  assert.deepEqual(cart, { sam_111: 2, self_2_6505_111: 3, untouched: 4 });
});

test('a recommended portion and the queried original whole pack remain separate cart entries', () => {
  const cart = { 'split-beef': 3, self_2_6505_111: 2 };
  const result = normalizePurchaseCart(cart, [portion], [personal]);
  assert.equal(result.changed, false); assert.strictEqual(result.cart, cart);
  assert.deepEqual(result.moved, []);
  assert.equal(result.cart[portion.id], 3); assert.equal(result.cart[personal.id], 2);
});

test('another store and unknown saved SKU IDs remain independent while known whole aliases merge', () => {
  const foreign = { ...personal, id: 'self_2_6506_111', purchaseIdentity: { ...identity, storeId: '6506' } };
  const cart = { [personal.id]: 2, [foreign.id]: 1, old_unknown_111: 3 };
  const result = normalizePurchaseCart(cart, [featured], [personal, foreign]);
  assert.deepEqual(result.cart, { sam_111: 2, [foreign.id]: 1, old_unknown_111: 3 });
});

test('merged quantities exceeding the order limit are retained and reported instead of being silently clipped', () => {
  assert.equal(MAX_PURCHASE_QUANTITY, 999);
  const cart = { [featured.id]: 999, [personal.id]: 3 };
  const result = normalizePurchaseCart(cart, [featured], [personal]);
  assert.deepEqual(result.cart, { sam_111: 1002 });
  assert.deepEqual(result.overLimit, ['sam_111']);
  assert.equal(result.moved[0].quantity, 3);
});

test('unsafe quantities and an invalid existing canonical quantity are preserved for explicit correction', () => {
  const invalid = { [featured.id]: '2', [personal.id]: 3 };
  const result = normalizePurchaseCart(invalid, [featured], [personal]);
  assert.equal(result.changed, false); assert.strictEqual(result.cart, invalid);
  const unsafe = { [featured.id]: Number.MAX_SAFE_INTEGER, [personal.id]: 1 };
  const large = normalizePurchaseCart(unsafe, [featured], [personal]);
  assert.equal(large.changed, false); assert.strictEqual(large.cart, unsafe);
});

test('normalization is idempotent after a known alias has been moved to the featured ID', () => {
  const first = normalizePurchaseCart({ [personal.id]: 3 }, [featured], [personal]);
  const second = normalizePurchaseCart(first.cart, [featured], [personal]);
  assert.equal(second.changed, false); assert.strictEqual(second.cart, first.cart); assert.deepEqual(second.moved, []);
});

const collisionPortion = { ...portion, id: featured.id };
const movedWhole = { ...personal, previousProductId: featured.id };

test('a legacy cart ID shared by an old whole quote and the current portion requires explicit reselection without a purchase stamp', () => {
  const cart = { [featured.id]: 2 };
  const result = normalizePurchaseCart(cart, [collisionPortion], [movedWhole]);
  assert.deepEqual(result.cart, cart); assert.equal(result.changed, false);
  assert.deepEqual(result.conflicts.map(conflict => conflict.id), [featured.id]);
});

test('an explicitly stamped portion keeps its original cart entry despite a migrated whole alias', () => {
  const cart = { [featured.id]: 3 };
  const stamp = purchaseIdentityKey(collisionPortion);
  const result = normalizePurchaseCart(cart, [collisionPortion], [movedWhole], { [featured.id]: stamp });
  assert.deepEqual(result.cart, cart); assert.equal(result.changed, false);
  assert.deepEqual(result.conflicts, []); assert.equal(result.stamps[featured.id], stamp);
});

test('an explicitly stamped old whole ID moves all its quantity to the independent whole ID', () => {
  const stamp = purchaseIdentityKey(movedWhole);
  const result = normalizePurchaseCart({ [featured.id]: 4, [personal.id]: 2 }, [collisionPortion], [movedWhole], { [featured.id]: stamp, [personal.id]: stamp });
  assert.deepEqual(result.cart, { [personal.id]: 6 });
  assert.deepEqual(result.conflicts, []); assert.equal(result.changed, true);
  assert.equal(result.stamps[personal.id], stamp); assert.equal(result.stamps[featured.id], undefined);
});

test('ordinary whole aliases move their purchase stamp together with quantity when promoted to the featured ID', () => {
  const stamp = purchaseIdentityKey(personal);
  const result = normalizePurchaseCart({ [personal.id]: 3 }, [featured], [personal], { [personal.id]: stamp });
  assert.deepEqual(result.cart, { [featured.id]: 3 });
  assert.deepEqual(result.conflicts, []); assert.equal(result.stamps[featured.id], stamp);
  assert.equal(result.stamps[personal.id], undefined);
});

test('same-ID Sam whole and portion changes are detected without any private migration record', () => {
  for (const [before, after] of [[featured, collisionPortion], [collisionPortion, featured]]) {
    const cart = { [featured.id]: 3 };
    const result = normalizePurchaseCart(cart, [after], [], { [featured.id]: purchaseCartStampKey(before) });
    assert.strictEqual(result.cart, cart); assert.equal(result.changed, false);
    assert.deepEqual(result.conflicts.map(conflict => conflict.id), [featured.id]);
  }
});

test('an unstamped legacy Sam portion requires reselection while a matching portion stamp remains valid', () => {
  const cart = { [collisionPortion.id]: 3 };
  const legacy = normalizePurchaseCart(cart, [collisionPortion], []);
  assert.strictEqual(legacy.cart, cart); assert.deepEqual(legacy.conflicts.map(conflict => conflict.id), [collisionPortion.id]);
  const stamped = normalizePurchaseCart(cart, [collisionPortion], [], { [collisionPortion.id]: purchaseCartStampKey(collisionPortion) });
  assert.strictEqual(stamped.cart, cart); assert.deepEqual(stamped.conflicts, []);
});

test('manual product stamps protect the local whole or portion form without claiming cross-ID Sam equality', () => {
  const manualWhole = { id: '手工牛肉', priceCents: 18000 };
  const manualPortion = { ...manualWhole, split: { partsPerPack: 3 }, priceCents: 6000 };
  assert.equal(purchaseIdentityKey(manualWhole), null); assert.equal(purchaseIdentityKey(manualPortion), null);
  assert.equal(sameWholePurchase(manualWhole, { ...manualWhole, id: '另一手工牛肉' }), false);
  assert.notEqual(purchaseCartStampKey(manualWhole), purchaseCartStampKey(manualPortion));
  assert.notEqual(purchaseCartStampKey(manualWhole), purchaseCartStampKey({ ...manualWhole, id: '另一手工牛肉' }));
  for (const [before, after] of [[manualWhole, manualPortion], [manualPortion, manualWhole]]) {
    const cart = { [manualWhole.id]: 3 };
    const result = normalizePurchaseCart(cart, [after], [], { [manualWhole.id]: purchaseCartStampKey(before) });
    assert.strictEqual(result.cart, cart); assert.deepEqual(result.conflicts.map(conflict => conflict.id), [manualWhole.id]);
    const matching = normalizePurchaseCart(cart, [after], [], { [manualWhole.id]: purchaseCartStampKey(after) });
    assert.strictEqual(matching.cart, cart); assert.deepEqual(matching.conflicts, []);
  }
  const noStamp = normalizePurchaseCart({ [manualPortion.id]: 2 }, [manualPortion], []);
  assert.deepEqual(noStamp.conflicts.map(conflict => conflict.id), [manualPortion.id]);
});

test('a conflicted canonical target cannot have its saved quantity overwritten by a valid whole alias', () => {
  const cart = { [featured.id]: 3, [personal.id]: 2 };
  const stamps = { [featured.id]: purchaseCartStampKey(collisionPortion), [personal.id]: purchaseCartStampKey(personal) };
  const result = normalizePurchaseCart(cart, [featured], [personal], stamps);
  assert.strictEqual(result.cart, cart); assert.deepEqual(result.cart, { [featured.id]: 3, [personal.id]: 2 });
  assert.equal(result.changed, false); assert.deepEqual(result.moved, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.id), [featured.id]);
  assert.deepEqual(result.stamps, stamps);
});

test('removing a conflicting entry and selecting the current form produces a clean stamped cart', () => {
  const original = normalizePurchaseCart({ [featured.id]: 3 }, [collisionPortion], [], { [featured.id]: purchaseCartStampKey(featured) });
  assert.equal(original.conflicts.length, 1);
  const removed = normalizePurchaseCart({}, [collisionPortion], [], {});
  assert.deepEqual(removed.conflicts, []);
  const reselected = normalizePurchaseCart({ [featured.id]: 1 }, [collisionPortion], [], { [featured.id]: purchaseCartStampKey(collisionPortion) });
  assert.deepEqual(reselected.cart, { [featured.id]: 1 }); assert.deepEqual(reselected.conflicts, []);
});
