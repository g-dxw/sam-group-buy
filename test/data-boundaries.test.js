import test from 'node:test';
import assert from 'node:assert/strict';
import { priceCents } from '../server/feishu-repository.js';
import { completeGroup } from '../server/order-service.js';

test('empty Feishu prices cannot become a free product, while explicit zero remains valid', () => {
  for (const price of [null, undefined, '', '   ', false, [], NaN, Infinity, 'bad']) {
    assert.throws(() => priceCents(price), { code: 'CATALOG_PRICE_INVALID' });
  }
  assert.equal(priceCents(0), 0);
  assert.equal(priceCents('0'), 0);
  assert.equal(priceCents(69.9), 6990);
});

test('legacy submissions with mixed or invalid phone numbers cannot be imported as one customer', () => {
  const id = 'ab06a8c8-138a-4cbf-bf23-0fe3c3a7a8d4';
  const line = productId => ({ submissionId: id, productId, lineId: `${id}:${productId}`, phone: '13800000000',
    expectedLines: 2, syncStatus: '已确认', status: '待采购', quantity: 1 });
  const lines = [line('A'), line('B')];
  assert.equal(completeGroup(lines), true);
  lines[1].phone = '13900000000';
  assert.equal(completeGroup(lines), false);
  lines[0].phone = lines[1].phone = 'invalid';
  assert.equal(completeGroup(lines), false);
});
