import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PURCHASE_QUANTITY, canonicalWholeProduct, indexFeaturedWholeProducts, normalizePurchaseCart,
  purchaseIdentityKey, purchaseCartStampKey, sameWholePurchase,
} from '../client/product-purchase-identity.js';

// Execute the actual non-JSX App functions against isolated state and storage.
// No browser, business database, API or real localStorage is touched.
const source = readFileSync(new URL('../client/App.jsx', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing App source section: ${start}`);
  return source.slice(from, to);
};
const displayedFunctions = section('  function displayedPurchaseProduct(', '  function renderSamsProduct(');
const storageFunctions = section('  function persistPersonalCart(', '  function selectShoppingTab(');
const quantityFunctions = section('  function updateQuantity(', '  async function submitOrder(');
const normalizationEffect = section('    // Never rewrite an in-flight submission', '  }, [normalizedCart, working, catalogState, customerState, identity.error]);');
const productMapComputation = section('  const productMap = useMemo(() => {', '  const items = useMemo(');
const priceChecks = section('const knownPrice = product =>', 'const personalStorageError =');
const workingStatuses = section('const activeStatuses =', 'const changedProduct =');
const workingComputation = section('  const orderWorking =', '  const refreshContext =');
const { knownPrice, purchasable } = new Function(`${priceChecks}; return { knownPrice, purchasable };`)();

const identity = { platform: 'samsclub_cn', storeType: 2, storeId: '6505', spuId: '111', kind: 'whole' };
const featured = { id: 'sam_111', name: '精选整包', spec: '一盒', unit: '盒', priceCents: 4000,
  feeCategory: 'recommended', onSale: true, purchaseIdentity: identity };
const personal = { id: 'self_2_6505_111', name: '自选整包', spec: '1kg', unit: '件', priceCents: 2980,
  feeCategory: 'selfSelected', selfSelected: true, onSale: true, selectable: true, purchaseIdentity: { ...identity } };
const collisionWhole = { ...personal, id: 'self_whole_2_6505_111', previousProductId: personal.id };
const collisionPortion = { ...featured, id: personal.id, spec: '约333g / 份', unit: '份', priceCents: 1000,
  split: { partsPerPack: 3 }, purchaseIdentity: { ...identity, kind: 'portion' } };

function fixture({ products = [], customerProducts = [], cart = {}, stamps = {}, working, submission = null } = {}) {
  const stored = new Map();
  const changes = { carts: [], stamps: [], notifications: [], errors: [], tokenChecks: 0 };
  const env = {
    MAX_PURCHASE_QUANTITY, canonicalWholeProduct, indexFeaturedWholeProducts, normalizePurchaseCart,
    purchaseIdentityKey, purchaseCartStampKey, sameWholePurchase, knownPrice, purchasable,
    products, customerProducts, cart, working, submission, collecting: true, submitBusy: false, customerAdding: '',
    catalogState: 'ready', customerState: 'ready', identity: { error: '' },
    cartKey: 'fixture-cart', cartIdentityKey: 'fixture-cart-identities',
    latestRef: { current: { cart, cartIdentities: stamps, submission } },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    requireCustomerToken: () => { changes.tokenChecks += 1; },
    setCart: value => { env.cart = value; changes.carts.push(value); },
    setCartIdentities: value => changes.stamps.push(value),
    setNotification: value => changes.notifications.push(value),
    setCustomerError: value => changes.errors.push(value),
    setSubmission: value => { env.submission = value; env.latestRef.current.submission = value; },
    useMemo: calculate => calculate(),
  };
  env.working = working ?? new Function('env', `with (env) { ${workingStatuses}; ${workingComputation}; return working; }`)(env);
  const functions = new Function('env', `with (env) {
    ${displayedFunctions}
    ${storageFunctions}
    ${quantityFunctions}
    function runNormalization() { ${normalizationEffect} }
    return { displayedPurchaseProduct, productPurchaseConflict, productCartQuantity, commitCart, updateQuantity, removeItem, runNormalization };
  }`)(env);
  const recompute = () => {
    env.featuredWholeProducts = indexFeaturedWholeProducts(env.products);
    env.normalizedCart = normalizePurchaseCart(env.cart, env.products, env.customerProducts, env.latestRef.current.cartIdentities);
    env.productMap = new Function('env', `with (env) { ${productMapComputation}; return productMap; }`)(env);
  };
  recompute();
  return { env, stored, changes, recompute, ...functions };
}

test('a cached whole query uses its trusted migrated whole object and cannot read the current portion quantity', () => {
  const h = fixture({ products: [collisionPortion], customerProducts: [collisionWhole],
    cart: { [collisionPortion.id]: 2, [collisionWhole.id]: 1 },
    stamps: { [collisionPortion.id]: purchaseCartStampKey(collisionPortion), [collisionWhole.id]: purchaseCartStampKey(collisionWhole) } });
  assert.strictEqual(h.displayedPurchaseProduct(personal), collisionWhole);
  assert.equal(h.productCartQuantity(personal), 1);
  assert.equal(h.productCartQuantity(collisionPortion), 2);
  assert.equal(h.productPurchaseConflict(personal), false);
});

test('a legacy unstamped quantity is retained for correction and displayed as zero chosen portions', () => {
  const h = fixture({ products: [collisionPortion], customerProducts: [collisionWhole], cart: { [personal.id]: 4 } });
  assert.equal(h.productCartQuantity(collisionPortion), 0); assert.equal(h.productPurchaseConflict(collisionPortion), true);
  assert.equal(h.productCartQuantity(personal), 0);
  assert.deepEqual(h.env.normalizedCart.cart, { [personal.id]: 4 });
  assert.equal(h.env.productMap.get(personal.id).purchaseConflict, true);
  assert.equal(h.env.productMap.get(personal.id).onSale, false);
});

test('a restored whole recommendation wins over a previous-ID private migration and carries the recommended price and fees', () => {
  const restored = { ...featured, id: personal.id, priceCents: 3200 };
  const h = fixture({ products: [restored], customerProducts: [collisionWhole],
    cart: { [restored.id]: 2 }, stamps: { [restored.id]: purchaseCartStampKey(restored) } });
  assert.strictEqual(h.displayedPurchaseProduct(personal), restored);
  assert.equal(h.displayedPurchaseProduct(personal).priceCents, 3200);
  assert.equal(h.displayedPurchaseProduct(personal).feeCategory, 'recommended');
  assert.equal(h.productCartQuantity(personal), 2);
});

test('without a trusted previous-ID whole alias, cached whole metadata cannot read a same-ID portion cart row', () => {
  const h = fixture({ products: [collisionPortion], cart: { [personal.id]: 2 },
    stamps: { [personal.id]: purchaseCartStampKey(collisionPortion) } });
  assert.strictEqual(h.displayedPurchaseProduct(personal), personal);
  assert.equal(h.productCartQuantity(personal), 0); assert.equal(h.productCartQuantity(collisionPortion), 2);
});

test('pending recovery payloads and persisted cart data remain untouched by normalization or quantity actions while working', () => {
  for (const status of ['pending', 'processing', 'reconciling']) {
    const payload = { submissionId: 'fixture-recovery', items: [{ productId: personal.id, quantity: 3, version: 'saved-version' }], phone: '13800138000' };
    const submission = { status, payload };
    const cart = { [featured.id]: 2, [personal.id]: 3 };
    const h = fixture({ products: [featured], customerProducts: [personal], cart, submission });
    const bytes = JSON.stringify(submission); h.stored.set('fixture-pending', bytes);
    assert.equal(h.env.working, true);
    assert.equal(h.env.normalizedCart.changed, true);
    h.runNormalization(); h.updateQuantity(featured.id, 8); h.removeItem(personal.id);
    assert.strictEqual(h.env.latestRef.current.cart, cart); assert.strictEqual(h.env.latestRef.current.submission.payload, payload);
    assert.equal(h.stored.get('fixture-pending'), bytes); assert.equal(h.stored.size, 1);
    assert.deepEqual(h.changes.carts, []); assert.deepEqual(h.changes.stamps, []);
  }
});

test('ready whole aliases normalize to the featured ID with summed quantity and an atomic cart identity sidecar', () => {
  const h = fixture({ products: [featured], customerProducts: [personal], cart: { [featured.id]: 2, [personal.id]: 3 } });
  h.runNormalization();
  assert.deepEqual(h.env.latestRef.current.cart, { [featured.id]: 5 });
  assert.equal(h.env.latestRef.current.cartIdentities[featured.id], purchaseCartStampKey(featured));
  assert.deepEqual(JSON.parse(h.stored.get('fixture-cart')), { [featured.id]: 5 });
  const sidecar = JSON.parse(h.stored.get('fixture-cart-identities'));
  assert.deepEqual(sidecar.cart, { [featured.id]: 5 }); assert.deepEqual(sidecar.identities, h.env.latestRef.current.cartIdentities);
  assert.equal(h.changes.notifications.length, 1);
});

test('automatic alias migration waits for catalog, private list and browser identity recovery', () => {
  const h = fixture({ products: [featured], customerProducts: [personal], cart: { [personal.id]: 3 } });
  h.env.customerState = 'loading'; h.runNormalization(); assert.equal(h.changes.carts.length, 0);
  h.env.customerState = 'ready'; h.env.catalogState = 'loading'; h.runNormalization(); assert.equal(h.changes.carts.length, 0);
  h.env.catalogState = 'ready'; h.env.identity.error = '身份待恢复'; h.runNormalization(); assert.equal(h.changes.carts.length, 0);
  h.env.identity.error = ''; h.runNormalization(); assert.deepEqual(h.env.latestRef.current.cart, { [featured.id]: 3 });
});

test('changing a known whole alias updates the shared canonical quantity without losing the existing sum', () => {
  const h = fixture({ products: [featured], customerProducts: [personal], cart: { [featured.id]: 2, [personal.id]: 3 } });
  h.updateQuantity(personal.id, 6);
  assert.deepEqual(h.env.latestRef.current.cart, { [featured.id]: 6 });
  assert.equal(h.env.latestRef.current.cartIdentities[featured.id], purchaseCartStampKey(featured));
  h.recompute(); assert.equal(h.productCartQuantity(personal), 6); assert.equal(h.productCartQuantity(featured), 6);
});

test('over-limit merged quantities decrease one by one without being clipped to the order maximum', () => {
  const h = fixture({ products: [featured], cart: { [featured.id]: 1050 }, stamps: { [featured.id]: purchaseCartStampKey(featured) } });
  h.updateQuantity(featured.id, 1049);
  assert.equal(h.env.latestRef.current.cart[featured.id], 1049);
  h.recompute(); h.updateQuantity(featured.id, 1050);
  assert.equal(h.env.latestRef.current.cart[featured.id], 1049); assert.equal(h.changes.carts.length, 1);
  h.updateQuantity(featured.id, 999); assert.equal(h.env.latestRef.current.cart[featured.id], 999);
});

test('unknown or conflicting specifications can be removed without guessing a unit or requiring a product price', () => {
  const h = fixture({ products: [collisionPortion], cart: { [personal.id]: 4, unknown_sku: 2 }, stamps: { unknown_sku: 'unknown-old-stamp' } });
  assert.equal(h.env.productMap.get(personal.id).purchaseConflict, true);
  h.removeItem('unknown_sku');
  assert.equal(h.env.latestRef.current.cart.unknown_sku, undefined);
  assert.equal(h.env.latestRef.current.cartIdentities.unknown_sku, undefined);
  h.removeItem(personal.id); assert.deepEqual(h.env.latestRef.current.cart, {});
  assert.deepEqual(h.env.latestRef.current.cartIdentities, {});
});

test('removing a whole-versus-portion conflict then selecting the current portion writes its new form stamp', () => {
  const h = fixture({ products: [collisionPortion], cart: { [personal.id]: 4 }, stamps: { [personal.id]: purchaseCartStampKey(personal) } });
  assert.equal(h.productPurchaseConflict(collisionPortion), true);
  h.removeItem(personal.id); h.recompute(); h.updateQuantity(personal.id, 1); h.recompute();
  assert.deepEqual(h.env.latestRef.current.cart, { [personal.id]: 1 });
  assert.equal(h.env.latestRef.current.cartIdentities[personal.id], purchaseCartStampKey(collisionPortion));
  assert.deepEqual(h.env.normalizedCart.conflicts, []); assert.equal(h.productCartQuantity(collisionPortion), 1);
});

test('a failed persistent cart write does not commit replacement quantities or identities to UI state', () => {
  const h = fixture({ products: [featured], cart: { [featured.id]: 2 }, stamps: { [featured.id]: purchaseCartStampKey(featured) } });
  const originalCart = h.env.latestRef.current.cart; const originalStamps = h.env.latestRef.current.cartIdentities;
  h.env.localStorage.setItem = () => { throw new Error('isolated storage unavailable'); };
  h.updateQuantity(featured.id, 3);
  assert.strictEqual(h.env.latestRef.current.cart, originalCart); assert.strictEqual(h.env.latestRef.current.cartIdentities, originalStamps);
  assert.deepEqual(h.changes.carts, []); assert.equal(h.changes.errors.length, 1); assert.match(h.changes.errors[0], /购物车.*无法保存/);
});

test('old personal products can increase quantity despite a legacy quoteExpired flag while real price, sale and pending guards remain', () => {
  const oldPersonal = { ...personal, quoteExpired: true };
  const h = fixture({ customerProducts: [oldPersonal], cart: { [personal.id]: 1 }, stamps: { [personal.id]: purchaseCartStampKey(personal) } });
  h.updateQuantity(personal.id, 2);
  assert.deepEqual(h.env.latestRef.current.cart, { [personal.id]: 2 });
  assert.equal(h.env.latestRef.current.cartIdentities[personal.id], purchaseCartStampKey(personal));
  h.recompute(); assert.equal(h.productCartQuantity(oldPersonal), 2);
  for (const blocked of [{ ...oldPersonal, onSale: false }, { ...oldPersonal, priceCents: undefined }]) {
    const invalid = fixture({ customerProducts: [blocked], cart: { [personal.id]: 1 }, stamps: { [personal.id]: purchaseCartStampKey(personal) } });
    invalid.updateQuantity(personal.id, 2);
    assert.deepEqual(invalid.env.latestRef.current.cart, { [personal.id]: 1 }); assert.deepEqual(invalid.changes.carts, []);
  }
  const payload = { items: [{ productId: personal.id, quantity: 1, version: 'original-version' }] };
  const pending = fixture({ customerProducts: [oldPersonal], cart: { [personal.id]: 1 }, submission: { status: 'pending', payload } });
  pending.updateQuantity(personal.id, 2);
  assert.deepEqual(pending.env.latestRef.current.cart, { [personal.id]: 1 }); assert.strictEqual(pending.env.submission.payload, payload);
  assert.deepEqual(pending.changes.carts, []);
});
