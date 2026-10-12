import { randomUUID } from 'node:crypto';

const locks = new WeakMap();
const TABLE_ID = /^tbl[A-Za-z0-9]{3,125}$/;
const OPTIONS = { 处理状态: ['待采购', '已买到', '缺货', '已领取', '已取消'], 同步状态: ['待确认', '已确认'] };
const INTEGER_FIELDS = new Set(['数量', '预期明细数', '数据版本']);
export const communityTableMarker = communityId => `sam-group-orders:v1:${communityId}`;
export const communityTableName = communityName => `${communityName} · 下单明细`;
export class CommunityTableError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'CommunityTableError'; }
}
const fail = (code, message) => { throw new CommunityTableError(code, message); };

export function communityOrderFields(communityId, exportFields, feeSchema, splitSchema) {
  const numberFields = new Set(['数量', '预期明细数', '同步单价', '同步金额', '数据版本']);
  const schema = { ...Object.fromEntries(exportFields.map(name => [name, numberFields.has(name) ? 'number'
    : name === '提交时间' ? 'datetime' : OPTIONS[name] ? 'select' : 'text'])), ...feeSchema, ...splitSchema };
  return Object.entries(schema).map(([name, type]) => ({ name, type,
    ...(name === '明细编号' ? { description: communityTableMarker(communityId) } : {}),
    ...(type === 'number' ? { style: { type: 'plain', precision: INTEGER_FIELDS.has(name) ? 0 : 2 } } : {}),
    ...(type === 'datetime' ? { style: { format: 'yyyy-MM-dd HH:mm' } } : {}),
    ...(type === 'select' ? { multiple: false, options: OPTIONS[name].map(name => ({ name })) } : {}),
  }));
}

