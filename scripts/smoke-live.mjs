// Explicitly scoped to the two demo submissions used in acceptance.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { getBatch } from '../server/config.js';
import { FeishuRepository } from '../server/feishu-repository.js';
import { lark, readRecords } from '../server/lark.js';

const { values } = parseArgs({ options: { first: { type: 'string' }, second: { type: 'string' } } });
if (!values.first || !values.second) throw new Error('请显式提供 --first 和 --second 演示提交编号；本脚本会改动并最终取消这两笔演示订单。');
const batch = await getBatch('demo-20261012');
const repository = new FeishuRepository();
const endpoint = `http://127.0.0.1:3001/api/batches/${batch.code}`;
const evidence = [];
const record = (name, result) => { evidence.push({ name, result, at: new Date().toISOString() }); console.log(`${name}: PASS`); };
async function api(path, body) {
  const response = await fetch(`${endpoint}/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: response.status, data: await response.json() };
}
const query = async () => (await api('query', { phone: '13800000000' })).data;
async function eventually(read, accept) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error('飞书更新在核查窗口内尚未可见。');
}
const update = (tableId, changes) => lark(['base', '+record-batch-update', '--base-token', batch.baseToken, '--table-id', tableId, '--json', JSON.stringify({ update_records: changes })], { write: true });
const initial = (await api('catalog')).data;
const product = initial.products.find(item => item.id === 'DEMO-001');
const source = (await repository.readProducts(batch)).find(item => item.id === product.id);
const settings = (await readRecords(batch.baseToken, batch.settingsTableId, ['收集中']))[0];
const lines = (await repository.readOrderLines(batch, { phone: '13800000000' })).filter(line => [values.first, values.second].includes(line.submissionId));
assert.equal(lines.length, 2);
assert(lines.every(line => line.productId === 'DEMO-001' && line.name === '验收测试' && line.syncStatus === '已确认'));
const first = lines.find(line => line.submissionId === values.first);
const second = lines.find(line => line.submissionId === values.second);
assert.equal(first.quantity, 2);
assert.equal(second.quantity, 1);
try {
  await update(batch.orderTableId, { [first.recordId]: { 数量: 2, 处理状态: ['待采购'] }, [second.recordId]: { 数量: 1, 处理状态: ['待采购'] } });
  let result = await eventually(query, result => result.products[0]?.quantity === 3 && result.totalCents === product.priceCents * 3);
  assert.equal(result.products[0].quantity, 3);
  assert.equal(result.totalCents, product.priceCents * 3);
  record('真实首次2箱+补单1箱', result);
  const payload = { submissionId: values.first, name: '验收测试', phone: '13800000000', note: '本地验收演示，无需采购', items: [{ productId: product.id, quantity: 2, version: product.version }] };
  const repeated = await api('orders', payload);
  assert.equal(repeated.data.status, 'completed');
  assert.equal((await repository.readOrderLines(batch, { phone: '13800000000' })).length, 2);
  record('已完成UUID重复提交不新增', repeated);
  await update(batch.orderTableId, { [first.recordId]: { 数量: 4, 处理状态: ['已买到'] } });
  result = await eventually(query, result => result.products[0]?.quantity === 5);
  assert.equal(result.products[0].quantity, 5);
  assert(result.products[0].statuses.some(item => item.status === '已买到' && item.quantity === 4));
  record('管理员改数量和采购状态同步', result);
  await api('orders', payload);
  assert.equal((await repository.readOrderLines(batch, { submissionId: first.submissionId }))[0].quantity, 4);
  record('已完成重试保留管理员修改', { quantity: 4 });
  await update(batch.orderTableId, { [second.recordId]: { 处理状态: ['已取消'] } });
  result = await eventually(query, result => result.totalCents === product.priceCents * 4);
  assert.equal(result.totalCents, product.priceCents * 4);
  assert(result.products[0].statuses.some(item => item.status === '已取消' && item.quantity === 1));
  record('取消数量展示但金额排除', result);
  await update(batch.productTableId, { [source.recordId]: { 单价: (product.priceCents + 100) / 100 } });
  result = await eventually(query, result => result.totalCents === (product.priceCents + 100) * 4);
  assert.equal(result.totalCents, (product.priceCents + 100) * 4);
  record('商品改价影响已有订单当前金额', result);
  const stale = await api('orders', { ...payload, submissionId: randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'PRODUCT_CHANGED');
  record('旧价格提交要求重新确认', { status: stale.status, code: stale.data.error.code });
  await update(batch.productTableId, { [source.recordId]: { 在售: false } });
  await eventually(() => api('catalog'), result => result.data.products.find(item => item.id === product.id)?.onSale === false);
  assert.equal((await query()).products[0].name, product.name);
  record('停售保留已有订单展示', { displayed: true });
  await update(batch.settingsTableId, { [settings.record_id]: { 收集中: false } });
  await eventually(() => api('catalog'), result => result.data.batch.collecting === false);
  const closed = await api('orders', { ...payload, submissionId: randomUUID() });
  assert.equal(closed.data.error.code, 'COLLECTION_CLOSED');
  assert.equal((await api('query', { phone: '13800000000' })).status, 200);
  record('关闭收集拒绝新单但可查询', { status: closed.status, query: 200 });
} finally {
  await update(batch.productTableId, { [source.recordId]: { 单价: product.priceCents / 100, 在售: source.onSale } });
  await update(batch.settingsTableId, { [settings.record_id]: { 收集中: settings.fields['收集中'] === true } });
  await update(batch.orderTableId, { [first.recordId]: { 数量: 2, 处理状态: ['已取消'] }, [second.recordId]: { 数量: 1, 处理状态: ['已取消'] } });
  const final = await eventually(query, result => result.totalCents === 0);
  assert.equal(final.totalCents, 0);
  record('恢复演示商品设置并取消验收订单', final);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/live-acceptance.json', JSON.stringify(evidence, null, 2));
}
