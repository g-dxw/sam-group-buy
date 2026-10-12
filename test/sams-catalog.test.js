import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SamsCatalog } from '../server/sams-catalog.js';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';

const row = (overrides = {}) => ({ spuId: '123', title: 'Member’s Mark 澳洲肥牛卷 1.1kg', subTitle: '冷冻商品', storeId: '6505',
  priceInfo: [{ priceType: 2, price: '0' }, { priceType: 1, price: '11800' }], image: 'https://example.com/beef.jpg',
  images: ['https://example.com/beef.jpg'], isAvailable: true, isPutOnSale: true, ...overrides });
function fixture({ rows = [row()], now, hasProduct } = {}) {
  const calls = [];
  const catalog = new SamsCatalog({ now, hasProduct, fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const data = url.endsWith('allAddressList') ? { list: [{ cityCode: '440300', cityName: '深圳市', provinceName: '广东省', cityInitial: 'S' }] }
      : url.endsWith('getStoreListByCityCodePlus') ? [{ storeId: '6505', storeName: '深圳福田店', storeType: '2' }]
        : { dataList: rows, totalCount: rows.length, hasNextPage: false };
    return new Response(JSON.stringify({ code: 'Success', data }));
  } });
  return { catalog, calls };
}
const params = { keyword: '牛肉卷', storeId: '6505', storeType: '2', cityCode: '440300', page: '1' };
function testStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sams-catalog-test-'));
  const store = new LocalStore({ path: join(dir, 'orders.sqlite') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('query uses real city/store parameters and sales cents; selection retains source and stays draft', async t => {
  const { catalog, calls } = fixture();
  const result = await catalog.search(params);
  assert.deepEqual(calls.at(-1).body, { keyword: '牛肉卷', pageNum: 1, pageSize: 20, storeInfoVOList: [{ storeType: 2, storeId: '6505' }] });
  assert.equal(result.products[0].price_cents, 11800);
  assert.equal(result.products[0].spec, '1.1kg');
  const selected = catalog.resolveSelections({ selections: [{ selectionId: result.selectionId, spuIds: ['123'] }] });
  assert.equal(selected[0].source.cityName, '深圳市');
  assert.equal(selected[0].source.storeName, '深圳福田店');
  assert.equal(selected[0].source.queriedAt, result.queried_at);
  const store = testStore(t);
  const service = new LocalService({ store });
  assert.equal(service.selectProducts(selected).added, 1);
  assert.equal(service.listProducts().products[0].onSale, false);
  service.updateProduct('sam_123', { priceCents: 12500, onSale: true });
  assert.equal(service.selectProducts(selected).skipped, 1);
  assert.equal(store.getProduct('sam_123').priceCents, 12500);
  assert.equal(store.getProduct('sam_123').source.priceCents, 11800);
});

test('short cache preserves the query timestamp; selected snapshots expire even after a restart', async () => {
  let clock = Date.parse('2026-10-12T10:00:00Z');
  const { catalog, calls } = fixture({ now: () => clock, hasProduct: id => id === 'sam_123' });
  const first = await catalog.search(params); clock += 1000;
  const second = await catalog.search(params);
  assert.equal(calls.length, 3); assert.equal(second.cached, true);
  assert.equal(second.queried_at, first.queried_at); assert.equal(second.products[0].inCatalog, true);
  assert.notEqual(first.selectionId, second.selectionId);
  clock += 30 * 60_000;
  assert.throws(() => catalog.resolveSelections({ selections: [{ selectionId: first.selectionId, spuIds: ['123'] }] }), { code: 'SAMS_SELECTION_EXPIRED' });
  assert.throws(() => fixture().catalog.resolveSelections({ selections: [{ selectionId: second.selectionId, spuIds: ['123'] }] }), { code: 'SAMS_SELECTION_EXPIRED' });
});

test('selection resolves server data, deduplicates and rejects unknown or incomplete products atomically', async () => {
  const { catalog } = fixture({ rows: [row(), row({ spuId: '124', priceInfo: [{ priceType: 2, price: '0' }] })] });
  const result = await catalog.search(params);
  const group = { selectionId: result.selectionId, spuIds: ['123', '123'], priceCents: 1 };
  const selected = catalog.resolveSelections({ selections: [group] });
  assert.equal(selected.length, 1); assert.equal(selected[0].priceCents, 11800);
  assert.equal(result.products[1].price_cents, null); assert.equal(result.products[1].selectable, false);
  for (const ids of [['123', '124'], ['123', 'unknown']]) {
    assert.throws(() => catalog.resolveSelections({ selections: [{ ...group, spuIds: ids }] }), { code: 'INVALID_SAMS_SELECTION' });
  }
  assert.throws(() => catalog.resolveSelections({ selections: [{ ...group, spuIds: Array(201).fill('123') }] }), { code: 'INVALID_SAMS_SELECTION' });
});

test('invalid store provenance, duplicate IDs and malformed results cannot be offered for selection', async () => {
  for (const rows of [[row({ storeId: '6513' })], [row({ storeType: 4 })], [row(), row()], [row({ spuId: '../foo' })]]) {
    await assert.rejects(fixture({ rows }).catalog.search(params), { code: 'SAMS_UNAVAILABLE' });
  }
  await assert.rejects(fixture().catalog.search({ ...params, storeId: '6513' }), { code: 'INVALID_SAMS_STORE' });
  for (const overrides of [{ keyword: '' }, { keyword: 'a'.repeat(81) }, { page: '0' }, { page: '101' }, { storeId: 'x' }, { storeType: '3' }]) {
    await assert.rejects(fixture().catalog.search({ ...params, ...overrides }), { code: 'INVALID_SAMS_QUERY' });
  }
});

test('unknown booleans and unsafe images are not silently trusted; unsupported prices are not zero', async () => {
  const { catalog } = fixture({ rows: [row({ isAvailable: 'true', isPutOnSale: 1, image: 'javascript:alert(1)', priceInfo: [{ priceType: 4, price: '123' }] })] });
  const result = await catalog.search(params);
  assert.equal(result.products[0].available, null); assert.equal(result.products[0].on_sale, null);
  assert.equal(result.products[0].image_url, null); assert.equal(result.products[0].price_cents, null);
  assert.equal(result.products[0].selectable, false);
  const odd = await fixture({ rows: [row({ image: 'http:example.com/image.jpg', priceInfo: [{ priceType: true, price: '1' }] })] }).catalog.search(params);
  assert.equal(odd.products[0].image_url, null); assert.equal(odd.products[0].price_cents, null);
});

test('upstream failures do not cache a partial response, and concurrent identical queries share one request', async () => {
  let calls = 0;
  const catalog = new SamsCatalog({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response('unavailable', { status: 429 });
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ code: 'Success', data: { list: [{ cityCode: '440300', cityName: '深圳市' }] } }));
  } });
  await assert.rejects(catalog.cities(), { status: 503 });
  const results = await Promise.all([catalog.cities(), catalog.cities()]);
  assert.equal(calls, 2); assert.equal(results[0].cities.length, 1);
});

