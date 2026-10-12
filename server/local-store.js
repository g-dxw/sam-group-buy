import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DomainError, completeGroup, normalizePhone } from './order-service.js';

export const ORDER_STATUSES = ['待采购', '已买到', '缺货', '已领取', '已取消'];
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
const EXCLUDED = new Set(['缺货', '已取消']);
export function productVersion(product) {
  return createHash('sha256').update(JSON.stringify([
    product.id, product.name, product.spec, product.unit, product.priceCents, product.onSale,
  ])).digest('hex');
}
export function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function productInput(product) {
  if (!product || typeof product.id !== 'string' || !PRODUCT_ID.test(product.id)
    || typeof product.name !== 'string' || !product.name.trim() || product.name.length > 200
    || typeof product.spec !== 'string' || !product.spec.trim() || product.spec.length > 200
    || typeof product.unit !== 'string' || !product.unit.trim() || product.unit.length > 30
    || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0 || product.priceCents > 100_000_000
    || typeof product.onSale !== 'boolean' || (product.sort != null && !Number.isFinite(product.sort))) {
    throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '商品数据有无效编号、价格或未填完整，请在飞书修正后重新同步。');
  }
  return {
    id: product.id, recordId: product.recordId || null, name: product.name.trim(),
    spec: product.spec.trim(), unit: product.unit.trim(), priceCents: product.priceCents,
    category: (typeof product.category === 'string' ? product.category.trim() : '') || '其他',
    onSale: product.onSale, sort: product.sort ?? 0,
  };
}

export class LocalStore {
  constructor({ path = '.data/orders.sqlite' } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.path = path;
    this.depth = 0;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (
        product_id TEXT PRIMARY KEY, record_id TEXT, name TEXT NOT NULL,
        spec TEXT NOT NULL, unit TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
        category TEXT NOT NULL, on_sale INTEGER NOT NULL CHECK(on_sale IN (0,1)),
        sort REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS communities (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batches (
        code TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id),
        period_number INTEGER NOT NULL CHECK(period_number >= 0),
        request_id TEXT UNIQUE, request_hash TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
        product_ids_json TEXT NOT NULL, collecting INTEGER NOT NULL CHECK(collecting IN (0,1)),
        cutoff_at TEXT, pickup_location TEXT NOT NULL, pickup_at TEXT, contact_note TEXT NOT NULL,
        image_url_template TEXT NOT NULL, feishu_url TEXT, created_at TEXT NOT NULL,
        UNIQUE(community_id, period_number)
      );
      CREATE TABLE IF NOT EXISTS submissions (
        batch_code TEXT NOT NULL REFERENCES batches(code), submission_id TEXT NOT NULL,
        phone TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL,
        payload_hash TEXT, payload_json TEXT, submitted_at TEXT NOT NULL,
        expected_lines INTEGER NOT NULL CHECK(expected_lines > 0),
        PRIMARY KEY(batch_code, submission_id)
      );
      CREATE TABLE IF NOT EXISTS order_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_code TEXT NOT NULL,
        submission_id TEXT NOT NULL, line_id TEXT NOT NULL, product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity >= 0 AND quantity <= 999),
        status TEXT NOT NULL CHECK(status IN ('待采购','已买到','缺货','已领取','已取消')),
        revision INTEGER NOT NULL DEFAULT 1, synced_revision INTEGER NOT NULL DEFAULT 0,
        remote_record_id TEXT, export_error TEXT,
        UNIQUE(batch_code, line_id),
        FOREIGN KEY(batch_code, submission_id) REFERENCES submissions(batch_code, submission_id)
      );
      CREATE INDEX IF NOT EXISTS submission_phone ON submissions(batch_code, phone);
      CREATE INDEX IF NOT EXISTS lines_product ON order_lines(product_id);
      CREATE INDEX IF NOT EXISTS lines_batch ON order_lines(batch_code, revision, synced_revision);
    `);
  }

  transaction(callback) {
    if (this.depth) return callback();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = callback();
      if (result?.then) throw new Error('SQLite transaction callbacks must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.depth -= 1; }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value_json FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : null;
  }
  setMeta(key, value) {
    this.db.prepare(`INSERT INTO meta(key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(key, JSON.stringify(value));
    return value;
  }
  getSyncStatus(key = 'syncStatus') { return this.getMeta(key); }
  setSyncStatus(key, value) {
    return arguments.length === 1 ? this.setMeta('syncStatus', key) : this.setMeta(key, value);
  }