// Table creation is separate from record export. A durable attempt prevents an
// uncertain create from producing another table after a restart or retry.
export class FeishuCommunityTables {
  constructor({ store, larkCall, fields, backoffMs = [500, 1500, 3000] }) {
    Object.assign(this, { store, larkCall, fields, backoffMs });
    if (!locks.has(store)) locks.set(store, new Map());
    this.locks = locks.get(store);
  }
  ensure(source, batch, beforeWrite = () => {}) {
    const key = `${source.baseToken}:${batch.communityId}`;
    if (this.locks.has(key)) return this.locks.get(key);
    const job = Promise.resolve().then(() => this.provision(source, batch, beforeWrite))
      .finally(() => this.locks.delete(key));
    this.locks.set(key, job);
    return job;
  }
  async list(baseToken) {
    const tables = []; const ids = new Set(); let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.larkCall(['base', '+table-list', '--base-token', baseToken, '--limit', '100', '--offset', String(offset)]);
      const entries = result?.tables || result?.items;
      if (!Array.isArray(entries)) fail('COMMUNITY_TABLE_LIST_INVALID', '飞书群表目录无法确认，未创建新表。');
      for (const item of entries) {
        const type = item?.type || item?.block_type;
        if (!result.tables && !type) fail('COMMUNITY_TABLE_LIST_INVALID', '飞书群表目录缺少类型，未创建新表。');
        if (type && type !== 'table') continue;
        const id = item.id || item.table_id; const name = item.name || item.table_name;
        if (!TABLE_ID.test(id || '') || ids.has(id) || typeof name !== 'string' || !name) {
          fail('COMMUNITY_TABLE_LIST_INVALID', '飞书群表目录不完整或重复，未创建新表。');
        }
        ids.add(id); tables.push({ id, name });
      }
      offset += entries.length;
      const more = result.has_more ?? result.hasMore;
      if (more === false || more === undefined && Number.isSafeInteger(result.total) && offset >= result.total
        || more === undefined && result.total === undefined && entries.length < 100) return tables;
      if (!entries.length) break;
    }
    fail('COMMUNITY_TABLE_LIST_INVALID', '飞书群表目录读取未完成，未创建新表。');
  }
  async verify(source, batch, table, expectedFields) {
    const result = await this.larkCall(['base', '+table-get', '--base-token', source.baseToken, '--table-id', table.id]);
    const detail = result?.table || result;
    const id = detail?.id || detail?.table_id;
    const name = detail?.name || detail?.table_name;
    const fields = result?.fields || detail?.fields;
    if (id && id !== table.id || name && name !== table.name || !Array.isArray(fields)) {
      fail('COMMUNITY_TABLE_SCHEMA_INVALID', '飞书群表信息不一致，未写入订单。');
    }
    const marker = fields.filter(field => field.name === '明细编号');
    if (marker.length !== 1 || marker[0].description !== communityTableMarker(batch.communityId)) {
      fail('COMMUNITY_TABLE_OWNER_CONFLICT', '同名订单表未标记为本群所属，未写入或重新建表；请核对飞书表。');
    }
    for (const expected of expectedFields) {
      const matches = fields.filter(field => field.name === expected.name);
      if (matches.length !== 1 || matches[0].type !== expected.type) {
        fail('COMMUNITY_TABLE_SCHEMA_INVALID', `群订单表的「${expected.name}」需为唯一的 ${expected.type} 字段，未写入订单。`);
      }
      if (expected.type === 'select') {
        const value = matches[0]; const options = value.options?.map(option => typeof option === 'string' ? option : option.name);
        if (value.multiple !== false || !Array.isArray(options) || new Set(options).size !== options.length
          || OPTIONS[expected.name].some(name => !options.includes(name))) {
          fail('COMMUNITY_TABLE_SCHEMA_INVALID', `群订单表的「${expected.name}」需包含完整单选状态，未写入订单。`);
        }
      }
    }
  }
  async provision(source, batch, beforeWrite) {
    if (!batch.communityId || !batch.communityName?.trim()) fail('COMMUNITY_TABLE_BATCH_INVALID', '本期缺少小区或群归属，无法创建订单表。');
    const { baseToken } = source; const { communityId } = batch;
    const tableName = communityTableName(batch.communityName);
    const expectedFields = this.fields(communityId);
    let state = this.store.getCommunityOrderTable(baseToken, communityId)
      || { baseToken, communityId, tableId: null, tableName, status: 'pending' };
    const save = () => this.store.setCommunityOrderTable(baseToken, communityId, state);
    if (state.baseToken !== baseToken || state.communityId !== communityId || state.tableName !== tableName
      || state.tableId && !TABLE_ID.test(state.tableId)) fail('COMMUNITY_TABLE_BINDING_INVALID', '本群订单表绑定不一致，请先核查，未写入飞书。');
    try {
      const find = async () => {
        const tables = await this.list(baseToken);
        const sameName = tables.filter(table => table.name === tableName);
        if (sameName.length > 1) fail('COMMUNITY_TABLE_DUPLICATE', '飞书存在多个同名群订单表，未写入或重复创建，请先核对。');
        if (state.tableId) {
          const bound = tables.find(table => table.id === state.tableId);
          if (!bound || bound.name !== tableName || sameName[0]?.id !== bound.id) {
            fail('COMMUNITY_TABLE_BOUND_MISSING', '已绑定群订单表暂时不可见或名称改变，未重新建表，请核对后重试。');
          }
          return bound;
        }
        return sameName[0] || null;
      };
      let table = await find();
      if (!table && state.createAttempt && state.createAttempt.outcome !== 'settled') {
        for (const delay of this.backoffMs) {
          await new Promise(resolve => setTimeout(resolve, delay));
          table = await find(); if (table) break;
        }
        if (!table) fail('COMMUNITY_TABLE_CREATE_PENDING', '上次群订单表创建结果尚未确认，已停止重复建表；请稍后同步核查。');
      }
      if (!table) {
        beforeWrite();
        state = { ...state, status: 'pending', error: null,
          createAttempt: { attemptId: randomUUID(), outcome: 'unknown', startedAt: new Date().toISOString() } };
        save();
        let created;
        try {
          created = await this.larkCall(['base', '+table-create', '--base-token', baseToken, '--name', tableName,
            '--fields', JSON.stringify(expectedFields)], { write: true });
        } catch (error) {
          state.createAttempt.outcome = error.uncertain === false || error.outcome === 'settled' ? 'settled' : 'unknown';
          save(); throw error;
        }
        const id = created?.table?.id || created?.table?.table_id || created?.table_id || created?.id;
        if (!TABLE_ID.test(id || '')) fail('COMMUNITY_TABLE_CREATE_PENDING', '飞书未确认群订单表创建结果，已停止重复建表；请稍后同步核查。');
        state.createAttempt.ackTableId = id; save();
        table = await find();
        for (const delay of this.backoffMs) {
          if (table) break;
          await new Promise(resolve => setTimeout(resolve, delay)); table = await find();
        }
        if (!table) fail('COMMUNITY_TABLE_CREATE_PENDING', '群订单表已提交，等待飞书完整可见；请稍后同步核查。');
        if (table.id !== id) fail('COMMUNITY_TABLE_OWNER_CONFLICT', '群表创建返回与读回表ID不一致，请核对，未写入订单。');
      }
      if (state.createAttempt?.ackTableId && table.id !== state.createAttempt.ackTableId) {
        fail('COMMUNITY_TABLE_OWNER_CONFLICT', '群表创建返回与读回表ID不一致，请核对，未写入订单。');
      }
      await this.verify(source, batch, table, expectedFields);
      beforeWrite();
      state = { ...state, tableId: table.id, status: 'ready', error: null, createAttempt: null };
      save(); return state;
    } catch (error) {
      state.status = error.code === 'COMMUNITY_TABLE_CREATE_PENDING' ? 'pending' : 'error';
      state.error = { code: String(error.code || 'COMMUNITY_TABLE_FAILED'), message: error instanceof CommunityTableError
        ? error.message : '群订单表暂时无法确认，请检查飞书权限或稍后同步；本地订单保留。' };
      save();
      if (error instanceof CommunityTableError) throw error;
      throw new CommunityTableError(state.error.code, state.error.message);
    }
  }
}