const entryRank = '3317885016381467926';
const beefRank = '1135172272143911958';
const proteinCategory = '283381372025991';
const secondCategory = '900002';
const rankParams = { storeId: '6505', storeType: '2', cityCode: '440300', rankId: entryRank, page: '1' };
function rankFixture({ now, rows = [row()], end = false, detailData, goodsData, storeScoped = false } = {}) {
  const calls = [];
  const catalog = new SamsCatalog({ now, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers });
    let data;
    if (url.endsWith('allAddressList')) data = { list: [{ cityCode: '440300', cityName: '深圳市' }] };
    else if (url.endsWith('getStoreListByCityCodePlus')) data = [{ storeId: '6505', storeName: '深圳福田店', storeType: '2' },
      { storeId: '6506', storeName: '测试另一门店', storeType: '2' }];
    else if (url.endsWith('homeRankDetailForVisitor')) data = detailData ? detailData(body) : {
      contentDetailId: body.contentDetailId, titleName: body.contentDetailId === entryRank ? '蛋白质热销榜' : '牛肉热销榜',
      contentData: { dataList: [{ categoryId: proteinCategory, categoryTitle: '精选蛋白质',
        relationRank: storeScoped && body.storeInfoList[0].storeId === '6506' ? [] : [{ contentDetailId: beefRank, titleName: '牛肉热销榜' }] },
      { categoryId: secondCategory, categoryTitle: '另一官方榜单标签' }] },
    };
    else if (url.endsWith('queryGoodsInfoPage')) data = goodsData ? goodsData(body) : { pageNum: 0,
      contentDetailId: body.contentDetailId, categoryId: body.categoryId, goodsInfoList: rows, end };
    else throw new Error(`Unexpected rank endpoint ${url}`);
    return new Response(JSON.stringify({ code: 'Success', data }));
  } });
  return { catalog, calls };
}