  decodeProduct(row) {
    return row ? {
      id: row.product_id, recordId: row.record_id, name: row.name, spec: row.spec, unit: row.unit,
      priceCents: row.price_cents, category: row.category, onSale: Boolean(row.on_sale),
      sort: row.sort, updatedAt: row.updated_at,
    } : null;
  }
  listProducts() {
    return this.db.prepare('SELECT * FROM products ORDER BY sort, product_id').all().map(row => this.decodeProduct(row));
  }
  getProduct(id) { return this.decodeProduct(this.db.prepare('SELECT * FROM products WHERE product_id = ?').get(id)); }

  importProducts(products, { source = null, lastSyncedAt, syncedAt } = {}) {
    if (!Array.isArray(products)) throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '同步结果必须是完整商品列表。');
    const normalized = products.map(productInput);
    if (new Set(normalized.map(product => product.id)).size !== normalized.length) {
      throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '飞书商品表存在重复商品编号，请修正后再同步。');
    }
    const timestamp = lastSyncedAt || syncedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_SYNC_TIME', '同步时间无效。');
    return this.transaction(() => {
      const existing = new Map(this.listProducts().map(product => [product.id, product]));
      const incoming = new Set(normalized.map(product => product.id));
      let added = 0;
      let updated = 0;
      let disabled = 0;
      const upsert = this.db.prepare(`INSERT INTO products
        (product_id, record_id, name, spec, unit, price_cents, category, on_sale, sort, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET record_id=excluded.record_id, name=excluded.name,
        spec=excluded.spec, unit=excluded.unit, price_cents=excluded.price_cents, category=excluded.category,
        on_sale=excluded.on_sale, sort=excluded.sort, updated_at=excluded.updated_at`);
      for (const product of normalized) {
        const previous = existing.get(product.id);
        if (!previous) added += 1;
        else if (['recordId', 'name', 'spec', 'unit', 'priceCents', 'category', 'onSale', 'sort']
          .some(key => previous[key] !== product[key])) updated += 1;
        if (previous?.onSale && !product.onSale) disabled += 1;
        if (previous && ['name', 'spec', 'unit', 'priceCents'].some(key => previous[key] !== product[key])) {
          this.db.prepare('UPDATE order_lines SET revision=revision+1, export_error=NULL WHERE product_id = ?').run(product.id);
        }
        upsert.run(product.id, product.recordId, product.name, product.spec, product.unit,
          product.priceCents, product.category || '其他', product.onSale ? 1 : 0, product.sort, timestamp);
      }
      for (const product of existing.values()) {
        if (!incoming.has(product.id) && product.onSale) {
          this.db.prepare('UPDATE products SET on_sale=0, updated_at=? WHERE product_id=?').run(timestamp, product.id);
          disabled += 1;
        }
      }
      const result = { source, lastSyncedAt: timestamp, count: normalized.length,
        total: normalized.length, added, updated, disabled, offSale: disabled };
      this.setMeta('productSync', result);
      return result;
    });
  }

  listCommunities() {
    return this.db.prepare(`SELECT c.*, COALESCE(MAX(b.period_number), 0) + 1 AS next_period_number
      FROM communities c LEFT JOIN batches b ON b.community_id=c.id
      GROUP BY c.id ORDER BY c.created_at, c.name`).all().map(row => ({
      id: row.id, name: row.name, createdAt: row.created_at, nextPeriodNumber: row.next_period_number,
    }));
  }
  getCommunity(idOrName) {
    const row = this.db.prepare('SELECT * FROM communities WHERE id=? OR name=?').get(idOrName, idOrName);
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
  }
  createCommunity({ name, createdAt = new Date().toISOString() }) {
    const normalized = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!normalized || normalized.length > 80) throw new DomainError(400, 'INVALID_COMMUNITY', '请填写小区或群名称（最多 80 字）。');
    return this.transaction(() => {
      const existing = this.getCommunity(normalized);
      if (existing) return existing;
      const id = randomUUID();
      this.db.prepare('INSERT INTO communities(id,name,created_at) VALUES(?,?,?)').run(id, normalized, createdAt);
      return this.getCommunity(id);
    });
  }

  decodeBatch(row) {
    if (!row) return null;
    return {
      code: row.code, name: row.title, title: row.title, description: row.description,
      communityId: row.community_id, communityName: row.community_name,
      periodNumber: row.period_number, periodLabel: row.period_number === 0 ? '演示' : `第${row.period_number}期`,
      requestId: row.request_id, requestHash: row.request_hash,
      productIds: JSON.parse(row.product_ids_json), collecting: Boolean(row.collecting),
      cutoffAt: row.cutoff_at, pickupLocation: row.pickup_location, pickupAt: row.pickup_at,
      contactNote: row.contact_note, imageUrlTemplate: row.image_url_template,
      feishuUrl: row.feishu_url, createdAt: row.created_at, managed: true,
    };
  }
  listBatches() {
    return this.db.prepare(`SELECT b.*,c.name AS community_name FROM batches b
      JOIN communities c ON c.id=b.community_id ORDER BY b.created_at DESC, b.rowid DESC`).all().map(row => this.decodeBatch(row));
  }
  getBatch(code) {
    return this.decodeBatch(this.db.prepare(`SELECT b.*,c.name AS community_name FROM batches b
      JOIN communities c ON c.id=b.community_id WHERE b.code=?`).get(code));
  }
  getBatchByRequest(requestId) {
    return this.decodeBatch(this.db.prepare(`SELECT b.*,c.name AS community_name FROM batches b
      JOIN communities c ON c.id=b.community_id WHERE b.request_id=?`).get(requestId));
  }
  createBatch(input) {
    return this.transaction(() => {
      const existing = input.requestId ? this.getBatchByRequest(input.requestId) : this.getBatch(input.code);
      if (existing) {
        if (input.requestHash && existing.requestHash !== input.requestHash) throw new DomainError(409, 'BATCH_REQUEST_CONFLICT', '该创建编号已经用于另一份团购。');
        return existing;
      }
      const community = this.getCommunity(input.communityId);
      if (!community) throw new DomainError(404, 'COMMUNITY_NOT_FOUND', '未找到这个小区或群。');
      const periodNumber = input.periodNumber ?? this.db.prepare(
        'SELECT COALESCE(MAX(period_number),0)+1 AS next FROM batches WHERE community_id=?',
      ).get(community.id).next;
      const code = input.code || `gb-${input.requestId}`;
      this.db.prepare(`INSERT INTO batches
        (code,community_id,period_number,request_id,request_hash,title,description,product_ids_json,
         collecting,cutoff_at,pickup_location,pickup_at,contact_note,image_url_template,feishu_url,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        code, community.id, periodNumber, input.requestId || null, input.requestHash || null,
        input.title || `${community.name} · 第${periodNumber}期`, input.description || '',
        JSON.stringify(input.productIds || []), input.collecting === false ? 0 : 1,
        input.cutoffAt || null, input.pickupLocation || '', input.pickupAt || null,
        input.contactNote || '', input.imageUrlTemplate || '/images/{id}/cover.svg',
        input.feishuUrl || null, input.createdAt || new Date().toISOString(),
      );
      if (!this.getMeta('defaultBatch')) this.setMeta('defaultBatch', code);
      return this.getBatch(code);
    });
  }
  updateBatch(code, patch) {
    const columns = { title: 'title', description: 'description', productIds: 'product_ids_json',
      collecting: 'collecting', cutoffAt: 'cutoff_at', pickupLocation: 'pickup_location',
      pickupAt: 'pickup_at', contactNote: 'contact_note' };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!columns[key]) throw new DomainError(400, 'INVALID_BATCH_FIELDS', '小区归属与期数不能修改。');
      assignments.push(`${columns[key]}=?`);
      values.push(key === 'productIds' ? JSON.stringify(value) : key === 'collecting' ? Number(value) : value);
    }
    if (!this.getBatch(code)) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
    if (assignments.length) this.db.prepare(`UPDATE batches SET ${assignments.join(',')} WHERE code=?`).run(...values, code);
    return this.getBatch(code);
  }

  getSubmission(code, id) {
    const row = this.db.prepare('SELECT * FROM submissions WHERE batch_code=? AND submission_id=?').get(code, id);
    return row ? { submissionId: row.submission_id, batchCode: row.batch_code, phone: row.phone,
      name: row.name, note: row.note, payloadHash: row.payload_hash,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      expectedLines: row.expected_lines, submittedAt: row.submitted_at, status: 'completed' } : null;
  }
  saveSubmission(code, payload, { submittedAt = new Date().toISOString(), hash = payloadHash(payload), lines } = {}) {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO submissions(batch_code,submission_id,phone,name,note,payload_hash,payload_json,submitted_at,expected_lines)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(code, payload.submissionId, payload.phone, payload.name,
        payload.note || '', hash, JSON.stringify(payload), submittedAt, payload.items.length);
      const insert = this.db.prepare(`INSERT INTO order_lines
        (batch_code,submission_id,line_id,product_id,quantity,status,revision,synced_revision,remote_record_id)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const item of lines || payload.items) {
        insert.run(code, payload.submissionId, item.lineId || `${payload.submissionId}:${item.productId}`,
          item.productId, item.quantity, item.status || '待采购', item.revision || 1,
          item.syncedRevision || 0, item.remoteRecordId || null);
      }
      return this.getSubmission(code, payload.submissionId);
    });
  }
  listOrderLines(code, { phone, submissionId } = {}) {
    const conditions = ['l.batch_code=?'];
    const values = [code];
    if (phone) { conditions.push('s.phone=?'); values.push(phone); }
    if (submissionId) { conditions.push('l.submission_id=?'); values.push(submissionId); }
    return this.db.prepare(`SELECT l.*,s.phone,s.name,s.note,s.expected_lines,s.submitted_at
      FROM order_lines l JOIN submissions s ON s.batch_code=l.batch_code AND s.submission_id=l.submission_id
      WHERE ${conditions.join(' AND ')} ORDER BY l.id`).all(...values).map(row => ({
      recordId: String(row.id), batchCode: row.batch_code, submissionId: row.submission_id,
      lineId: row.line_id, productId: row.product_id, quantity: row.quantity, status: row.status,
      phone: row.phone, name: row.name, note: row.note, expectedLines: row.expected_lines,
      submittedAt: row.submitted_at, syncStatus: '已确认', revision: row.revision,
      syncedRevision: row.synced_revision, remoteRecordId: row.remote_record_id, syncError: row.export_error,
    }));
  }
  updateOrder(code, id, patch) {
    const current = this.listOrderLines(code).find(line => line.recordId === String(id) || line.lineId === id);
    if (!current) throw new DomainError(404, 'ORDER_NOT_FOUND', '本期未找到该订单明细。');
    const quantity = Object.hasOwn(patch, 'quantity') ? patch.quantity : current.quantity;
    const status = Object.hasOwn(patch, 'status') ? patch.status : current.status;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 999 || !ORDER_STATUSES.includes(status)) {
      throw new DomainError(400, 'INVALID_ORDER_UPDATE', '数量需为 0 至 999 的整数，状态需为预设状态。');
    }
    if (quantity !== current.quantity || status !== current.status) this.db.prepare(`UPDATE order_lines
      SET quantity=?,status=?,revision=revision+1,export_error=NULL WHERE batch_code=? AND id=?`).run(quantity, status, code, Number(current.recordId));
    return this.listOrderLines(code).find(line => line.recordId === current.recordId);
  }

  listExportLines(code, { onlyDirty = false } = {}) {
    const batch = this.getBatch(code);
    if (!batch) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
    const products = new Map(this.listProducts().map(product => [product.id, product]));
    return this.listOrderLines(code).filter(line => !onlyDirty || line.revision !== line.syncedRevision).map(line => {
      const product = products.get(line.productId);
      return {
        ...line, version: line.revision, syncedVersion: line.syncedRevision,
        communityName: batch.communityName, periodNumber: batch.periodNumber, periodLabel: batch.periodLabel,
        product: product || null, productName: product?.name || `商品 ${line.productId}（资料缺失）`,
        spec: product?.spec || '', unit: product?.unit || '', priceCents: product?.priceCents ?? null,
        amountCents: EXCLUDED.has(line.status) ? 0 : product ? product.priceCents * line.quantity : null,
      };
    });
  }
  getExportSnapshot(code) { return { batch: this.getBatch(code), lines: this.listExportLines(code) }; }
  markExported(code, lineId, revision, remoteRecordId) {
    if (Array.isArray(lineId)) return this.transaction(() => lineId.map(line => this.markExported(
      code, line.lineId, line.revision ?? line.version, line.remoteRecordId,
    )));
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM order_lines WHERE batch_code=? AND line_id=?').get(code, lineId);
      if (!row) return false;
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > row.revision) throw new DomainError(400, 'INVALID_EXPORT_REVISION', '同步版本无效。');
      if (row.remote_record_id && remoteRecordId && row.remote_record_id !== remoteRecordId) {
        throw new DomainError(409, 'EXPORT_RECORD_CONFLICT', '同一明细对应了不同的飞书记录，请核查后再同步。');
      }
      const matched = row.revision === revision;
      this.db.prepare(`UPDATE order_lines SET remote_record_id=COALESCE(?,remote_record_id),
        synced_revision=CASE WHEN revision=? THEN ? ELSE synced_revision END,
        export_error=CASE WHEN revision=? THEN NULL ELSE export_error END
        WHERE batch_code=? AND line_id=?`).run(remoteRecordId || null, revision, revision, revision, code, lineId);
      return matched;
    });
  }
  markExportError(code, lineId, message) {
    this.db.prepare('UPDATE order_lines SET export_error=? WHERE batch_code=? AND line_id=?').run(String(message || '').slice(0, 500), code, lineId);
  }
  requestFullExport(code) {
    this.db.prepare('UPDATE order_lines SET synced_revision=0 WHERE batch_code=?').run(code);
  }

  importLegacyBatch(config, settings, products, lines) {
    return this.transaction(() => {
      const existing = this.getBatch(config.code);
      if (existing) return { batch: existing, imported: false, orderLines: 0 };
      const normalized = products.map(productInput);
      if (!this.listProducts().length) this.importProducts(normalized, { source: config });
      else {
        // Bootstrap another old batch without replacing the shared current
        // catalog that may already have been manually synchronized.
        const insert = this.db.prepare(`INSERT OR IGNORE INTO products
          (product_id,record_id,name,spec,unit,price_cents,category,on_sale,sort,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
        for (const product of normalized) insert.run(product.id, product.recordId, product.name, product.spec,
          product.unit, product.priceCents, product.category || '其他', Number(product.onSale), product.sort, new Date().toISOString());
      }
      const community = this.createCommunity({ name: settings.communityName || config.communityName || config.name || '演示群' });
      const created = this.createBatch({ code: config.code, communityId: community.id,
        periodNumber: settings.periodNumber ?? config.periodNumber ?? 0,
        title: settings.title || config.name || config.code, description: settings.description || '',
        productIds: Array.isArray(settings.productIds) ? settings.productIds : normalized.map(product => product.id),
        collecting: settings.collecting, cutoffAt: settings.cutoffAt, pickupLocation: settings.pickupLocation,
        pickupAt: settings.pickupAt, contactNote: settings.contactNote,
        imageUrlTemplate: config.imageUrlTemplate, feishuUrl: config.feishuUrl,
        createdAt: config.createdAt || new Date().toISOString(),
      });
      this.setMeta(`legacySource:${config.code}`, config);
      const grouped = new Map();
      for (const line of lines) {
        if (!grouped.has(line.submissionId)) grouped.set(line.submissionId, []);
        grouped.get(line.submissionId).push(line);
      }
      let count = 0;
      for (const [id, group] of grouped) {
        if (!completeGroup(group)) continue;
        const payload = { submissionId: id, phone: normalizePhone(group[0].phone), name: group[0].name,
          note: group[0].note || '', items: group.map(line => ({ productId: line.productId, quantity: line.quantity,
            version: this.getProduct(line.productId) ? productVersion(this.getProduct(line.productId)) : '0'.repeat(64),
          })).sort((a, b) => a.productId.localeCompare(b.productId)) };
        this.saveSubmission(config.code, payload, { submittedAt: group[0].submittedAt || new Date().toISOString(),
          lines: group.map(line => ({ ...line, revision: 1, syncedRevision: 0, remoteRecordId: line.remoteRecordId || line.recordId })),
        });
        count += group.length;
      }
      return { batch: created, imported: true, orderLines: count };
    });
  }

  close() { this.db.close(); }
}
