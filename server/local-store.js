import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DomainError, completeGroup, normalizePhone } from './order-service.js';
import { billLines, cents, normalizeFeePolicy } from './order-billing.js';
import { normalizeSplitRules, splitLine, splitAmount } from './split-groups.js';
import { productPricing, pricingChanged, validPrice } from './product-pricing.js';

export const ORDER_STATUSES = ['待采购', '已买到', '缺货', '已领取', '已取消'];
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
const EXCLUDED = new Set(['缺货', '已取消']);
const PRODUCT_FIELDS = ['name', 'spec', 'unit', 'priceCents', 'category', 'onSale', 'sort', 'imageUrl', 'originalPriceCents', 'pricing'];
export function productVersion(product) {
  return createHash('sha256').update(JSON.stringify([
    product.id, product.name, product.spec, product.unit, product.priceCents, product.onSale,
  ])).digest('hex');
}
export function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function communityExportArchiveKey(destination, code) {
  return `feishu-community-export-archive:${payloadHash([destination.baseToken, destination.orderTableId])}:${code}`;
}
const sameOrderDestination = (a, b) => Boolean(a?.baseToken && a?.orderTableId
  && a.baseToken === b?.baseToken && a.orderTableId === b?.orderTableId);
const pendingOrderCreates = meta => Boolean(meta?.pendingCreates && Object.keys(meta.pendingCreates).length);
export function samsStoreKey(store) {
  return store ? JSON.stringify([store.cityCode, store.storeId, store.storeType]) : null;
}

function productInput(product) {
  if (!product || typeof product.id !== 'string' || !PRODUCT_ID.test(product.id)
    || typeof product.name !== 'string' || !product.name.trim() || product.name.length > 200
    || typeof product.spec !== 'string' || !product.spec.trim() || product.spec.length > 200
    || typeof product.unit !== 'string' || !product.unit.trim() || product.unit.length > 30
    || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0 || product.priceCents > 100_000_000
    || typeof product.onSale !== 'boolean' || (product.sort != null && !Number.isFinite(product.sort))) {
    throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '商品编号、价格或必填资料无效，请补全后重试。');
  }
  const imageUrl = productImageUrl(product.imageUrl);
  const source = product.source == null ? null : product.source;
  if (source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '商品来源资料无效。');
  }
  return {
    id: product.id, recordId: product.recordId || null, name: product.name.trim(),
    spec: product.spec.trim(), unit: product.unit.trim(), ...productPricing(product),
    category: (typeof product.category === 'string' ? product.category.trim() : '') || '其他',
    onSale: product.onSale, sort: product.sort ?? 0, imageUrl,
    source: source === null ? null : JSON.parse(JSON.stringify(source)),
  };
}

function productImageUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value)) {
    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
    try {
      const url = new URL(value);
      if (/^https?:\/\//i.test(value) && ['http:', 'https:'].includes(url.protocol)
        && url.hostname && !url.username && !url.password) return value;
    } catch {}
  }
  throw new DomainError(400, 'INVALID_PRODUCT_IMAGE', '商品图片需使用有效的 HTTP、HTTPS 地址或本站图片路径。');
}