const chickenRank = '1135163452713790486';
const chickenCategory = '588490840382989';
// Public store 6505 chicken-rank detail: both title fields are actually empty.
// Product-page rows below reuse the existing field fixture; they are not a
// claim about which products appear in the live chicken rank.
const publicChickenDetail = {
  contentDetailId: chickenRank, titleName: '鸡肉热销榜', contentData: { dataList: [{
    categoryId: chickenCategory, categoryTitle: '', categoryTitleEn: '', dataType: 1,
    rankingConfigType: 2, goodDisplayCount: '30', isDistinct: true,
  }] },
};
function chickenFixture({ chickenDetail = publicChickenDetail, ...options } = {}) {
  return rankFixture({ ...options, detailData: body => body.contentDetailId === entryRank ? {
    contentDetailId: entryRank, titleName: '蛋白质热销榜', contentData: { dataList: [{
      categoryId: proteinCategory, categoryTitle: '精选蛋白质',
      relationRank: [{ contentDetailId: chickenRank, titleName: '鸡肉热销榜' }],
    }] },
  } : structuredClone(chickenDetail) });
}

test('public chicken-rank blank titles remain browsable using the real category ID and retain source names', async t => {
  const { catalog, calls } = chickenFixture();
  const request = { ...rankParams, rankId: chickenRank };
  const implicit = await catalog.browse(request);
  assert.deepEqual(implicit.rank, { rank_id: chickenRank, name: '鸡肉热销榜' });
  assert.equal(implicit.categories.length, 1);
  assert.deepEqual(implicit.category, { category_id: chickenCategory, name: '鸡肉热销榜',
    name_source: 'rank_title', original_title: '' });
  assert.equal(implicit.products[0].price_cents, 11800);
  assert.equal(calls.at(-1).body.categoryId, chickenCategory);
  assert.equal(calls.at(-1).body.contentDetailId, chickenRank);
  assert.deepEqual(calls.at(-1).body.storeInfoList, [{ storeType: 2, storeId: '6505' }]);
  const explicit = await catalog.browse({ ...request, categoryId: chickenCategory,
    categoryName: '客户端伪造标题', rankName: '客户端伪造榜单' });
  assert.deepEqual(explicit.category, implicit.category);
  assert.equal(explicit.products[0].spu_id, '123');
  const selected = catalog.resolveSelections({ selections: [{ selectionId: explicit.selectionId, spuIds: ['123'] }] });
  assert.equal(selected[0].source.rankId, chickenRank);
  assert.equal(selected[0].source.rankName, '鸡肉热销榜');
  assert.equal(selected[0].source.rankCategoryId, chickenCategory);
  assert.equal(selected[0].source.rankCategoryName, '鸡肉热销榜');
  assert.equal(selected[0].source.rankCategoryNameSource, 'rank_title');
  assert.equal(selected[0].source.rankCategoryOriginalTitle, '');
  assert.equal(selected[0].category, '其他');
  assert.equal(selected[0].source.keyword, '');
  assert.equal(selected[0].source.method, 'rank');
  assert.notEqual(selected[0].source.rankCategoryName, '客户端伪造标题');
  const store = testStore(t);
  const service = new LocalService({ store });
  assert.equal(service.selectProducts(selected).added, 1);
  assert.deepEqual(store.getProduct('sam_123').source, selected[0].source);
});

