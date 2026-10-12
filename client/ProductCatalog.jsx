import { useMemo, useRef, useState, useEffect } from 'react';
import ProductDescription from './ProductDescription.jsx';

const MAX_SELECTED = 200;
const money = cents => Number.isSafeInteger(cents) ? `¥${(cents / 100).toFixed(2)}` : '未提供';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未备份';
const isSams = product => product.source?.platform === 'samsclub_cn';
const isCustomerSelected = product => isSams(product) && product.source?.customerSelected === true;
const backedUp = product => product.backupStatus === 'backed_up';
const sourceLabel = product => isSams(product)
  ? [isCustomerSelected(product) ? '顾客自选' : null, product.source.storeName || `山姆门店 ${product.source.storeId}`, product.source.method === 'rank' ? product.source.rankName : null].filter(Boolean).join(' · ')
  : product.source?.platform === 'feishu' || product.recordId ? '历史飞书商品' : '本地商品';
const productSummary = product => {
  const description = typeof product.source?.description === 'string' ? product.source.description.trim() : '';
  const spec = typeof product.spec === 'string' ? product.spec.trim() : '';
  return description || (spec !== '详见商品名称' ? spec : '');
};

export function safeProductImage(value) {
  if (typeof value !== 'string' || !value.trim()) return '/images/placeholder.svg';
  if (value.startsWith('/images/') && !value.includes('\\')) return value;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : '/images/placeholder.svg'; }
  catch { return '/images/placeholder.svg'; }
}

export function CatalogImage({ src, name, className }) {
  return <img className={className} src={safeProductImage(src)} alt={name || '商品图片'} loading="lazy" decoding="async" onError={event => { if (!event.currentTarget.src.endsWith('/images/placeholder.svg')) event.currentTarget.src = '/images/placeholder.svg'; }} />;
}