function selectedProductInput(product) {
  const normalized = productInput(product);
  const source = normalized.source;
  const searchSource = source && (source.method == null || source.method === 'search')
    && typeof source.keyword === 'string' && source.keyword.trim();
  const rankSource = source?.method === 'rank' && source.keyword === ''
    && ['rankId', 'rankCategoryId'].every(key => typeof source[key] === 'string' && /^\d{1,30}$/.test(source[key]))
    && ['rankName', 'rankCategoryName'].every(key => typeof source[key] === 'string' && source[key].trim() && source[key].length <= 200);
  if (!source || source.platform !== 'samsclub_cn' || typeof source.spuId !== 'string'
    || !/^[A-Za-z0-9_-]{1,120}$/.test(source.spuId) || normalized.id !== `sam_${source.spuId}`
    || typeof source.storeId !== 'string' || !/^\d{1,12}$/.test(source.storeId)
    || ![2, 4, 8, 256].includes(source.storeType)
    || typeof source.storeName !== 'string' || !source.storeName.trim()
    || (!searchSource && !rankSource)
    || typeof source.queriedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(source.queriedAt)
    || !Number.isFinite(Date.parse(source.queriedAt)) || source.priceCents !== normalized.priceCents
    || !/^https?:\/\//i.test(normalized.imageUrl || '')
    || JSON.stringify(source).length > 30_000) {
    throw new DomainError(400, 'INVALID_PRODUCT_SELECTION', '选品资料、图片或销售价格不完整，请重新查询后再入库。');
  }
  return { ...normalized, recordId: null, onSale: false };
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
        sort REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        image_url TEXT, source_json TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at TEXT NOT NULL DEFAULT '', removed_at TEXT
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
        sams_store_json TEXT, fee_policy_json TEXT, split_rules_json TEXT, deleted_at TEXT,
        UNIQUE(community_id, period_number)
      );
      CREATE TABLE IF NOT EXISTS split_settlements (
        batch_code TEXT NOT NULL REFERENCES batches(code), product_id TEXT NOT NULL,
        result_json TEXT NOT NULL, PRIMARY KEY(batch_code,product_id)
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
        remote_record_id TEXT, export_error TEXT, snapshot_json TEXT,
        UNIQUE(batch_code, line_id),
        FOREIGN KEY(batch_code, submission_id) REFERENCES submissions(batch_code, submission_id)
      );
      CREATE INDEX IF NOT EXISTS submission_phone ON submissions(batch_code, phone);
      CREATE INDEX IF NOT EXISTS lines_product ON order_lines(product_id);
      CREATE INDEX IF NOT EXISTS lines_batch ON order_lines(batch_code, revision, synced_revision);
      CREATE TABLE IF NOT EXISTS customer_selections (
        selection_id TEXT PRIMARY KEY, batch_code TEXT NOT NULL REFERENCES batches(code),
        owner_hash TEXT NOT NULL, store_key TEXT NOT NULL, data_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS customer_selection_owner ON customer_selections(batch_code,owner_hash);
      CREATE TABLE IF NOT EXISTS customer_products (
        batch_code TEXT NOT NULL REFERENCES batches(code), owner_hash TEXT NOT NULL,
        product_id TEXT NOT NULL, store_key TEXT NOT NULL, product_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(batch_code,owner_hash,product_id)
      );
    `);
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(products)').all().map(column => column.name));
      for (const [name, definition] of Object.entries({ image_url: 'TEXT', source_json: 'TEXT', original_price_cents: 'INTEGER', pricing_json: 'TEXT', removed_at: 'TEXT',
        revision: 'INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)', created_at: "TEXT NOT NULL DEFAULT ''" })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec("UPDATE products SET created_at=updated_at WHERE created_at='' OR created_at IS NULL");
      for (const [table, name, definition] of [['batches', 'sams_store_json', 'TEXT'], ['batches', 'fee_policy_json', 'TEXT'], ['batches', 'split_rules_json', 'TEXT'], ['batches', 'deleted_at', 'TEXT'],
        ['order_lines', 'snapshot_json', 'TEXT'], ['submissions', 'customer_hash', 'TEXT']]) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      }
      // Capture historical orders before introducing editable retail pricing.
      // Existing product snapshots are left unchanged.
      this.freezeLegacyOrderProducts();
      const savePricing = this.db.prepare('UPDATE products SET original_price_cents=?,pricing_json=? WHERE product_id=?');
      for (const row of this.db.prepare('SELECT * FROM products WHERE pricing_json IS NULL').all()) {
        const source = row.source_json ? JSON.parse(row.source_json) : null;
        savePricing.run(validPrice(source?.priceCents) ? source.priceCents : null,
          JSON.stringify({ mode: 'fixed', markupBps: null }), row.product_id);
      }
      // Moving from frozen rates to the current period policy also invalidates
      // local export receipts. No remote backup runs during this migration.
      if (this.getMeta('orderBillingPolicyVersion') !== 'current-batch-fees-v1') {
        for (const batch of this.listBatches({ includeDeleted: true })) {
          const before = billLines(this.listExportLines(batch.code, { includeDeleted: true })
            .map(line => ({ ...line, feeRateBps: line.snapshot?.feeRateBps ?? 0 })));
          this.markBillingChanges(batch.code, before, new Set(), { includeDeleted: true });
        }
        this.setMeta('orderBillingPolicyVersion', 'current-batch-fees-v1');
      }
    });
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
  getCommunityOrderTable(baseToken, communityId) {
    return this.getMeta(`feishu-community-table:${baseToken}:${communityId}`);
  }
  setCommunityOrderTable(baseToken, communityId, value) {
    if (typeof baseToken !== 'string' || !baseToken.trim() || typeof communityId !== 'string' || !communityId.trim()
      || !value || typeof value !== 'object' || Array.isArray(value) || value.baseToken !== baseToken || value.communityId !== communityId
      || !['ready', 'pending', 'error'].includes(value.status)
      || value.tableId != null && (typeof value.tableId !== 'string' || !value.tableId.trim())
      || value.tableName != null && (typeof value.tableName !== 'string' || !value.tableName.trim() || value.tableName.length > 200)
      || value.status === 'ready' && !value.tableId) {
      throw new DomainError(400, 'INVALID_COMMUNITY_ORDER_TABLE', '群订单表绑定资料无效。');
    }
    return this.setMeta(`feishu-community-table:${baseToken}:${communityId}`, value);
  }
  isCommunityOrderDestinationCurrent(code, batch = this.getBatch(code)) {
    const source = this.getMeta('exportSource');
    // Legacy/offline stores without a configured Base retain their existing
    // revision semantics until a manual configuration or sync selects a target.
    if (!source?.baseToken || source.orderScope === 'shared' || !batch?.communityId
      || source.orderScope !== 'community' && !source.orderTableId) return true;
    const binding = this.getCommunityOrderTable(source.baseToken, batch.communityId);
    const meta = this.getMeta(`feishu-export:${code}`);
    return binding?.status === 'ready' && meta?.scope === 'community'
      && sameOrderDestination(meta.destination, { baseToken: source.baseToken, orderTableId: binding.tableId });
  }
  switchOrderExportDestination(code, destination, { scope = 'community', tableName = null } = {}) {
    if (!destination || typeof destination !== 'object' || Array.isArray(destination)
      || Object.keys(destination).some(key => !['baseToken', 'orderTableId'].includes(key))
      || ['baseToken', 'orderTableId'].some(key => typeof destination[key] !== 'string' || !destination[key].trim())
      || !['community', 'legacy'].includes(scope)
      || tableName != null && (typeof tableName !== 'string' || !tableName.trim() || tableName.length > 200)) {
      throw new DomainError(400, 'INVALID_ORDER_EXPORT_DESTINATION', '订单备份目标无效。');
    }
    return this.transaction(() => {
      if (!this.getBatch(code, { includeDeleted: true })) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
      const key = `feishu-export:${code}`;
      const stored = this.getMeta(key) || {};
      const lines = this.db.prepare('SELECT line_id,revision,remote_record_id,synced_revision,export_error FROM order_lines WHERE batch_code=? ORDER BY id').all(code)
        .map(row => ({ lineId: row.line_id, revision: row.revision, remoteRecordId: row.remote_record_id,
          syncedRevision: row.synced_revision, syncError: row.export_error }));
      let previous = stored;
      const hadRemoteState = lines.some(line => line.remoteRecordId || line.syncedRevision || line.syncError)
        || stored.lastSyncedAt || stored.viewUrl || pendingOrderCreates(stored) || stored.status === 'success'
        || ['created', 'updated', 'unchanged'].some(key => stored.counts?.[key] > 0);
      if (!stored.destination && hadRemoteState) {
        const oldSource = this.getMeta('exportSource');
        if (!oldSource?.baseToken || !oldSource.orderTableId) throw new DomainError(409, 'ORDER_EXPORT_DESTINATION_UNKNOWN', '旧订单同步目标无法确认，请先核对原飞书订单表；本地绑定保留。');
        previous = { ...stored, destination: { baseToken: oldSource.baseToken, orderTableId: oldSource.orderTableId }, scope: 'legacy' };
      }
      if (sameOrderDestination(previous.destination, destination)) {
        // Pinning a legacy destination is safe even with unresolved writes:
        // reconciliation still runs against exactly that table and its bindings.
        return this.setMeta(key, { ...previous, destination: { ...destination }, scope,
          tableName: tableName || previous.tableName || null });
      }
      const targetArchive = this.getMeta(communityExportArchiveKey(destination, code));
      if (pendingOrderCreates(previous) || pendingOrderCreates(targetArchive?.meta || targetArchive)
        || targetArchive?.history?.some(row => pendingOrderCreates(row.meta))) {
        throw new DomainError(409, 'ORDER_EXPORT_PENDING_CREATES', '存在尚未确认的飞书新增记录，请先在原订单表完成核查，再切换群订单表。');
      }
      if (previous.destination) {
        const archiveKey = communityExportArchiveKey(previous.destination, code);
        const existing = this.getMeta(archiveKey);
        const archive = { destination: previous.destination, scope: previous.scope || 'legacy',
          tableName: previous.tableName || previous.targetTableName || null, meta: previous, lines,
          archivedAt: new Date().toISOString() };
        if (existing) {
          const { history = [], ...last } = existing;
          archive.history = [...history, last];
        }
        this.setMeta(archiveKey, archive);
      }
      this.db.prepare('UPDATE order_lines SET remote_record_id=NULL,synced_revision=0,export_error=NULL WHERE batch_code=?').run(code);
      return this.setMeta(key, { destination: { ...destination }, scope, tableName,
        pendingCreates: {}, status: 'pending', lastSyncedAt: null, counts: null, error: null, viewUrl: null,
        legacyViewUrl: previous.scope === 'legacy' ? previous.viewUrl || previous.legacyViewUrl || null : previous.legacyViewUrl || null });
    });
  }

  decodeProduct(row) {
    return row ? {
      id: row.product_id, recordId: row.record_id, name: row.name, spec: row.spec, unit: row.unit,
      priceCents: row.price_cents, category: row.category, onSale: Boolean(row.on_sale),
      originalPriceCents: row.original_price_cents ?? null,
      pricing: row.pricing_json ? JSON.parse(row.pricing_json) : { mode: 'fixed', markupBps: null },
      sort: row.sort, updatedAt: row.updated_at, imageUrl: row.image_url,
      source: row.source_json ? JSON.parse(row.source_json) : null,
      revision: row.revision, createdAt: row.created_at, removedAt: row.removed_at || null,
    } : null;
  }
  listProducts({ includeRemoved = false } = {}) {
    return this.db.prepare(`SELECT * FROM products${includeRemoved ? '' : ' WHERE removed_at IS NULL'} ORDER BY sort, product_id`).all().map(row => this.decodeProduct(row));
  }
  getProduct(id) { return this.decodeProduct(this.db.prepare('SELECT * FROM products WHERE product_id = ?').get(id)); }

  freezeLegacyOrderProducts(productId = null) {
    const rows = this.db.prepare(`SELECT l.id,l.product_id AS legacy_product_id,p.* FROM order_lines l LEFT JOIN products p ON p.product_id=l.product_id
      WHERE l.snapshot_json IS NULL${productId === null ? '' : ' AND l.product_id=?'}`).all(...(productId === null ? [] : [productId]));
    const save = this.db.prepare('UPDATE order_lines SET snapshot_json=? WHERE id=? AND snapshot_json IS NULL');
    for (const row of rows) {
      const product = row.product_id === null ? null : this.decodeProduct(row);
      save.run(JSON.stringify(product ? { id: product.id, name: product.name, spec: product.spec, unit: product.unit,
        priceCents: product.priceCents, imageUrl: product.imageUrl,
        description: product.source?.description || '', feeCategory: 'recommended', feeRateBps: 0 }
        : { id: row.legacy_product_id, name: `商品 ${row.legacy_product_id}（资料缺失）`, spec: '', unit: '',
          priceCents: null, imageUrl: null, description: '', missing: true, feeCategory: 'recommended', feeRateBps: 0 }), row.id);
    }
  }

  selectProducts(products, { timestamp = new Date().toISOString() } = {}) {
    if (!Array.isArray(products) || !products.length || products.length > 200) {
      throw new DomainError(400, 'INVALID_PRODUCT_SELECTION', '请选择商品，一次最多入库 200 种商品。');
    }
    const normalized = products.map(selectedProductInput);
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_PRODUCT_TIME', '商品入库时间无效。');
    return this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO products
        (product_id,record_id,name,spec,unit,price_cents,category,on_sale,sort,updated_at,image_url,source_json,revision,created_at,original_price_cents,pricing_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(product_id) DO NOTHING`);
      let added = 0;
      for (const product of normalized) {
        added += Number(insert.run(product.id, null, product.name, product.spec, product.unit, product.priceCents,
          product.category, 0, product.sort, timestamp, product.imageUrl, JSON.stringify(product.source), timestamp,
          product.source.priceCents, JSON.stringify({ mode: 'markup', markupBps: 0 })).changes);
      }
      const ids = [...new Set(normalized.map(product => product.id))];
      return { added, skipped: normalized.length - added, products: ids.map(id => this.getProduct(id)) };
    });
  }

  cleanupCustomerData(now = Date.now()) {
    this.db.prepare('DELETE FROM customer_selections WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM customer_products WHERE updated_at<?').run(new Date(now - 30 * 86400_000).toISOString());
  }
  saveCustomerSelection({ selectionId, batchCode, ownerHash, storeKey, data, expiresAt }, now = Date.now()) {
    return this.transaction(() => {
      this.cleanupCustomerData(now);
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM customer_selections WHERE batch_code=? AND owner_hash=?').get(batchCode, ownerHash).n;
      if (count >= 50 || this.db.prepare('SELECT COUNT(*) AS n FROM customer_selections').get().n >= 3000) {
        throw new DomainError(429, 'CUSTOMER_QUERY_LIMIT', '本次查询较多，请稍后再查询。');
      }
      this.db.prepare('INSERT INTO customer_selections(selection_id,batch_code,owner_hash,store_key,data_json,expires_at) VALUES(?,?,?,?,?,?)')
        .run(selectionId, batchCode, ownerHash, storeKey, JSON.stringify(data), expiresAt);
    });
  }
  getCustomerSelection(selectionId, batchCode, ownerHash) {
    const row = this.db.prepare('SELECT * FROM customer_selections WHERE selection_id=? AND batch_code=? AND owner_hash=?')
      .get(selectionId, batchCode, ownerHash);
    return row ? { storeKey: row.store_key, data: JSON.parse(row.data_json), expiresAt: row.expires_at } : null;
  }
  getCustomerProduct(batchCode, ownerHash, id) {
    const row = this.db.prepare('SELECT * FROM customer_products WHERE batch_code=? AND owner_hash=? AND product_id=?').get(batchCode, ownerHash, id);
    return row ? { storeKey: row.store_key, product: JSON.parse(row.product_json) } : null;
  }
  listCustomerProducts(batchCode, ownerHash) {
    return this.db.prepare('SELECT * FROM customer_products WHERE batch_code=? AND owner_hash=? ORDER BY updated_at,product_id')
      .all(batchCode, ownerHash).map(row => ({ storeKey: row.store_key, product: JSON.parse(row.product_json) }));
  }
  saveCustomerProduct(batchCode, ownerHash, storeKey, product, now = Date.now()) {
    productInput(product);
    return this.transaction(() => {
      this.cleanupCustomerData(now);
      if (!this.getCustomerProduct(batchCode, ownerHash, product.id)
        && (this.listCustomerProducts(batchCode, ownerHash).length >= 200
          || this.db.prepare('SELECT COUNT(*) AS n FROM customer_products').get().n >= 50_000)) {
        throw new DomainError(400, 'CUSTOMER_PRODUCT_LIMIT', '个人清单最多保留 200 种商品。');
      }
      this.db.prepare(`INSERT INTO customer_products(batch_code,owner_hash,product_id,store_key,product_json,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(batch_code,owner_hash,product_id) DO UPDATE SET store_key=excluded.store_key,product_json=excluded.product_json,updated_at=excluded.updated_at`)
        .run(batchCode, ownerHash, product.id, storeKey, JSON.stringify(product), new Date(now).toISOString());
      return product;
    });
  }
  // Accepted personal selections become drafts for the administrator. They do
  // not replace existing edits, go on sale, or alter any batch's public scope.
  addCustomerCatalogProduct(product, timestamp = new Date().toISOString()) {
    const normalized = productInput(product);
    if (normalized.source?.customerSelected !== true) throw new DomainError(400, 'INVALID_PRODUCT_SELECTION', '顾客自选来源不完整。');
    const base = validPrice(normalized.source.priceCents) ? normalized.source.priceCents : normalized.priceCents;
    const pricing = normalized.priceCents === base ? { mode: 'markup', markupBps: 0 } : { mode: 'fixed', markupBps: null };
    this.db.prepare(`INSERT INTO products(product_id,record_id,name,spec,unit,price_cents,category,on_sale,sort,updated_at,image_url,source_json,revision,created_at,original_price_cents,pricing_json)
      VALUES(?,?,?,?,?,?,?,0,?,?,?,?,1,?,?,?) ON CONFLICT(product_id) DO NOTHING`).run(normalized.id, null, normalized.name,
      normalized.spec, normalized.unit, normalized.priceCents, normalized.category, normalized.sort, timestamp,
      normalized.imageUrl, JSON.stringify(normalized.source), timestamp,
      base, JSON.stringify(pricing));
    return this.getProduct(normalized.id);
  }

  updateProduct(id, patch, { timestamp = new Date().toISOString(), expectedRevision, sourcePriceSnapshot } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some(key => !PRODUCT_FIELDS.includes(key))) {
      throw new DomainError(400, 'INVALID_PRODUCT_FIELDS', '只能修改商品资料、原价及定价规则，商品来源不能由客户端修改。');
    }
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_PRODUCT_TIME', '商品修改时间无效。');
    return this.transaction(() => {
      const previous = this.getProduct(id);
      if (!previous) throw new DomainError(404, 'PRODUCT_NOT_FOUND', '未找到这个商品。');
      if (previous.removedAt) throw new DomainError(409, 'PRODUCT_REMOVED', '该商品已移除，请先手动恢复后再编辑或上架。', { productIds: [id] });
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
        throw new DomainError(400, 'INVALID_PRODUCT_REVISION', '商品修订版本无效，请刷新后重试。');
      }
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) {
        throw new DomainError(409, 'PRODUCT_REVISION_CONFLICT', '商品已被修改，请刷新后重新确认。', { productIds: [id] });
      }
      if ((Object.hasOwn(patch, 'category') && (typeof patch.category !== 'string' || !patch.category.trim() || patch.category.length > 80))
        || (Object.hasOwn(patch, 'sort') && !Number.isFinite(patch.sort))) {
        throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '商品分类或排序无效。');
      }
      // A legacy direct price edit means fixed retail pricing. Markup edits are
      // always calculated from the original price on the server.
      const implicitFixed = Object.hasOwn(patch, 'priceCents') && !Object.hasOwn(patch, 'pricing');
      const product = productInput({ ...previous, ...patch,
        ...(implicitFixed ? { pricing: { mode: 'fixed', markupBps: null } } : {}),
        ...(sourcePriceSnapshot ? { source: { ...previous.source,
          latestPriceCents: sourcePriceSnapshot.priceCents, latestQueriedAt: sourcePriceSnapshot.queriedAt } } : {}) });
      const changed = pricingChanged(previous, product) || PRODUCT_FIELDS.filter(key => !['pricing', 'originalPriceCents', 'priceCents'].includes(key)).some(key => previous[key] !== product[key]);
      if (!changed && !sourcePriceSnapshot) return previous;
      this.freezeLegacyOrderProducts(id);
      this.db.prepare(`UPDATE products SET name=?,spec=?,unit=?,price_cents=?,category=?,on_sale=?,sort=?,
        image_url=?,original_price_cents=?,pricing_json=?,source_json=?,revision=revision+1,updated_at=? WHERE product_id=?`).run(product.name, product.spec,
        product.unit, product.priceCents, product.category, Number(product.onSale), product.sort, product.imageUrl,
        product.originalPriceCents, JSON.stringify(product.pricing), product.source ? JSON.stringify(product.source) : null, timestamp, id);
      return this.getProduct(id);
    });
  }

  updateProductStatus(input, { timestamp = new Date().toISOString() } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['productIds', 'onSale'].includes(key))
      || !Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 200
      || typeof input.onSale !== 'boolean') {
      throw new DomainError(400, 'INVALID_PRODUCT_STATUS', '请选择 1 至 200 种商品，并设置布尔值的上架状态。');
    }
    const ids = Array.from(input.productIds);
    if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !PRODUCT_ID.test(id))) {
      throw new DomainError(400, 'INVALID_PRODUCT_STATUS', '商品编号无效或重复，请重新选择。');
    }
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_PRODUCT_TIME', '商品修改时间无效。');
    return this.transaction(() => {
      const previous = ids.map(id => this.getProduct(id));
      const missing = ids.filter((id, index) => !previous[index]);
      if (missing.length) throw new DomainError(404, 'PRODUCT_NOT_FOUND', '部分商品已不存在，请刷新商品库后重试。', { productIds: missing });
      const removed = previous.filter(product => product.removedAt).map(product => product.id);
      if (removed.length) throw new DomainError(409, 'PRODUCT_REMOVED', '部分商品已移除，请先手动恢复后再调整在售状态。', { productIds: removed });
      let updated = 0;
      const products = previous.map(product => {
        if (product.onSale === input.onSale) return product;
        updated += 1;
        return this.updateProduct(product.id, { onSale: input.onSale }, { timestamp });
      });
      return { updated, unchanged: ids.length - updated, products };
    });
  }

  removeProducts(input, { timestamp = new Date().toISOString() } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'productIds')
      || !Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 200
      || new Set(input.productIds).size !== input.productIds.length
      || input.productIds.some(id => typeof id !== 'string' || !PRODUCT_ID.test(id))) {
      throw new DomainError(400, 'INVALID_PRODUCT_REMOVE', '请选择 1 至 200 种不重复商品移除。');
    }
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_PRODUCT_TIME', '商品修改时间无效。');
    return this.transaction(() => {
      const products = input.productIds.map(id => this.getProduct(id));
      const missing = input.productIds.filter((id, i) => !products[i]);
      if (missing.length) throw new DomainError(404, 'PRODUCT_NOT_FOUND', '部分商品不存在，整批未移除，请刷新后重试。', { productIds: missing });
      let updated = 0;
      for (const product of products) if (!product.removedAt) {
        this.freezeLegacyOrderProducts(product.id);
        this.db.prepare('UPDATE products SET removed_at=?,on_sale=0,revision=revision+1,updated_at=? WHERE product_id=?')
          .run(timestamp, timestamp, product.id);
        updated += 1;
      }
      return { products: products.map(product => this.getProduct(product.id)), removed: true,
        updated, unchanged: products.length - updated };
    });
  }
  restoreProduct(id, { timestamp = new Date().toISOString() } = {}) {
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_PRODUCT_TIME', '商品修改时间无效。');
    return this.transaction(() => {
      const product = this.getProduct(id);
      if (!product) throw new DomainError(404, 'PRODUCT_NOT_FOUND', '未找到这个商品。');
      if (product.removedAt) this.db.prepare('UPDATE products SET removed_at=NULL,on_sale=0,revision=revision+1,updated_at=? WHERE product_id=?')
        .run(timestamp, id);
      return this.getProduct(id);
    });
  }

  importProducts(products, { source = null, lastSyncedAt, syncedAt } = {}) {
    if (!Array.isArray(products)) throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '同步结果必须是完整商品列表。');
    const normalized = products.map(productInput);
    if (new Set(normalized.map(product => product.id)).size !== normalized.length) {
      throw new DomainError(400, 'INVALID_PRODUCT_SNAPSHOT', '飞书商品表存在重复商品编号，请修正后再同步。');
    }
    const timestamp = lastSyncedAt || syncedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(timestamp))) throw new DomainError(400, 'INVALID_SYNC_TIME', '同步时间无效。');
    return this.transaction(() => {
      const existing = new Map(this.listProducts({ includeRemoved: true }).map(product => [product.id, product]));
      const incoming = new Set(normalized.map(product => product.id));
      let added = 0;
      let updated = 0;
      let disabled = 0;
      const upsert = this.db.prepare(`INSERT INTO products
        (product_id, record_id, name, spec, unit, price_cents, category, on_sale, sort, updated_at,image_url,source_json,revision,created_at,original_price_cents,pricing_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?,?,?,?)
        ON CONFLICT(product_id) DO UPDATE SET record_id=excluded.record_id, name=excluded.name,
        spec=excluded.spec, unit=excluded.unit, price_cents=excluded.price_cents, category=excluded.category,
        on_sale=excluded.on_sale, sort=excluded.sort, updated_at=excluded.updated_at,
        image_url=excluded.image_url,source_json=excluded.source_json,revision=excluded.revision,
        original_price_cents=excluded.original_price_cents,pricing_json=excluded.pricing_json`);
      for (const product of normalized) {
        const previous = existing.get(product.id);
        if (previous?.removedAt) continue;
        const changed = previous && (['recordId', ...PRODUCT_FIELDS.filter(key => key !== 'pricing')].some(key => previous[key] !== product[key])
          || JSON.stringify(previous.pricing) !== JSON.stringify(product.pricing)
          || JSON.stringify(previous.source) !== JSON.stringify(product.source));
        if (!previous) added += 1;
        else if (changed) updated += 1;
        if (previous?.onSale && !product.onSale) disabled += 1;
        if (previous && ['name', 'spec', 'unit', 'priceCents'].some(key => previous[key] !== product[key])) {
          this.freezeLegacyOrderProducts(product.id);
        }
        upsert.run(product.id, product.recordId, product.name, product.spec, product.unit,
          product.priceCents, product.category || '其他', product.onSale ? 1 : 0, product.sort, timestamp,
          product.imageUrl, product.source ? JSON.stringify(product.source) : null,
          previous ? previous.revision + Number(Boolean(changed)) : 1, previous?.createdAt || timestamp,
          product.originalPriceCents, JSON.stringify(product.pricing));
      }
      for (const product of existing.values()) {
        if (!incoming.has(product.id) && product.onSale) {
          this.db.prepare('UPDATE products SET on_sale=0, revision=revision+1, updated_at=? WHERE product_id=?').run(timestamp, product.id);
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
      deletedAt: row.deleted_at || null,
      samsStore: row.sams_store_json ? JSON.parse(row.sams_store_json) : null,
      feePolicy: normalizeFeePolicy(row.fee_policy_json ? JSON.parse(row.fee_policy_json) : undefined),
      splitRules: normalizeSplitRules(row.split_rules_json ? JSON.parse(row.split_rules_json) : undefined),
    };
  }
  listBatches({ includeDeleted = false } = {}) {
    return this.db.prepare(`SELECT b.*,c.name AS community_name FROM batches b
      JOIN communities c ON c.id=b.community_id${includeDeleted ? '' : ' WHERE b.deleted_at IS NULL'}
      ORDER BY b.created_at DESC, b.rowid DESC`).all().map(row => this.decodeBatch(row));
  }
  getBatch(code, { includeDeleted = false } = {}) {
    return this.decodeBatch(this.db.prepare(`SELECT b.*,c.name AS community_name FROM batches b
      JOIN communities c ON c.id=b.community_id WHERE b.code=?${includeDeleted ? '' : ' AND b.deleted_at IS NULL'}`).get(code));
  }
  getBatchByRequest(requestId) {
    return this.decodeBatch(this.db.prepare(`SELECT b.*,c.name AS community_name FROM batches b
      JOIN communities c ON c.id=b.community_id WHERE b.request_id=?`).get(requestId));
  }
  createBatch(input) {
    return this.transaction(() => {
      const existing = input.requestId ? this.getBatchByRequest(input.requestId) : this.getBatch(input.code, { includeDeleted: true });
      if (existing) {
        if (existing.deletedAt) throw new DomainError(409, 'BATCH_REQUEST_DELETED', '该期次已删除，请从已删除期次恢复，不能重复创建。');
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
         collecting,cutoff_at,pickup_location,pickup_at,contact_note,image_url_template,feishu_url,created_at,sams_store_json,fee_policy_json,split_rules_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        code, community.id, periodNumber, input.requestId || null, input.requestHash || null,
        input.title || `${community.name} · 第${periodNumber}期`, input.description || '',
        JSON.stringify(input.productIds || []), input.collecting === false ? 0 : 1,
        input.cutoffAt || null, input.pickupLocation || '', input.pickupAt || null,
        input.contactNote || '', input.imageUrlTemplate || '/images/{id}/cover.svg',
        input.feishuUrl || null, input.createdAt || new Date().toISOString(), input.samsStore ? JSON.stringify(input.samsStore) : null,
        JSON.stringify(normalizeFeePolicy(input.feePolicy)), JSON.stringify(normalizeSplitRules(input.splitRules)),
      );
      if (!this.getBatch(this.getMeta('defaultBatch'))) this.setMeta('defaultBatch', code);
      return this.getBatch(code);
    });
  }
  updateBatch(code, patch) {
    return this.transaction(() => {
      const columns = { title: 'title', description: 'description', productIds: 'product_ids_json',
        collecting: 'collecting', cutoffAt: 'cutoff_at', pickupLocation: 'pickup_location',
        pickupAt: 'pickup_at', contactNote: 'contact_note', samsStore: 'sams_store_json', feePolicy: 'fee_policy_json', splitRules: 'split_rules_json' };
      const assignments = [];
      const values = [];
      for (const [key, value] of Object.entries(patch)) {
        if (!columns[key]) throw new DomainError(400, 'INVALID_BATCH_FIELDS', '小区归属与期数不能修改。');
        assignments.push(`${columns[key]}=?`);
        values.push(key === 'splitRules' ? JSON.stringify(normalizeSplitRules(value)) : key === 'feePolicy' ? JSON.stringify(normalizeFeePolicy(value))
          : key === 'productIds' || key === 'samsStore' ? (value === null ? null : JSON.stringify(value)) : key === 'collecting' ? Number(value) : value);
      }
      if (!this.getBatch(code)) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
      const before = Object.hasOwn(patch, 'feePolicy') ? this.listExportLines(code) : null;
      if (assignments.length) this.db.prepare(`UPDATE batches SET ${assignments.join(',')} WHERE code=?`).run(...values, code);
      if (before) this.markBillingChanges(code, before);
      return this.getBatch(code);
    });
  }
  refreshDefaultBatch() {
    if (!this.getBatch(this.getMeta('defaultBatch'))) this.setMeta('defaultBatch', this.listBatches()[0]?.code || null);
  }
  deleteBatch(code, { now = Date.now(), timestamp = new Date(now).toISOString() } = {}) {
    return this.transaction(() => {
      const batch = this.getBatch(code, { includeDeleted: true });
      if (!batch) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
      if (batch.deletedAt) return batch;
      if (batch.collecting && (!batch.cutoffAt || Date.parse(batch.cutoffAt) > now)) {
        throw new DomainError(409, 'BATCH_DELETE_OPEN', '本期仍在收集订单，请先截单再删除。');
      }
      this.db.prepare('UPDATE batches SET deleted_at=? WHERE code=? AND deleted_at IS NULL').run(timestamp, code);
      this.refreshDefaultBatch();
      return this.getBatch(code, { includeDeleted: true });
    });
  }
  restoreBatch(code) {
    return this.transaction(() => {
      const batch = this.getBatch(code, { includeDeleted: true });
      if (!batch) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
      if (batch.deletedAt) this.db.prepare('UPDATE batches SET deleted_at=NULL,collecting=0 WHERE code=?').run(code);
      this.refreshDefaultBatch();
      return this.getBatch(code);
    });
  }

  getSubmission(code, id) {
    const row = this.db.prepare('SELECT * FROM submissions WHERE batch_code=? AND submission_id=?').get(code, id);
    return row ? { submissionId: row.submission_id, batchCode: row.batch_code, phone: row.phone,
      name: row.name, note: row.note, payloadHash: row.payload_hash,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      expectedLines: row.expected_lines, submittedAt: row.submitted_at, status: 'completed', customerHash: row.customer_hash } : null;
  }
  saveSubmission(code, payload, { submittedAt = new Date().toISOString(), hash = payloadHash(payload), lines, customerHash = null } = {}) {
    return this.transaction(() => {
      const before = this.listExportLines(code);
      this.db.prepare(`INSERT INTO submissions(batch_code,submission_id,phone,name,note,payload_hash,payload_json,submitted_at,expected_lines,customer_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(code, payload.submissionId, payload.phone, payload.name,
        payload.note || '', hash, JSON.stringify(payload), submittedAt, payload.items.length, customerHash);
      const insert = this.db.prepare(`INSERT INTO order_lines
        (batch_code,submission_id,line_id,product_id,quantity,status,revision,synced_revision,remote_record_id,snapshot_json)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const item of lines || payload.items) {
        insert.run(code, payload.submissionId, item.lineId || `${payload.submissionId}:${item.productId}`,
          item.productId, item.quantity, item.status || '待采购', item.revision || 1,
          item.syncedRevision || 0, item.remoteRecordId || null, item.snapshot ? JSON.stringify(item.snapshot) : null);
      }
      this.markBillingChanges(code, before);
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
      snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    }));
  }
  updateOrder(code, id, patch) {
    return this.transaction(() => {
      const before = this.listExportLines(code);
      const current = this.listOrderLines(code).find(line => line.recordId === String(id) || line.lineId === id);
      if (!current) throw new DomainError(404, 'ORDER_NOT_FOUND', '本期未找到该订单明细。');
      const quantity = Object.hasOwn(patch, 'quantity') ? patch.quantity : current.quantity;
      const status = Object.hasOwn(patch, 'status') ? patch.status : current.status;
      if (current.snapshot?.split && this.getSplitSettlement(code, current.productId) && quantity !== current.quantity) {
        throw new DomainError(409, 'SPLIT_QUANTITY_LOCKED', '拼份已确认采购，不能修改请求份数；可调整采购状态。');
      }
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 999 || !ORDER_STATUSES.includes(status)) {
        throw new DomainError(400, 'INVALID_ORDER_UPDATE', '数量需为 0 至 999 的整数，状态需为预设状态。');
      }
      if (quantity !== current.quantity || status !== current.status) this.db.prepare(`UPDATE order_lines
        SET quantity=?,status=?,revision=revision+1,export_error=NULL WHERE batch_code=? AND id=?`).run(quantity, status, code, Number(current.recordId));
      this.markBillingChanges(code, before, new Set([current.lineId]));
      return this.listOrderLines(code).find(line => line.recordId === current.recordId);
    });
  }

  markBillingChanges(code, before, alreadyChanged = new Set(), { includeDeleted = false } = {}) {
    const previous = new Map(before.map(line => [line.lineId, line]));
    const mark = this.db.prepare('UPDATE order_lines SET revision=revision+1,export_error=NULL WHERE batch_code=? AND line_id=?');
    for (const line of this.listExportLines(code, { includeDeleted })) {
      const old = previous.get(line.lineId);
      if (old && (old.feeRateBps !== line.feeRateBps || old.feeCents !== line.feeCents || old.amountCents !== line.amountCents)
        && !alreadyChanged.has(line.lineId)) mark.run(code, line.lineId);
    }
  }

  listExportLines(code, { onlyDirty = false, includeDeleted = false } = {}) {
    const batch = this.getBatch(code, { includeDeleted });
    if (!batch) throw new DomainError(404, 'BATCH_NOT_FOUND', '未找到这个团购。');
    const products = new Map(this.listProducts({ includeRemoved: true }).map(product => [product.id, product]));
    const lines = this.listOrderLines(code).map(line => {
      const product = line.snapshot || products.get(line.productId);
      const split = line.snapshot?.split ? splitLine(line, this.getSplitSettlement(code, line.productId)) : undefined;
      const billableQuantity = split ? split.formedQuantity : line.quantity;
      return {
        ...line, version: line.revision, syncedVersion: line.syncedRevision,
        communityName: batch.communityName, periodNumber: batch.periodNumber, periodLabel: batch.periodLabel,
        product: product || null, productName: product?.name || `商品 ${line.productId}（资料缺失）`,
        spec: product?.spec || '', unit: product?.unit || '', priceCents: product?.priceCents ?? null,
        ...(split ? { split, pendingQuantity: split.pendingQuantity,
          pendingGoodsCents: splitAmount(product.priceCents, split.pendingQuantity) } : {}),
        amountCents: EXCLUDED.has(line.status) ? 0 : product?.priceCents == null ? null
          : cents(BigInt(product.priceCents) * BigInt(billableQuantity)),
      };
    });
    const destinationChanged = onlyDirty && !this.isCommunityOrderDestinationCurrent(code, batch);
    return billLines(lines, { feePolicy: batch.feePolicy }).filter(line => !onlyDirty || destinationChanged || line.revision !== line.syncedRevision);
  }
  getSplitSettlement(code, productId) {
    const row = this.db.prepare('SELECT result_json FROM split_settlements WHERE batch_code=? AND product_id=?').get(code, productId);
    return row ? JSON.parse(row.result_json) : null;
  }
  saveSplitSettlement(code, productId, result) {
    return this.transaction(() => {
      const before = this.listExportLines(code);
      this.db.prepare('INSERT INTO split_settlements(batch_code,product_id,result_json) VALUES(?,?,?)')
        .run(code, productId, JSON.stringify(result));
      const changed = new Set(this.listOrderLines(code).filter(line => line.productId === productId && line.snapshot?.split).map(line => line.lineId));
      this.db.prepare('UPDATE order_lines SET revision=revision+1,export_error=NULL WHERE batch_code=? AND product_id=?')
        .run(code, productId);
      this.markBillingChanges(code, before, changed);
      return result;
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
      const existing = this.getBatch(config.code, { includeDeleted: true });
      if (existing) return { batch: existing, imported: false, orderLines: 0 };
      const normalized = products.map(productInput);
      if (!this.listProducts().length) this.importProducts(normalized, { source: config });
      else {
        // Bootstrap another old batch without replacing the shared current
        // catalog that may already have been manually synchronized.
        const insert = this.db.prepare(`INSERT OR IGNORE INTO products
          (product_id,record_id,name,spec,unit,price_cents,category,on_sale,sort,updated_at,image_url,source_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const timestamp = new Date().toISOString();
        for (const product of normalized) insert.run(product.id, product.recordId, product.name, product.spec,
          product.unit, product.priceCents, product.category || '其他', Number(product.onSale), product.sort, timestamp,
          product.imageUrl, product.source ? JSON.stringify(product.source) : null, timestamp);
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