test('public blank category titles do not permit unknown IDs, mismatched stores or unsupported sale prices', async () => {
  const { catalog, calls } = chickenFixture();
  const request = { ...rankParams, rankId: chickenRank };
  await assert.rejects(catalog.browse({ ...request, categoryId: '588490840382990' }), { code: 'INVALID_SAMS_CATEGORY' });
  assert.ok(!calls.some(call => call.url.endsWith('queryGoodsInfoPage')));
  const beforeInvalidId = calls.length;
  await assert.rejects(catalog.browse({ ...request, categoryId: '../invalid' }), { code: 'INVALID_SAMS_QUERY' });
  assert.equal(calls.length, beforeInvalidId);
  // Mutations of the verified fixture exercise retained validation; the live
  // failure itself was an empty title, not duplicate or malformed IDs.
  const label = publicChickenDetail.contentData.dataList[0];
  for (const labels of [[{ ...label, categoryId: 'bad' }], [{ ...label, categoryTitle: null }],
    [{ ...label, categoryTitle: 1 }], [{ ...label, categoryTitle: undefined }], [label, label]]) {
    const invalid = chickenFixture({ chickenDetail: { ...publicChickenDetail, contentData: { dataList: labels } } });
    await assert.rejects(invalid.catalog.browse(request), { code: 'SAMS_UNAVAILABLE' });
    assert.ok(!invalid.calls.some(call => call.url.endsWith('queryGoodsInfoPage')));
  }
  const noRankName = chickenFixture({ chickenDetail: { ...publicChickenDetail, titleName: '' } });
  await assert.rejects(noRankName.catalog.browse(request), { code: 'SAMS_UNAVAILABLE' });
  const crossStore = chickenFixture({ rows: [row({ storeId: '6506' })] });
  await assert.rejects(crossStore.catalog.browse(request), { code: 'SAMS_UNAVAILABLE' });
  const noSalePrice = chickenFixture({ rows: [row(), row({ spuId: '124', priceInfo: [{ priceType: 2, price: '0' }] })] });
  const result = await noSalePrice.catalog.browse(request);
  assert.equal(result.products[1].price_cents, null);
  assert.equal(result.products[1].selectable, false);
  assert.throws(() => noSalePrice.catalog.resolveSelections({ selections: [{ selectionId: result.selectionId,
    spuIds: ['123', '124'] }] }), { code: 'INVALID_SAMS_SELECTION' });
});

