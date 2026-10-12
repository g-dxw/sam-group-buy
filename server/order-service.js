import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
const STATUSES = ['待采购', '已买到', '缺货', '已领取', '已取消'];
const EXCLUDED = new Set(['缺货', '已取消']);
const MAX_LINES = 200;

export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizePhone(input) {
  let phone = String(input ?? '').replace(/[\s()（）-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  else if (phone.startsWith('0086')) phone = phone.slice(4);
  else if (/^86\d{11}$/.test(phone)) phone = phone.slice(2);
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new DomainError(400, 'INVALID_PHONE', '请填写有效的中国大陆手机号码。');
  }
  return phone;
}

function apiError(error) {
  if (error instanceof DomainError) return error;
  if (error?.resourceMissing === true || error?.status === 410
    || ['RESOURCE_NOT_FOUND', 'BASE_NOT_FOUND', 'TABLE_NOT_FOUND'].includes(error?.code)) {
    return new DomainError(410, 'BATCH_ENDED', '本次收集已结束。');
  }
  if (error?.status === 401 || error?.status === 403
    || ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'AUTH_EXPIRED'].includes(error?.code)) {
    return new DomainError(503, 'FEISHU_ACCESS_UNAVAILABLE', '飞书访问暂时不可用，请稍后再试或联系组织者。');
  }
  return new DomainError(503, 'FEISHU_UNAVAILABLE', '暂时无法连接飞书，请稍后再试。');
}

function publicError(error) {
  const safe = apiError(error);
  // Persist only diagnostic IDs. An updated catalog may be sent in the direct
  // validation response, but must not become a historical-price snapshot in
  // the durable outbox.
  const details = safe.details?.catalog ? { productIds: safe.details.productIds } : safe.details;
  return { code: safe.code, message: safe.message, ...(details ? { details } : {}) };
}

function publicSubmission(entry) {
  return {
    submissionId: entry.submissionId,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.status === 'completed' ? { receipt: { submissionId: entry.submissionId } } : {}),
  };
}

function imageUrl(batch, id) {
  const template = batch.imageUrlTemplate || '/images/products/{id}.svg';
  if (!template.includes('{id}') || (!/^https?:\/\//i.test(template)
    && (!template.startsWith('/') || template.startsWith('//')))) return '/images/placeholder.svg';
  return template.replaceAll('{id}', encodeURIComponent(id));
}

function normalizePayload(payload) {
  if (!payload || !UUID.test(payload.submissionId ?? '')) {
    throw new DomainError(400, 'INVALID_SUBMISSION_ID', '提交编号无效，请刷新页面后重试。');
  }
  const phone = normalizePhone(payload.phone);
  const name = String(payload.name ?? '').trim();
  const note = String(payload.note ?? '').trim();
  if (!name || name.length > 40) throw new DomainError(400, 'INVALID_NAME', '请填写姓名或群昵称（最多 40 字）。');
  if (note.length > 500) throw new DomainError(400, 'INVALID_NOTE', '备注最多 500 字。');
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > MAX_LINES) {
    throw new DomainError(400, 'INVALID_ITEMS', '请选择商品，一次最多提交 200 种商品。');
  }
  const seen = new Set();
  const items = payload.items.map((item) => {
    if (!item || typeof item.productId !== 'string' || !PRODUCT_ID.test(item.productId)
      || seen.has(item.productId)) throw new DomainError(400, 'INVALID_ITEMS', '商品编号无效或重复。');
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) {
      throw new DomainError(400, 'INVALID_QUANTITY', '商品数量必须为 1 至 999 的整数。');
    }
    if (typeof item.version !== 'string' || !/^[0-9a-f]{64}$/.test(item.version)) {
      throw new DomainError(400, 'INVALID_PRODUCT_VERSION', '商品信息不完整，请刷新商品列表。');
    }
    seen.add(item.productId);
    return { productId: item.productId, quantity: item.quantity, version: item.version };
  }).sort((a, b) => a.productId.localeCompare(b.productId));
  return { submissionId: payload.submissionId.toLowerCase(), phone, name, note, items };
}