function EditProduct({ product, api, onClose, onSaved }) {
  const dialog = useRef(null);
  const firstField = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => ({
    name: product.name || '', spec: product.spec || '', unit: product.unit || '份',
    price: Number.isSafeInteger(product.priceCents) ? (product.priceCents / 100).toFixed(2) : '',
    onSale: Boolean(product.onSale), sort: String(product.sort ?? 0), imageUrl: product.imageUrl || '',
  }));

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.showModal();
    firstField.current?.focus();
    return () => { dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);

  function field(name, value) { setDraft(previous => ({ ...previous, [name]: value })); setError(''); }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const priceText = draft.price.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) { setError('售价请填写非负金额，最多两位小数。'); return; }
    const [whole, decimal = ''] = priceText.split('.');
    const priceCents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
    if (!Number.isSafeInteger(priceCents) || priceCents > 100_000_000) { setError('售价需在 0 至 1,000,000 元之间。'); return; }
    if (!Number.isFinite(Number(draft.sort))) { setError('排序请填写有效数字。'); return; }
    if (draft.imageUrl.trim() && safeProductImage(draft.imageUrl.trim()) === '/images/placeholder.svg' && draft.imageUrl.trim() !== '/images/placeholder.svg') { setError('请填写有效的 http/https 图片链接，或 /images/ 开头的本地路径。'); return; }
    setSaving(true); setError('');
    try {
      const result = await api(`/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: JSON.stringify({
        name: draft.name.trim(), spec: draft.spec.trim(), unit: draft.unit.trim(), priceCents,
        onSale: draft.onSale, sort: Number(draft.sort), imageUrl: draft.imageUrl.trim(),
      }) });
      await onSaved(result.product);
      onClose();
    } catch (error) { setError(error.message || '商品未保存，请稍后重试。'); }
    finally { setSaving(false); }
  }

  return <dialog className="catalog-editor" ref={dialog} onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} aria-labelledby="catalog-edit-title">
    <div className="catalog-editor-header"><div><p className="admin-eyebrow">本地商品资料</p><h2 id="catalog-edit-title">编辑商品</h2><p className="admin-help">商品编号：{product.id}</p></div><button type="button" className="admin-btn small" onClick={onClose} disabled={saving} aria-label="关闭商品编辑">关闭</button></div>
    <form onSubmit={save}>
      <fieldset disabled={saving}>
        <div className="catalog-editor-preview"><CatalogImage src={draft.imageUrl} name={draft.name} /><div><strong>{draft.name || '商品名称'}</strong><p>{sourceLabel(product)}</p>{isSams(product) && <p>山姆源价 {money(product.source.priceCents)} · {time(product.source.queriedAt)} 查询</p>}</div></div>
        <label className="admin-field">商品名称<input ref={firstField} value={draft.name} onChange={event => field('name', event.target.value)} required maxLength={200} /></label>
        <label className="admin-field">规格<input value={draft.spec} onChange={event => field('spec', event.target.value)} required maxLength={200} placeholder="例如：1kg / 盒" /></label>
        <div className="admin-form-grid"><label className="admin-field">售价（元）<input value={draft.price} onChange={event => field('price', event.target.value)} inputMode="decimal" required aria-describedby="catalog-price-help" placeholder="0.00" /></label><label className="admin-field">销售单位<input value={draft.unit} onChange={event => field('unit', event.target.value)} required maxLength={30} placeholder="份、盒、袋" /></label></div>
        <p className="admin-help" id="catalog-price-help">新订单保留下单时确认的单价，调整售价用于后续下单。历史推荐订单仍沿用原有价格规则，请在订单统计中核对。山姆源价保留为查询时的参考。</p>
        <label className="admin-field">排序<input type="number" value={draft.sort} onChange={event => field('sort', event.target.value)} step="1" min="-1000000" max="1000000" /><span className="admin-help">数字小的排在前面</span></label>
        <label className="admin-field">商品图片<input value={draft.imageUrl} onChange={event => field('imageUrl', event.target.value)} maxLength={2048} placeholder="图片链接" /></label>
        <label className="admin-checkbox"><input type="checkbox" checked={draft.onSale} onChange={event => field('onSale', event.target.checked)} aria-describedby="catalog-sale-help" /><span>上架销售</span></label>
        <p className="admin-help" id="catalog-sale-help">新选入商品默认待上架，确认规格与售价后再上架。上架后，还需选入对应团购期次，顾客页才会展示。</p>
      </fieldset>
      {error && <p className="admin-alert error" role="alert">{error}</p>}
      <div className="admin-form-footer"><button type="submit" className="admin-btn primary" disabled={saving}>{saving ? '保存中…' : '保存商品'}</button><button type="button" className="admin-btn" onClick={onClose} disabled={saving}>取消</button></div>
    </form>
  </dialog>;
}

export default function ProductCatalog({ products, batches = [], api, onUpdated, notify, onSelection, onBatches, startBackup, backupBusy, backup }) {
  const [search, setSearch] = useState('');
  const [sale, setSale] = useState('all');
  const [backupFilter, setBackupFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState('');
  const [bulkError, setBulkError] = useState('');
  const bulkBusyRef = useRef(false);
  const selectFilteredRef = useRef(null);
  const pending = products.filter(product => !backedUp(product)).length;
  const undisplayed = useMemo(() => {
    const included = new Set((Array.isArray(batches) ? batches : [])
      .filter(batch => batch?.collecting === true)
      .flatMap(batch => Array.isArray(batch.productIds) ? batch.productIds : []));
    return products.filter(product => product.onSale && !included.has(product.id)).length;
  }, [products, batches]);
  const filtered = useMemo(() => products.filter(product => {
    const text = `${product.name} ${product.spec} ${product.id} ${sourceLabel(product)}`.toLowerCase();
    return text.includes(search.trim().toLowerCase())
      && (sale === 'all' || Boolean(product.onSale) === (sale === 'on'))
      && (backupFilter === 'all' || backedUp(product) === (backupFilter === 'done'));
  }), [products, search, sale, backupFilter]);
  const selectedInFilter = filtered.filter(product => selectedIds.has(product.id)).length;
  const selectedOutsideFilter = selectedIds.size - selectedInFilter;
  const allFilteredSelected = filtered.length > 0 && selectedInFilter === filtered.length;
  const filteredSelectionTooLarge = selectedIds.size + filtered.length - selectedInFilter > MAX_SELECTED;
  const selectionLocked = Boolean(bulkBusy) || Boolean(editing);

  useEffect(() => {
    const currentIds = new Set(products.map(product => product.id));
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => currentIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [products]);

  useEffect(() => {
    if (selectFilteredRef.current) selectFilteredRef.current.indeterminate = selectedInFilter > 0 && !allFilteredSelected;
  }, [selectedInFilter, allFilteredSelected]);

  function toggleProduct(id, checked) {
    if (bulkBusyRef.current || editing || checked && selectedIds.size >= MAX_SELECTED) return;
    setBulkError('');
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (checked && next.size < MAX_SELECTED) next.add(id);
      else if (!checked) next.delete(id);
      return next;
    });
  }

  function toggleFiltered(checked) {
    if (bulkBusyRef.current || editing) return;
    if (checked && filteredSelectionTooLarge) { setBulkError('每次最多勾选 200 件，请缩小筛选范围或逐件勾选。'); return; }
    setBulkError('');
    setSelectedIds(previous => {
      const next = new Set(previous);
      for (const product of filtered) {
        if (checked) next.add(product.id);
        else next.delete(product.id);
      }
      return next.size <= MAX_SELECTED ? next : previous;
    });
  }

  async function setSelectedStatus(onSale) {
    if (bulkBusyRef.current || editing || !selectedIds.size) return;
    const productIds = [...selectedIds];
    if (productIds.length > MAX_SELECTED) { setBulkError('每次最多处理 200 件，请调整勾选后重试。'); return; }
    bulkBusyRef.current = true; setBulkBusy(onSale ? 'on' : 'off'); setBulkError('');
    try {
      const result = await api('/products/status', { method: 'POST', body: JSON.stringify({ productIds, onSale }) });
      if (!Array.isArray(result.products)) throw new Error('商品状态返回结果暂不可用，请刷新核对后重试。');
      await onUpdated(result.products);
      setSelectedIds(new Set());
      const changed = Number.isSafeInteger(result.updated) ? result.updated : productIds.length;
      const unchanged = Number.isSafeInteger(result.unchanged) ? result.unchanged : 0;
      notify(`${onSale ? '已上架' : '已下架'} ${changed} 件${unchanged ? `，${unchanged} 件原已${onSale ? '在售' : '下架'}` : ''}${onSale ? '；请到团购期次设置本期展示商品。' : '。'}`);
    } catch (error) { setBulkError(error.message || '批量操作未完成，勾选已保留，请稍后重试。'); }
    finally { bulkBusyRef.current = false; setBulkBusy(''); }
  }

  async function saved(product) {
    await onUpdated(product);
    const message = product.backupStatus === 'backed_up' ? '商品资料已保存' : '商品已保存，待同步到飞书备份';
    notify(`${message}${product.onSale ? '；请到团购期次设置本期展示商品。' : ''}`);
  }

  return <div className="catalog-page">
    <section className="admin-sync-banner"><span className="admin-banner-icon" aria-hidden="true"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3h13l3 3v15H4V3Z"/><path d="M8 3v6h8V3M8 21v-8h8v8"/></svg></span><div><h2>商品在本地维护，飞书保留备份</h2><p>山姆选品加入商品库后，可编辑售价、规格与上架状态，再按需备份。</p><small>{pending} 件待备份{backup?.lastSyncedAt ? ` · 最近备份：${time(backup.lastSyncedAt)}` : ' · 尚未完成备份'}</small></div><button className="admin-btn primary" type="button" disabled={backupBusy || selectionLocked || !products.length} onClick={startBackup}>{backupBusy ? '备份中…' : '同步到飞书备份'}</button></section>
    {backup?.error && <p className="admin-alert error" role="alert">{typeof backup.error === 'string' ? backup.error : backup.error.message}</p>}
    {undisplayed > 0 && <div className="admin-alert warning catalog-visibility-callout" role="status"><div><strong>有 {undisplayed} 件在售商品尚未加入收集中期次</strong><p>到团购期次编辑“本期商品”，保存设置后，顾客即可在该期次看到新商品。</p></div><button className="admin-btn" type="button" onClick={onBatches}>设置本期展示商品</button></div>}
    <div className="admin-section-heading"><div><h2>全部商品<span>{products.length} 件 · 在售 {products.filter(product => product.onSale).length} 件 · 待上架 {products.filter(product => !product.onSale).length} 件</span></h2><p>上架后，新商品还需选入对应团购期次，顾客页才会展示。选品入库不会覆盖已有商品。</p></div><button className="admin-btn" type="button" onClick={onSelection}>去山姆选品</button></div>
    <div className="catalog-filters"><label className="catalog-search">搜索商品<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="名称、规格、编号或来源门店" disabled={Boolean(bulkBusy)} /></label><label>上架状态<select value={sale} onChange={event => setSale(event.target.value)} disabled={Boolean(bulkBusy)}><option value="all">全部状态</option><option value="on">在售</option><option value="off">待上架</option></select></label><label>飞书备份<select value={backupFilter} onChange={event => setBackupFilter(event.target.value)} disabled={Boolean(bulkBusy)}><option value="all">全部商品</option><option value="pending">待备份</option><option value="done">已备份</option></select></label></div>
    {!!products.length && <section className="catalog-bulk-toolbar" aria-label="批量管理商品" aria-busy={Boolean(bulkBusy)}>
      <div className="catalog-bulk-selection"><label className="admin-checkbox catalog-select-filtered"><input ref={selectFilteredRef} type="checkbox" checked={allFilteredSelected} onChange={event => toggleFiltered(event.target.checked)} disabled={selectionLocked || !filtered.length || !allFilteredSelected && filteredSelectionTooLarge} aria-describedby="catalog-bulk-help" /><span>全选当前筛选结果（{filtered.length} 件）</span></label><strong role="status" aria-atomic="true">已选 {selectedIds.size} / {MAX_SELECTED} 件</strong><button type="button" className="admin-link" disabled={selectionLocked || !selectedIds.size} onClick={() => { setSelectedIds(new Set()); setBulkError(''); }}>清空勾选</button></div>
      <div className="admin-actions"><button type="button" className="admin-btn primary" disabled={selectionLocked || !selectedIds.size} onClick={() => setSelectedStatus(true)}>{bulkBusy === 'on' ? '正在批量上架…' : '批量上架'}</button><button type="button" className="admin-btn" disabled={selectionLocked || !selectedIds.size} onClick={() => setSelectedStatus(false)}>{bulkBusy === 'off' ? '正在批量下架…' : '批量下架'}</button></div>
      <p id="catalog-bulk-help">{selectedOutsideFilter > 0 ? `其中 ${selectedOutsideFilter} 件不在当前筛选中，批量操作会应用全部已选商品。` : '批量操作会应用全部已选商品，每次最多 200 件。'}上架后还需选入团购期次。</p>
      {filteredSelectionTooLarge && !allFilteredSelected && <p className="catalog-bulk-limit">全选后将超过 200 件，请缩小筛选范围或逐件勾选。</p>}
    </section>}
    {bulkError && <p className="admin-alert error catalog-bulk-error" role="alert">{bulkError} 勾选已保留，可核对后重试。</p>}
    {!products.length ? <div className="admin-empty"><h3>商品库还是空的</h3><p>在“山姆选品”浏览榜单或搜索商品，勾选入库，再核对售价与上架状态。</p><button className="admin-btn primary" type="button" onClick={onSelection}>开始选品</button></div> : !filtered.length ? <div className="admin-empty"><h3>没有匹配的商品</h3><p>换个关键词，或调整上架状态与备份筛选。</p></div> : <div className="admin-card catalog-table" aria-busy={Boolean(bulkBusy)}><div className="catalog-table-heading"><span>勾选 / 商品资料</span><span>售价 / 山姆源价</span><span>来源与备份</span><span>管理</span></div>{filtered.map(product => <article className={`catalog-row ${selectedIds.has(product.id) ? 'is-selected' : ''}`} key={product.id}>
      <div className="catalog-product"><label className="catalog-row-select"><input type="checkbox" checked={selectedIds.has(product.id)} onChange={event => toggleProduct(product.id, event.target.checked)} disabled={selectionLocked || !selectedIds.has(product.id) && selectedIds.size >= MAX_SELECTED} aria-label={`选择${product.name}`} /></label><CatalogImage src={product.imageUrl} name={product.name} /><div><h3>{product.name}</h3><ProductDescription text={productSummary(product)} name={product.name} className="catalog-product-description" /><small>{product.id}</small></div></div>
      <div className="catalog-prices"><strong>{money(product.priceCents)}<small>/{product.unit || '份'}</small></strong><span>{isSams(product) ? `山姆 ${money(product.source.priceCents)}` : '无山姆源价'}</span></div>
      <div className="catalog-provenance"><span className={`admin-pill ${product.onSale ? '' : 'neutral'}`}>{product.onSale ? '在售' : isCustomerSelected(product) && product.revision === 1 ? '待推荐' : '待上架'}</span><p>{sourceLabel(product)}</p><small className={backedUp(product) ? 'catalog-backed' : ''}>{backedUp(product) ? `已备份 · ${time(product.lastBackedUpAt)}` : '待飞书备份'}</small></div>
      <button className="admin-btn small" type="button" disabled={selectionLocked} onClick={() => { if (!bulkBusyRef.current) setEditing(product); }} aria-label={`编辑${product.name}`}>编辑</button>
    </article>)}</div>}
    {products.length > 0 && <p className="admin-help catalog-result-count" role="status">显示 {filtered.length} / {products.length} 件商品</p>}
    {editing && <EditProduct key={`${editing.id}:${editing.revision || 0}`} product={editing} api={api} onSaved={saved} onClose={() => setEditing(null)} />}
  </div>;
}
