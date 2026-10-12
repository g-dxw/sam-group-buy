// Local browser acceptance fixture: 60 products and the real order service,
// without connecting to or writing any Feishu resource. Not a deployment entry.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { OrderService } from '../server/order-service.js';
import { Journal } from '../server/journal.js';

const rows = new Map();
let serial = 0;
let failFirstPost = true;
const products = Array.from({ length: 60 }, (_, index) => ({
  id: `FIXTURE-${String(index + 1).padStart(3, '0')}`,
  name: `测试商品 ${String(index + 1).padStart(2, '0')} · ${['纯牛奶', '鲜鸡蛋', '黄油可颂', '抽纸'][index % 4]}`,
  spec: '固定规格 · 测试用', unit: '箱', priceCents: 6990 + index * 100,
  category: ['乳品饮料', '生鲜冷藏', '烘焙点心', '日用家庭'][index % 4],
  onSale: true, sort: index,
}));
const repository = {
  async readProducts() { return products; },
  async readSettings() { return { title: '60 种商品 · 浏览器验收', description: '隔离测试数据，不会写入飞书。首次提交模拟请求未到达，验证原编号恢复。', collecting: true, contactNote: '这是本地测试环境。' }; },
  async readOrderLines(batch, { phone, submissionId } = {}) {
    return (rows.get(batch.code) || []).filter(line => (!phone || line.phone === phone) && (!submissionId || line.submissionId === submissionId));
  },
  async createOrderLines(batch, lines) {
    const created = lines.map(line => ({ ...line, recordId: `fixture-record-${++serial}` }));
    rows.set(batch.code, [...(rows.get(batch.code) || []), ...created]);
    return created;
  },
  async confirmOrderLines(batch, ids) { for (const line of rows.get(batch.code) || []) if (ids.includes(line.recordId)) line.syncStatus = '已确认'; },
};
const journal = new Journal({ path: ':memory:' });
const service = new OrderService({ repository, journal });
const batch = code => ({ code, imageUrlTemplate: '/images/{id}/missing.svg' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// Test-only variant: preserve native editing and form submission while hiding
// edit notifications from React's delegated listeners. No values are inspected.
const missingInputEventsScript = `<script>
  (() => {
    for (const type of ['input', 'change', 'compositionend', 'focusout']) {
      document.addEventListener(type, event => event.stopPropagation(), true);
    }
  })();
</script>`;
const root = resolve(import.meta.dirname, '../dist');
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.local');
    if (url.pathname === '/') { res.writeHead(302, { Location: '/b/fixture-a' }); return res.end(); }
    const match = url.pathname.match(/^\/api\/batches\/(fixture-[ab])\/(catalog|query|orders|submissions\/([^/]+))$/);
    if (match) {
      const current = batch(match[1]);
      if (match[2] === 'catalog') return send(res, 200, await service.getCatalog(current));
      if (match[2].startsWith('submissions/')) return send(res, 200, await service.getSubmission(current, match[3]));
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      if (match[2] === 'query') return send(res, 200, await service.queryOrders(current, payload.phone));
      if (failFirstPost) { failFirstPost = false; return send(res, 503, { error: { code: 'TEST_UNDELIVERED_REQUEST', message: '模拟请求未到达，稍后会使用原编号恢复。' } }); }
      return send(res, 202, await service.submit(current, payload));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: { code: 'NOT_FOUND', message: '仅提供 fixture-a / fixture-b。' } });
    const path = url.pathname.startsWith('/b/') ? resolve(root, 'index.html') : resolve(root, `.${url.pathname}`);
    if (!path.startsWith(`${root}/`)) return send(res, 403, {});
    let data = await readFile(path);
    if (/^\/b\/fixture-[ab]\/?$/.test(url.pathname) && url.searchParams.get('missing-input-events') === '1') {
      data = data.toString('utf8').replace('</head>', `${missingInputEventsScript}\n</head>`);
    }
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) { send(res, error.status || 404, { error: { code: error.code || 'NOT_FOUND', message: error.message } }); }
});
server.listen(3002, '127.0.0.1', () => console.log('隔离浏览器验收：http://127.0.0.1:3002/b/fixture-a'));
process.on('SIGINT', () => { server.close(); journal.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); journal.close(); process.exit(0); });