test('official entry builds trusted ranks; browsing without a keyword uses exact official body and rank selection source', async t => {
  const { catalog, calls } = rankFixture();
  const listing = await catalog.ranks(rankParams);
  assert.deepEqual(listing.ranks, [{ rank_id: entryRank, name: '蛋白质热销榜' }, { rank_id: beefRank, name: '牛肉热销榜' }]);
  assert.equal(listing.store.name, '深圳福田店');
  assert.deepEqual(calls.at(-1).body, { contentDetailId: entryRank, storeInfoList: [{ storeType: 2, storeId: '6505' }] });
  const result = await catalog.browse({ ...rankParams, rankName: '客户端假标题', categoryName: '客户端假分类' });
  assert.equal(result.mode, 'rank'); assert.equal(result.query, ''); assert.equal(result.total, null);
  assert.equal(result.page_size, 30); assert.equal(result.has_more, true);
  assert.deepEqual(result.rank, { rank_id: entryRank, name: '蛋白质热销榜' });
  assert.deepEqual(result.category, { category_id: proteinCategory, name: '精选蛋白质' });
  assert.equal(result.categories.length, 2);
  assert.deepEqual(calls.at(-1).body, { categoryId: proteinCategory, contentDetailId: entryRank, pageNum: 1, pageSize: 30,
    storeInfoList: [{ storeType: 2, storeId: '6505' }], excludeSpuIds: [], isVisitorRequest: true });
  assert.equal(calls.at(-1).headers.latitude, '0'); assert.equal(calls.at(-1).headers.longitude, '0');
  assert.equal(calls.at(-1).headers['auth-token'], undefined);
  assert.equal(result.products[0].price_cents, 11800); assert.equal(result.products[0].image_url, 'https://example.com/beef.jpg');
  const selected = catalog.resolveSelections({ selections: [{ selectionId: result.selectionId, spuIds: ['123'],
    source: { rankName: '注入来源' }, priceCents: 1 }] });
  assert.equal(selected[0].category, '其他');
  assert.equal(selected[0].source.method, 'rank'); assert.equal(selected[0].source.keyword, '');
  assert.equal(selected[0].source.rankId, entryRank); assert.equal(selected[0].source.rankName, '蛋白质热销榜');
  assert.equal(selected[0].source.rankCategoryId, proteinCategory); assert.equal(selected[0].source.rankCategoryName, '精选蛋白质');
  const store = testStore(t); const service = new LocalService({ store });
  assert.equal(service.selectProducts(selected).added, 1);
  assert.deepEqual(store.getProduct('sam_123').source, selected[0].source);
  assert.equal(service.selectProducts(selected).skipped, 1);
});

test('explicit official tag and page preserve exclusion IDs and stop on end, empty pages, and page 100', async () => {
  const { catalog, calls } = rankFixture({ goodsData: body => ({ pageNum: body.pageNum, categoryId: body.categoryId,
    contentDetailId: body.contentDetailId, goodsInfoList: body.pageNum === 2 ? [row()] : [], end: body.pageNum === 2 }) });
  const second = await catalog.browse({ ...rankParams, categoryId: secondCategory, page: 2, excludeSpuIds: ['111', '222', '111'] });
  assert.equal(second.has_more, false); assert.equal(second.page, 2);
  assert.equal(second.category.category_id, secondCategory);
  assert.deepEqual(calls.at(-1).body.excludeSpuIds, ['111', '222']);
  const empty = await catalog.browse({ ...rankParams, page: 3, excludeSpuIds: '111,222' });
  assert.equal(empty.products.length, 0); assert.equal(empty.has_more, false);
  await catalog.browse({ ...rankParams, page: 4, excludeSpuIds: '["111","222"]' });
  assert.deepEqual(calls.at(-1).body.excludeSpuIds, ['111', '222']);
  assert.equal((await rankFixture().catalog.browse({ ...rankParams, page: 100 })).has_more, false);
});

test('official default response pageNum 0 preserves the requested page and does not reject valid products', async () => {
  const { catalog, calls } = rankFixture();
  const first = await catalog.browse(rankParams);
  assert.equal(first.page, 1); assert.equal(first.products.length, 1); assert.equal(first.has_more, true);
  const second = await catalog.browse({ ...rankParams, page: 2, excludeSpuIds: ['123'] });
  assert.equal(second.page, 2); assert.equal(second.products[0].price_cents, 11800);
  assert.equal(calls.at(-1).body.pageNum, 2);
  assert.deepEqual(calls.at(-1).body.excludeSpuIds, ['123']);
});

