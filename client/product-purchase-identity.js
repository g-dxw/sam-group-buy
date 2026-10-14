export const MAX_PURCHASE_QUANTITY = 999;

/** Only the public, server-confirmed purchase identity can link different IDs. */
export function purchaseIdentityKey(product) {
  const identity = product?.purchaseIdentity;
  if (!identity || identity.platform !== 'samsclub_cn'
    || ![2, 4, 8, 256].includes(identity.storeType)
    || typeof identity.storeId !== 'string' || !/^\d{1,12}$/.test(identity.storeId)
    || typeof identity.spuId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(identity.spuId)
    || !['whole', 'portion'].includes(identity.kind)
    || identity.kind === 'whole' && product.split) return null;
  return JSON.stringify([identity.platform, identity.storeType, identity.storeId, identity.spuId, identity.kind]);
}

export function sameWholePurchase(left, right) {
  if (left?.purchaseIdentity?.kind !== 'whole' || right?.purchaseIdentity?.kind !== 'whole') return false;
  const key = purchaseIdentityKey(left);
  return key !== null && key === purchaseIdentityKey(right);
}

/** Form stamps protect a single local ID; they never prove cross-ID equality. */
export function purchaseCartStampKey(product) {
  const key = purchaseIdentityKey(product);
  if (key !== null) return key;
  if (typeof product?.id !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u.test(product.id)) return null;
  return JSON.stringify(['local', product.id, product.split ? 'portion' : 'whole']);
}

export function indexFeaturedWholeProducts(products) {
  const index = new Map();
  for (const product of products) {
    if (!product?.id || product.purchaseIdentity?.kind !== 'whole') continue;
    const key = purchaseIdentityKey(product);
    if (key !== null && !index.has(key)) index.set(key, product);
  }
  return index;
}

export function canonicalWholeProduct(product, index) {
  if (product?.purchaseIdentity?.kind !== 'whole') return product;
  const key = purchaseIdentityKey(product);
  return key === null ? product : index.get(key) || product;
}

/** Preserve quantities while moving only known, unsplit aliases to a featured ID. */
export function normalizePurchaseCart(cart, featuredProducts, customerProducts, purchaseStamps = {}) {
  const known = new Map([...customerProducts, ...featuredProducts].map(product => [product.id, product]));
  const featured = indexFeaturedWholeProducts(featuredProducts);
  const conflicts = [];
  for (const product of customerProducts) {
    const previousId = product.previousProductId;
    if (!previousId || !(Number.isSafeInteger(cart[previousId]) && cart[previousId] > 0)) continue;
    const previous = known.get(previousId);
    if (!previous?.split && previous?.purchaseIdentity?.kind !== 'portion') continue;
    const stamp = purchaseStamps[previousId];
    const wholeKey = product.purchaseIdentity?.kind === 'whole' ? purchaseCartStampKey(product) : null;
    const portionKey = purchaseCartStampKey(previous);
    if (portionKey !== null && stamp === portionKey) continue;
    if (wholeKey !== null && stamp === wholeKey) known.set(previousId, product);
    else conflicts.push({ id: previousId, product });
  }
  const conflicted = new Set(conflicts.map(entry => entry.id));
  for (const [id, quantity] of Object.entries(cart)) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || conflicted.has(id)) continue;
    const product = known.get(id);
    if (!product) continue;
    const key = purchaseCartStampKey(product);
    const stamp = purchaseStamps[id];
    const stamped = typeof stamp === 'string' && stamp.length > 0;
    // Catalogue IDs can retain their spelling while changing from packs to
    // portions (or back). Their saved quantity must not inherit the new unit.
    if (stamped && stamp !== key || key !== null && (product.split || product.purchaseIdentity?.kind === 'portion') && !stamped) {
      conflicts.push({ id, product });
      conflicted.add(id);
    }
  }
  const groups = new Map();
  for (const [id, quantity] of Object.entries(cart)) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || conflicted.has(id)) continue;
    const canonical = canonicalWholeProduct(known.get(id), featured);
    const target = canonical?.id || id;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push({ id, quantity });
  }
  const next = { ...cart };
  const stamps = { ...purchaseStamps };
  const moved = [];
  for (const [target, entries] of groups) {
    if (conflicted.has(target)) continue;
    const aliases = entries.filter(entry => entry.id !== target);
    if (!aliases.length) continue;
    // An invalid target or an unsafe sum cannot be replaced without losing data.
    if (cart[target] !== undefined && (!Number.isSafeInteger(cart[target]) || cart[target] <= 0)) continue;
    const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    if (!Number.isSafeInteger(total)) continue;
    for (const entry of aliases) {
      delete next[entry.id];
      delete stamps[entry.id];
      moved.push({ from: entry.id, to: target, quantity: entry.quantity });
    }
    next[target] = total;
    const key = purchaseCartStampKey(known.get(target) || canonicalWholeProduct(known.get(entries[0].id), featured));
    if (key !== null) stamps[target] = key;
  }
  const changed = moved.length > 0;
  return { cart: changed ? next : cart, stamps: changed ? stamps : purchaseStamps, changed, moved, conflicts,
    overLimit: Object.entries(next).filter(([, quantity]) => Number.isSafeInteger(quantity) && quantity > MAX_PURCHASE_QUANTITY).map(([id]) => id) };
}
