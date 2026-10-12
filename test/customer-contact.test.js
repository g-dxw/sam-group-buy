import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMER_CONTACT_KEY, clearCustomerContact, initialCustomerForm,
  readCustomerContact, saveCustomerContact,
} from '../client/customer-contact.js';

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
    entries,
  };
}

const contact = { version: 1, name: '西科小雪', phone: '13800138000', savedAt: 1000 };

test('successful-order contact is normalized and stores no notes or order identity', () => {
  for (const phone of ['+86 (138) 0013-8000', '0086 13800138000', '8613800138000', '13800138000']) {
    const storage = memoryStorage();
    assert.deepEqual(saveCustomerContact(storage, {
      name: '  西科小雪  ', phone, note: '不要沿用的备注', submissionId: 'order-one', customerToken: 'private-token',
    }, 1000), contact);
    assert.deepEqual(JSON.parse(storage.getItem(CUSTOMER_CONTACT_KEY)), contact);
    assert.deepEqual(readCustomerContact(storage), contact);
  }
});

test('Chinese and Unicode nicknames are preserved within the existing 40-character limit', () => {
  const storage = memoryStorage();
  const name = '小雪 ❄️ / 王同学';
  assert.equal(saveCustomerContact(storage, { name, phone: contact.phone }, 2000).name, name);
  assert.equal(saveCustomerContact(storage, { name: '雪'.repeat(40), phone: contact.phone }, 2001).name.length, 40);
  assert.equal(saveCustomerContact(storage, { name: '雪'.repeat(41), phone: contact.phone }, 2002), null);
  assert.equal(readCustomerContact(storage).savedAt, 2001);
});

test('a remembered contact prefills any new batch without carrying a previous note', () => {
  assert.deepEqual(initialCustomerForm(null, contact), { name: '西科小雪', phone: '13800138000', note: '' });
  assert.deepEqual(initialCustomerForm({ status: 'pending' }, contact), { name: '西科小雪', phone: '13800138000', note: '' });
  assert.deepEqual(initialCustomerForm(null, null), { name: '', phone: '', note: '' });
});

test('an interrupted order restores its exact original fields without mixing identities', () => {
  const payload = { name: ' 王同学 ', phone: '+86 13900139000', note: '这笔订单的备注', submissionId: 'original-id' };
  assert.deepEqual(initialCustomerForm({ payload }, contact), {
    name: payload.name, phone: payload.phone, note: payload.note,
  });
  assert.deepEqual(initialCustomerForm({ payload: { phone: '13900139000' } }, contact), {
    name: '', phone: '13900139000', note: '',
  });
  assert.deepEqual(initialCustomerForm({ payload: {} }, contact), { name: '', phone: '', note: '' });
  assert.equal(payload.name, ' 王同学 ', 'the pending submission itself is untouched');
});

test('a late completion cannot replace a newer contact remembered by another tab', () => {
  const storage = memoryStorage();
  const newer = saveCustomerContact(storage, { name: '新联系人', phone: '13900139000' }, 3000);
  assert.deepEqual(saveCustomerContact(storage, contact, 1000), newer);
  assert.deepEqual(readCustomerContact(storage), newer);
  const latest = saveCustomerContact(storage, { name: '修改后的昵称', phone: '13700137000' }, 4000);
  assert.deepEqual(readCustomerContact(storage), latest);
});

test('missing, damaged and unsupported records are ignored without throwing', () => {
  const invalidRecords = [null, '', '{', 'null', 'false', '[]', '"nickname"',
    JSON.stringify({ ...contact, version: 2 }), JSON.stringify({ ...contact, savedAt: '1000' }),
    JSON.stringify({ ...contact, savedAt: 0 }), JSON.stringify({ ...contact, savedAt: -1 }),
    JSON.stringify({ ...contact, savedAt: 1.5 }), JSON.stringify({ ...contact, name: '' }),
    JSON.stringify({ ...contact, phone: '12800138000' }), JSON.stringify({ ...contact, phone: 13800138000 }),
  ];
  for (const value of invalidRecords) {
    assert.equal(readCustomerContact(memoryStorage(value === null ? {} : { [CUSTOMER_CONTACT_KEY]: value })), null, value);
  }
});

test('invalid save attempts leave the previous contact intact', () => {
  const storage = memoryStorage({ [CUSTOMER_CONTACT_KEY]: JSON.stringify(contact) });
  const invalidAttempts = [[null, 2000], [{ ...contact, name: '  ' }, 2000],
    [{ ...contact, phone: '1380013800' }, 2000], [{ ...contact, phone: '+1 13800138000' }, 2000],
    [{ ...contact, name: 123 }, 2000], [contact, NaN], [contact, Infinity], [contact, '2000'],
    [contact, 0], [contact, -1], [contact, 1.5], [contact, Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [payload, submittedAt] of invalidAttempts) {
    assert.equal(saveCustomerContact(storage, payload, submittedAt), null);
    assert.deepEqual(readCustomerContact(storage), contact);
  }
});

test('storage errors degrade gracefully and do not make callers throw', () => {
  const denied = {
    getItem() { throw new Error('Blocked storage'); },
    setItem() { throw new Error('Blocked storage'); },
    removeItem() { throw new Error('Blocked storage'); },
  };
  for (const storage of [undefined, null, denied]) {
    assert.equal(readCustomerContact(storage), null);
    assert.equal(saveCustomerContact(storage, contact, 2000), null);
    assert.equal(clearCustomerContact(storage), false);
  }
  const quotaExceeded = memoryStorage({ [CUSTOMER_CONTACT_KEY]: JSON.stringify(contact) });
  quotaExceeded.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(saveCustomerContact(quotaExceeded, { name: '新联系人', phone: '13900139000' }, 2000), null);
  assert.deepEqual(readCustomerContact(quotaExceeded), contact);
});

test('clearing only removes remembered contact and preserves carts and pending recovery', () => {
  const storage = memoryStorage({
    [CUSTOMER_CONTACT_KEY]: JSON.stringify(contact),
    'sam-cart:batch-one': '{"milk":1}',
    'sam-pending:batch-one': '{"submissionId":"keep"}',
    'sam-customer:batch-one': 'keep-token',
  });
  assert.equal(clearCustomerContact(storage), true);
  assert.equal(readCustomerContact(storage), null);
  assert.equal(clearCustomerContact(storage), true, 'clearing is idempotent');
  assert.deepEqual(Object.fromEntries(storage.entries), {
    'sam-cart:batch-one': '{"milk":1}',
    'sam-pending:batch-one': '{"submissionId":"keep"}',
    'sam-customer:batch-one': 'keep-token',
  });
});