test('unknown ranks or tags never reach product API; invalid store and pagination never broaden access', async () => {
  const { catalog, calls } = rankFixture();
  await assert.rejects(catalog.browse({ ...rankParams, rankId: '999999999999' }), { code: 'INVALID_SAMS_RANK' });
  assert.ok(!calls.some(call => call.url.endsWith('queryGoodsInfoPage') || call.body.contentDetailId === '999999999999'));
  await assert.rejects(catalog.browse({ ...rankParams, categoryId: '8888888' }), { code: 'INVALID_SAMS_CATEGORY' });
  assert.ok(!calls.some(call => call.url.endsWith('queryGoodsInfoPage')));
  await assert.rejects(catalog.ranks({ ...rankParams, storeId: '9999' }), { code: 'INVALID_SAMS_STORE' });
  for (const patch of [{ page: 0 }, { page: 101 }, { page: 1.1 }, { categoryId: '../x' }, { rankId: 'x' },
    { excludeSpuIds: Array(2001).fill('123') }, { excludeSpuIds: '[123]' }, { excludeSpuIds: '{bad' }, { excludeSpuIds: '123,,124' }]) {
    const { catalog: isolated, calls: attempted } = rankFixture();
    await assert.rejects(isolated.browse({ ...rankParams, ...patch }), { code: 'INVALID_SAMS_QUERY' });
    assert.equal(attempted.length, 0);
  }
  await assert.rejects(catalog.browse(null), { code: 'INVALID_SAMS_QUERY' });
});

test('trusted ranks are bound to store and expire with their TTL; browsing cached pages creates fresh snapshot IDs', async () => {
  let clock = Date.parse('2026-10-12T10:00:00Z');
  const { catalog, calls } = rankFixture({ now: () => clock, storeScoped: true });
  const first = await catalog.browse(rankParams);
  clock += 1000;
  const cached = await catalog.browse(rankParams);
  assert.equal(cached.cached, true); assert.equal(cached.queried_at, first.queried_at);
  assert.notEqual(cached.selectionId, first.selectionId);
  assert.equal(calls.filter(call => call.url.endsWith('homeRankDetailForVisitor')).length, 1);
  await assert.rejects(catalog.browse({ ...rankParams, storeId: '6506', rankId: beefRank }), { code: 'INVALID_SAMS_RANK' });
  assert.equal(calls.filter(call => call.body.contentDetailId === beefRank).length, 0);
  clock += 3600_001;
  await catalog.ranks(rankParams);
  assert.equal(calls.filter(call => call.url.endsWith('homeRankDetailForVisitor') && call.body.storeInfoList[0].storeId === '6505').length, 2);
  assert.throws(() => catalog.resolveSelections({ selections: [{ selectionId: first.selectionId, spuIds: ['123'] }] }), { code: 'SAMS_SELECTION_EXPIRED' });
});

test('malformed rank metadata, mismatched store/page/tag, and incomplete products cannot become trusted selections', async () => {
  const malformed = rankFixture({ detailData: body => ({ contentDetailId: body.contentDetailId, titleName: '榜单',
    contentData: { dataList: [{ categoryId: 'bad', categoryTitle: '伪标签' }] } }) });
  await assert.rejects(malformed.catalog.ranks(rankParams), { code: 'SAMS_UNAVAILABLE' });
  for (const patch of [{ pageNum: 2 }, { categoryId: 'other' }, { contentDetailId: 'other' }, { end: 'false' },
    { goodsInfoList: [row({ storeId: '6506' })] }, { goodsInfoList: Array(31).fill(row()) }, { goodsInfoList: [row(), row()] }]) {
    const invalid = rankFixture({ goodsData: body => ({ pageNum: body.pageNum, categoryId: body.categoryId, contentDetailId: body.contentDetailId,
      end: false, goodsInfoList: [row()], ...patch }) });
    await assert.rejects(invalid.catalog.browse(rankParams), { code: 'SAMS_UNAVAILABLE' });
  }
  const { catalog } = rankFixture({ rows: [row(), row({ spuId: '124', priceInfo: [{ priceType: 2, price: '0' }] })] });
  const result = await catalog.browse(rankParams);
  assert.equal(result.products[1].price_cents, null); assert.equal(result.products[1].selectable, false);
  assert.throws(() => catalog.resolveSelections({ selections: [{ selectionId: result.selectionId, spuIds: ['123', '124'] }] }), { code: 'INVALID_SAMS_SELECTION' });
});