export function completeGroup(lines) {
  if (!lines.length) return false;
  const expected = lines[0].expectedLines;
  return Number.isSafeInteger(expected) && expected > 0 && expected <= MAX_LINES
    && /^1[3-9]\d{9}$/.test(lines[0].phone ?? '')
    && lines.length === expected
    && new Set(lines.map((line) => line.lineId)).size === lines.length
    && lines.every((line) => UUID.test(line.submissionId ?? '') && PRODUCT_ID.test(line.productId ?? '')
      && line.lineId === `${line.submissionId}:${line.productId}` && line.expectedLines === expected && line.phone === lines[0].phone
      && line.syncStatus === '已确认' && STATUSES.includes(line.status)
      && Number.isSafeInteger(line.quantity) && line.quantity >= 0 && line.quantity <= 999);
}

export class OrderService {
  constructor({ repository, journal, now = () => new Date(), retryDelayMs = 5000 }) {
    this.repository = repository;
    this.journal = journal;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.queues = new Map();
  }

  async getCatalog(batch, { allProducts = false } = {}) {
    try {
      const [rawProducts, settings] = await Promise.all([
        this.repository.readProducts(batch), this.repository.readSettings(batch),
        this.repository.verifyOrderTable?.(batch),
      ]);
      const seen = new Set();
      const products = rawProducts.map((product) => {
        if (!PRODUCT_ID.test(product.id ?? '') || seen.has(product.id)
          || !product.name || !product.spec || !product.unit
          || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0
          || product.priceCents > 100_000_000 || typeof product.onSale !== 'boolean') {
          throw new DomainError(503, 'CATALOG_INVALID', '商品表有重复编号或未填写完整，请联系组织者。');
        }
        seen.add(product.id);
        return {
          id: product.id, name: product.name, spec: product.spec, unit: product.unit,
          priceCents: product.priceCents, category: product.category || '其他',
          onSale: product.onSale, sort: Number(product.sort) || 0,
          imageUrl: imageUrl(batch, product.id),
          version: hash([product.id, product.name, product.spec, product.unit, product.priceCents, product.onSale]),
        };
      }).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
      if (typeof settings.collecting !== 'boolean' || (settings.cutoffAt && !Number.isFinite(Date.parse(settings.cutoffAt)))) {
        throw new DomainError(503, 'SETTINGS_INVALID', '本期设置有误，请联系组织者。');
      }
      return {
        batch: {
          code: batch.code, title: settings.title || batch.name || '本期代购',
          description: settings.description || '',
          collecting: settings.collecting && (!settings.cutoffAt || Date.parse(settings.cutoffAt) > this.now().getTime()),
          cutoffAt: settings.cutoffAt || null, contactNote: settings.contactNote || '',
          communityName: settings.communityName || batch.communityName || '',
          periodLabel: settings.periodLabel || batch.periodLabel || '',
          pickupLocation: settings.pickupLocation || '', pickupAt: settings.pickupAt || null,
        }, products: allProducts || !Array.isArray(settings.productIds) ? products
          : products.filter(product => settings.productIds.includes(product.id)),
      };
    } catch (error) { throw apiError(error); }
  }

  async submit(batch, input) {
    const payload = normalizePayload(input);
    const payloadHash = hash(payload);
    const existing = this.journal.get(batch.code, payload.submissionId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new DomainError(409, 'SUBMISSION_CONFLICT', '此提交编号已用于另一份订单，请重新确认后提交。');
      }
      this.schedule(batch);
      return publicSubmission(existing);
    }
    const catalog = await this.getCatalog(batch);
    if (!catalog.batch.collecting) throw new DomainError(409, 'COLLECTION_CLOSED', '本期已停止收集，仍可查询已提交订单。');
    const products = new Map(catalog.products.map((product) => [product.id, product]));
    const changed = payload.items.filter((item) => {
      const current = products.get(item.productId);
      return !current || !current.onSale || current.version !== item.version;
    });
    if (changed.length) throw new DomainError(409, 'PRODUCT_CHANGED', '商品价格、规格或在售状态已变化，请重新确认。', {
      productIds: changed.map((item) => item.productId), catalog,
    });
    const entry = {
      batchCode: batch.code, submissionId: payload.submissionId, payloadHash, payload,
      status: 'pending', phase: 'ready', createSettled: true,
      submittedAt: this.now().toISOString(), createdAt: this.now().getTime(),
    };
    if (!this.journal.insert(entry)) {
      const raced = this.journal.get(batch.code, payload.submissionId);
      if (raced.payloadHash !== payloadHash) throw new DomainError(409, 'SUBMISSION_CONFLICT', '此提交编号已用于另一份订单。');
      this.schedule(batch);
      return publicSubmission(raced);
    }
    this.schedule(batch);
    return publicSubmission(this.journal.get(batch.code, payload.submissionId));
  }

  getSubmission(batch, id) {
    if (!UUID.test(id ?? '')) throw new DomainError(400, 'INVALID_SUBMISSION_ID', '提交编号无效。');
    const entry = this.journal.get(batch.code, id.toLowerCase());
    if (!entry) throw new DomainError(404, 'SUBMISSION_NOT_FOUND', '未找到这次提交。');
    this.schedule(batch);
    return publicSubmission(entry);
  }

  async queryOrders(batch, rawPhone) {
    const phone = normalizePhone(rawPhone);
    const catalog = await this.getCatalog(batch, { allProducts: true });
    let lines;
    try { lines = await this.repository.readOrderLines(batch, { phone }); }
    catch (error) { throw apiError(error); }
    const groups = new Map();
    for (const line of lines) {
      // Never rely only on a remote filter when exposing a phone-based query.
      if (line.phone !== phone) continue;
      const key = line.submissionId || `invalid:${line.recordId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    const pending = new Set();
    const aggregate = new Map();
    const products = new Map(catalog.products.map((product) => [product.id, product]));
    for (const [submissionId, group] of groups) {
      if (this.journal.get(batch.code, submissionId)?.phase === 'abandoned') continue;
      if (!completeGroup(group)) { pending.add(submissionId); continue; }
      for (const line of group) {
        if (!aggregate.has(line.productId)) {
          const product = products.get(line.productId);
          aggregate.set(line.productId, product ? {
            id: product.id, name: product.name, spec: product.spec, unit: product.unit,
            imageUrl: product.imageUrl, priceCents: product.priceCents,
            quantity: 0, amountCents: 0, statuses: [],
          } : {
            id: line.productId, name: `商品 ${line.productId}（资料已移除）`, spec: '', unit: '',
            imageUrl: imageUrl(batch, line.productId), priceCents: null,
            quantity: 0, amountCents: null, statuses: [], missing: true,
          });
        }
        const item = aggregate.get(line.productId);
        item.quantity += line.quantity;
        let status = item.statuses.find((part) => part.status === line.status);
        if (!status) { status = { status: line.status, quantity: 0 }; item.statuses.push(status); }
        status.quantity += line.quantity;
        if (item.amountCents !== null && !EXCLUDED.has(line.status)) item.amountCents += item.priceCents * line.quantity;
      }
    }
    for (const entry of this.journal.listUnfinished([batch.code])) {
      if (entry.payload.phone === phone) pending.add(entry.submissionId);
    }
    const result = [...aggregate.values()].map((item) => ({
      ...item, statuses: item.statuses.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)),
    }));
    this.schedule(batch);
    return {
      phone, products: result,
      totalCents: result.some((item) => item.amountCents === null) ? null : result.reduce((sum, item) => sum + item.amountCents, 0),
      pendingCount: pending.size, hasOrders: result.length > 0, contactNote: catalog.batch.contactNote,
    };
  }

  recover(batches) {
    const list = Array.isArray(batches) ? batches : Object.values(batches);
    for (const batch of list) {
      // A restart performs one immediate recovery pass, even if a previous
      // process persisted a short polling cooldown. Uncertain creates are
      // still reconciled by reads and are never recreated.
      for (const entry of this.journal.listUnfinished([batch.code])) {
        this.journal.update(batch.code, entry.submissionId, { nextCheckAt: 0 });
      }
      this.schedule(batch);
    }
  }

  schedule(batch) {
    const unfinished = this.journal.listUnfinished([batch.code]);
    if (!unfinished.length || unfinished[0].nextCheckAt > this.now().getTime()) return;
    const active = this.queues.get(batch.code);
    if (active) { active.again = true; return; }
    const task = { again: false, promise: null };
    task.promise = Promise.resolve().then(() => this.drain(batch)).catch((error) => {
      const entry = this.journal.listUnfinished([batch.code])[0];
      if (entry) this.handleWriteError(entry, error);
    }).finally(() => {
      this.queues.delete(batch.code);
      if (task.again) this.schedule(batch);
    });
    this.queues.set(batch.code, task);
  }

  async drain(batch) {
    while (true) {
      const entry = this.journal.listUnfinished([batch.code])[0];
      if (!entry || entry.nextCheckAt > this.now().getTime()) return;
      await this.process(batch, entry);
      const current = this.journal.get(batch.code, entry.submissionId);
      // An unresolved write blocks further mutations only for this batch.
      if (!['completed', 'failed'].includes(current.status)) return;
    }
  }

  expectedLines(entry) {
    return entry.payload.items.map((item) => ({
      lineId: `${entry.submissionId}:${item.productId}`, submissionId: entry.submissionId,
      phone: entry.payload.phone, name: entry.payload.name, productId: item.productId,
      quantity: item.quantity, note: entry.payload.note, status: '待采购',
      syncStatus: '待确认', expectedLines: entry.payload.items.length,
      submittedAt: entry.submittedAt,
    }));
  }

  async createMissing(batch, entry, lines) {
    // Persist the ambiguous state BEFORE sending the request. A process crash
    // can never turn an in-flight create back into a fresh create.
    this.journal.update(batch.code, entry.submissionId, {
      status: 'processing', phase: 'creating', createSettled: false, error: null,
    });
    try {
      const created = await this.repository.createOrderLines(batch, lines);
      const ids = Array.isArray(created) ? created.map((line) => line.lineId).filter(Boolean) : [];
      // A successful batch response acknowledges every requested row even if
      // the adapter omits line IDs. A later stale read must not recreate them.
      const acknowledged = ids.length ? ids : lines.map((line) => line.lineId);
      this.journal.update(batch.code, entry.submissionId, {
        phase: 'reconciling-create', createSettled: true,
        acknowledgedLineIds: [...new Set([...entry.acknowledgedLineIds, ...acknowledged])],
      });
    } catch (error) {
      if (apiError(error).status === 410) {
        this.handleWriteError(entry, error);
        return;
      }
      const settled = error?.outcome === 'settled' && !error?.uncertain;
      this.journal.update(batch.code, entry.submissionId, {
        status: 'reconciling', phase: 'reconciling-create', createSettled: settled,
        error: publicError(error),
      });
    }
  }

  defer(entry, error) {
    this.journal.update(entry.batchCode, entry.submissionId, {
      status: 'reconciling', error,
      nextCheckAt: this.now().getTime() + this.retryDelayMs,
    });
  }

  handleWriteError(entry, error) {
    const safe = apiError(error);
    if (safe.status === 410) {
      // A confirmed deletion is terminal even after a partially written
      // submission. Keep its journal for inspection, but never rebuild rows
      // into a replacement table or keep reporting that they are syncing.
      this.journal.update(entry.batchCode, entry.submissionId, {
        status: 'failed', phase: 'ended', error: publicError(safe), nextCheckAt: 0,
      });
    } else this.defer(entry, publicError(safe));
  }

  async process(batch, initial) {
    let entry = initial;
    if (entry.phase === 'ready') {
      // Check again at the write boundary: a queued order must not quietly
      // bypass a cutoff or an intervening price/specification change.
      try {
        const catalog = await this.getCatalog(batch);
        if (!catalog.batch.collecting) throw new DomainError(409, 'COLLECTION_CLOSED', '本期已停止收集，请联系组织者。');
        const current = new Map(catalog.products.map((product) => [product.id, product]));
        const changed = entry.payload.items.filter((item) => !current.get(item.productId)?.onSale
          || current.get(item.productId)?.version !== item.version);
        if (changed.length) throw new DomainError(409, 'PRODUCT_CHANGED', '排队期间商品信息发生变化，请重新确认后提交。', {
          productIds: changed.map((item) => item.productId), catalog,
        });
      } catch (error) {
        const safe = apiError(error);
        if (safe.status === 410) this.handleWriteError(entry, safe);
        else if (safe.status === 409) {
          this.journal.update(batch.code, entry.submissionId, { status: 'failed', error: publicError(safe) });
        } else this.defer(entry, publicError(safe));
        return;
      }
      await this.createMissing(batch, entry, this.expectedLines(entry));
      entry = this.journal.get(batch.code, entry.submissionId);
      if (entry.status === 'failed') return;
    } else if (entry.phase === 'creating') {
      // Recovery after a crash: whether the remote create committed is unknown.
      entry = this.journal.update(batch.code, entry.submissionId, {
        phase: 'reconciling-create', status: 'reconciling', createSettled: false,
      });
    }

    for (let pass = 0; pass < 3; pass += 1) {
      let remote;
      try { remote = await this.repository.readOrderLines(batch, { submissionId: entry.submissionId }); }
      catch (error) { this.handleWriteError(entry, error); return; }
      const expected = this.expectedLines(entry);
      const wanted = new Map(expected.map((line) => [line.lineId, line]));
      const ids = new Set();
      const invalid = remote.some((line) => {
        const expectedLine = wanted.get(line.lineId);
        const bad = !expectedLine || ids.has(line.lineId) || !line.recordId
          || line.submissionId !== entry.submissionId || line.expectedLines !== expected.length
          || line.productId !== expectedLine.productId || line.phone !== entry.payload.phone
          || !STATUSES.includes(line.status) || !Number.isSafeInteger(line.quantity)
          || line.quantity < 0 || line.quantity > 999;
        ids.add(line.lineId);
        return bad;
      });
      if (invalid) {
        this.defer(entry, { code: 'ORDER_REQUIRES_REVIEW', message: '订单明细存在重复或不一致，请联系组织者核查。' });
        return;
      }
      const missing = expected.filter((line) => !ids.has(line.lineId));
      if (missing.length) {
        const acknowledged = new Set(entry.acknowledgedLineIds);
        if (!entry.createSettled || missing.some((line) => acknowledged.has(line.lineId))) {
          this.defer(entry, { code: 'UNCERTAIN_WRITE', message: '正在核对提交结果，请勿重复下单；稍后查询或联系组织者。' });
          return;
        }
        if (pass === 2) {
          this.defer(entry, { code: 'INCOMPLETE_WRITE', message: '部分明细仍在同步，请稍后查询。' });
          return;
        }
        await this.createMissing(batch, entry, missing);
        entry = this.journal.get(batch.code, entry.submissionId);
        if (entry.status === 'failed') return;
        continue;
      }
      if (completeGroup(remote)) {
        this.journal.update(batch.code, entry.submissionId, {
          status: 'completed', phase: 'complete', error: null, nextCheckAt: 0,
        });
        return;
      }
      const toConfirm = remote.filter((line) => line.syncStatus !== '已确认').map((line) => line.recordId);
      this.journal.update(batch.code, entry.submissionId, { status: 'processing', phase: 'confirming', error: null });
      try { await this.repository.confirmOrderLines(batch, toConfirm); }
      catch (error) { this.handleWriteError(entry, error); return; }
      // Read again to verify the entire group; a successful update is not a
      // substitute for a durable, complete receipt.
      entry = this.journal.update(batch.code, entry.submissionId, { phase: 'verifying' });
    }
    this.defer(entry, { code: 'CONFIRMATION_PENDING', message: '订单确认仍在同步，请稍后查询。' });
  }

  async waitForIdle(batch) {
    while (true) {
      const tasks = batch ? [this.queues.get(batch.code)].filter(Boolean) : [...this.queues.values()];
      if (!tasks.length) return;
      await Promise.all(tasks.map((task) => task.promise));
    }
  }
}
