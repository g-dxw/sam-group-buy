import { useMemo, useRef, useState, useEffect } from 'react';
import ProductDescription from './ProductDescription.jsx';
import { evaluatePricingDraft, initialPricingDraft, markupLabel, moneyInput, parseMarkupInput, parseMoneyInput } from './pricing-ui.js';
import './product-pricing.css';
import './product-remove.css';

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
  const busyRef = useRef(false);
  const pricingFields = useRef({});
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [sourceError, setSourceError] = useState('');
  const [sourcePreview, setSourcePreview] = useState(null);
  const [sourcePricePreviewId, setSourcePricePreviewId] = useState(null);
  const [draft, setDraft] = useState(() => ({
    name: product.name || '', spec: product.spec || '', unit: product.unit || '份',
    ...initialPricingDraft(product),
    onSale: Boolean(product.onSale), sort: String(product.sort ?? 0), imageUrl: product.imageUrl || '',
  }));
  const pricingPreview = evaluatePricingDraft(draft);
  const busy = saving || refreshing;

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.showModal();
    firstField.current?.focus();
    return () => { dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);

  function field(name, value) {
    setDraft(previous => ({ ...previous, [name]: value }));
    setError('');
    setFieldErrors(previous => ['originalPrice', 'pricingMode', 'markupPercent', 'markupAmount', 'price'].includes(name) ? {} : ({ ...previous, [name]: undefined }));
    if (name === 'originalPrice') setSourcePricePreviewId(null);
  }

  async function refreshSourcePrice() {
    if (busyRef.current) return;
    busyRef.current = true; setRefreshing(true); setSourceError('');
    try {
      const result = await api(`/products/${encodeURIComponent(product.id)}/source-price`);
      if (typeof result.previewId !== 'string' || !Number.isSafeInteger(result.originalPriceCents) || result.originalPriceCents < 0 || !Number.isSafeInteger(result.priceCents)) throw new Error('源价查询结果暂不可用，请稍后重试。');
      setSourcePreview(result);
    } catch (error) { setSourceError(error.message || '查询未完成，商品原价尚未修改。'); }
    finally { busyRef.current = false; setRefreshing(false); }
  }

  function useSourcePrice() {
    if (busyRef.current || !sourcePreview) return;
    field('originalPrice', moneyInput(sourcePreview.originalPriceCents));
    setSourcePricePreviewId(sourcePreview.previewId);
  }

  async function save(event) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!pricingPreview.valid) {
      setFieldErrors(pricingPreview.errors);
      const firstInvalid = ['originalPrice', 'markupPercent', 'markupAmount', 'price'].find(name => pricingPreview.errors[name]);
      pricingFields.current[firstInvalid]?.focus();
      return;
    }
    if (!Number.isFinite(Number(draft.sort))) { setError('排序请填写有效数字。'); return; }
    if (draft.imageUrl.trim() && safeProductImage(draft.imageUrl.trim()) === '/images/placeholder.svg' && draft.imageUrl.trim() !== '/images/placeholder.svg') { setError('请填写有效的 http/https 图片链接，或 /images/ 开头的本地路径。'); return; }
    busyRef.current = true; setSaving(true); setError('');
    try {
      const result = await api(`/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: JSON.stringify({
        name: draft.name.trim(), spec: draft.spec.trim(), unit: draft.unit.trim(), priceCents: pricingPreview.priceCents,
        originalPriceCents: pricingPreview.originalPriceCents, pricing: pricingPreview.pricing,
        expectedRevision: product.revision,
        ...(sourcePricePreviewId ? { sourcePricePreviewId } : {}),
        onSale: draft.onSale, sort: Number(draft.sort), imageUrl: draft.imageUrl.trim(),
      }) });
      await onSaved(result.product);
      onClose();
    } catch (error) { setError(error.message || '商品未保存，请稍后重试。'); }
    finally { busyRef.current = false; setSaving(false); }
  }

  return <dialog className="catalog-editor" ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="catalog-edit-title">
    <div className="catalog-editor-header"><div><p className="admin-eyebrow">本地商品资料</p><h2 id="catalog-edit-title">编辑商品</h2><p className="admin-help">商品编号：{product.id}</p></div><button type="button" className="admin-btn small" onClick={onClose} disabled={busy} aria-label="关闭商品编辑">关闭</button></div>
    <form onSubmit={save}>
      <fieldset disabled={busy}>
        <div className="catalog-editor-preview"><CatalogImage src={draft.imageUrl} name={draft.name} /><div><strong>{draft.name || '商品名称'}</strong><p>{sourceLabel(product)}</p>{isSams(product) && <p>山姆源价 {money(product.source.priceCents)} · {time(product.source.queriedAt)} 查询</p>}</div></div>
        <label className="admin-field">商品名称<input ref={firstField} value={draft.name} onChange={event => field('name', event.target.value)} required maxLength={200} /></label>
        <label className="admin-field">规格<input value={draft.spec} onChange={event => field('spec', event.target.value)} required maxLength={200} placeholder="例如：1kg / 盒" /></label>
        <section className="catalog-pricing-editor" aria-labelledby="catalog-pricing-title">
          <h3 id="catalog-pricing-title">商品定价</h3>
          <label className="admin-field">原价（元）<input ref={element => { pricingFields.current.originalPrice = element; }} value={draft.originalPrice} onChange={event => field('originalPrice', event.target.value)} inputMode="decimal" maxLength={16} aria-invalid={Boolean(fieldErrors.originalPrice)} aria-describedby={`catalog-original-help${fieldErrors.originalPrice ? ' catalog-original-error' : ''}`} placeholder="未提供，可手动补填" /></label>
          <p className="admin-help" id="catalog-original-help">采购参考价。按比例或固定金额加价都需要原价。</p>
          {fieldErrors.originalPrice && <p className="catalog-field-error" id="catalog-original-error" role="alert">{fieldErrors.originalPrice}</p>}
          {isSams(product) && <div className="catalog-source-price">
            <button type="button" className="admin-btn small" onClick={refreshSourcePrice} disabled={busy}>{refreshing ? '正在查询山姆源价…' : '查询最新山姆源价'}</button>
            <p className="admin-help">仅查询并预览，选择使用后仍需保存商品。</p>
            {sourceError && <p className="catalog-field-error" role="alert">{sourceError}</p>}
            {sourcePreview && <div className="catalog-source-preview" role="status"><strong>{sourcePreview.storeName || product.source.storeName || '采购门店'} · {time(sourcePreview.queriedAt)} 查询</strong><dl><div><dt>原价</dt><dd>{money(sourcePreview.previousOriginalPriceCents)} → {money(sourcePreview.originalPriceCents)}</dd></div><div><dt>查询时售价（已保存规则）</dt><dd>{money(sourcePreview.previousPriceCents)} → {money(sourcePreview.priceCents)}</dd></div></dl><p>按比例和固定金额加价都会按新原价重算售价；旧商品沿用售价时保持不变。当前草稿的售价见下方，按正在编辑的规则实时计算。</p><button type="button" className="admin-btn small" disabled={busy || sourcePricePreviewId === sourcePreview.previewId} onClick={useSourcePrice}>{sourcePricePreviewId === sourcePreview.previewId ? '已带入草稿，待保存' : '使用此原价'}</button></div>}
          </div>}
          <fieldset className="catalog-pricing-modes"><legend>定价方式</legend><label><input type="radio" name="catalog-pricing-mode" checked={draft.pricingMode === 'markup'} onChange={() => field('pricingMode', 'markup')} /><span>按比例加价</span></label><label><input type="radio" name="catalog-pricing-mode" checked={draft.pricingMode === 'amount'} onChange={() => field('pricingMode', 'amount')} /><span>固定金额加价</span></label>{draft.allowLegacyFixed && <label><input type="radio" name="catalog-pricing-mode" checked={draft.pricingMode === 'fixed'} onChange={() => field('pricingMode', 'fixed')} /><span>沿用当前售价</span></label>}</fieldset>
          {draft.pricingMode === 'markup' ? <><label className="admin-field">加价比例（%）<input ref={element => { pricingFields.current.markupPercent = element; }} value={draft.markupPercent} onChange={event => field('markupPercent', event.target.value)} inputMode="decimal" maxLength={10} required aria-invalid={Boolean(fieldErrors.markupPercent)} aria-describedby={`catalog-markup-help${fieldErrors.markupPercent ? ' catalog-markup-error' : ''}`} placeholder="例如：5" /></label><p className="admin-help" id="catalog-markup-help">0% 按原价销售，最高 1000%，最多两位小数。售价 = 原价 ×（1 + 加价比例），四舍五入到分。</p>{fieldErrors.markupPercent && <p className="catalog-field-error" id="catalog-markup-error" role="alert">{fieldErrors.markupPercent}</p>}</> : draft.pricingMode === 'amount' ? <><label className="admin-field">固定加价金额（元）<input ref={element => { pricingFields.current.markupAmount = element; }} value={draft.markupAmount} onChange={event => field('markupAmount', event.target.value)} inputMode="decimal" maxLength={16} required aria-invalid={Boolean(fieldErrors.markupAmount)} aria-describedby={`catalog-amount-help${fieldErrors.markupAmount ? ' catalog-amount-error' : ''}`} placeholder="例如：5.00" /></label><p className="admin-help" id="catalog-amount-help">最低 0 元，最多两位小数。售价 = 原价 + 固定加价金额。</p>{fieldErrors.markupAmount && <p className="catalog-field-error" id="catalog-amount-error" role="alert">{fieldErrors.markupAmount}</p>}</> : <p className="admin-help catalog-legacy-price">此旧商品{pricingPreview.originalPriceCents === null ? '尚无原价' : product.priceCents < pricingPreview.originalPriceCents ? '当前售价低于原价' : '保留历史售价'}，继续沿用当前售价 {money(product.priceCents)}，本次可编辑商品资料。补填或核对原价后，可切换到按比例或固定金额加价。</p>}
          <div className="catalog-pricing-result" aria-live="polite" aria-atomic="true"><span>客户购买单价</span><output>{pricingPreview.valid ? money(pricingPreview.priceCents) : '待完善定价'}<small>/{draft.unit || '份'}</small></output>{pricingPreview.valid && pricingPreview.originalPriceCents !== null && <p>{pricingPreview.priceCents >= pricingPreview.originalPriceCents ? `每${draft.unit || '份'}加价 ${money(pricingPreview.priceCents - pricingPreview.originalPriceCents)}` : `售价比原价低 ${money(pricingPreview.originalPriceCents - pricingPreview.priceCents)}，请核对是否按此售价销售。`}</p>}</div>
          <p className="admin-help catalog-pricing-boundary">调价只用于新订单，已下单价格保留。代购费由本期单独设置；本期拼份售价独立维护，本次保存不会覆盖。</p>
        </section>
        <label className="admin-field">销售单位<input value={draft.unit} onChange={event => field('unit', event.target.value)} required maxLength={30} placeholder="份、盒、袋" /></label>
        <label className="admin-field">排序<input type="number" value={draft.sort} onChange={event => field('sort', event.target.value)} step="1" min="-1000000" max="1000000" /><span className="admin-help">数字小的排在前面</span></label>
        <label className="admin-field">商品图片<input value={draft.imageUrl} onChange={event => field('imageUrl', event.target.value)} maxLength={2048} placeholder="图片链接" /></label>
        <label className="admin-checkbox"><input type="checkbox" checked={draft.onSale} onChange={event => field('onSale', event.target.checked)} aria-describedby="catalog-sale-help" /><span>上架销售</span></label>
        <p className="admin-help" id="catalog-sale-help">新选入商品默认待上架，确认规格与售价后再上架。上架后，还需选入对应团购期次，顾客页才会展示。</p>
      </fieldset>
      {error && <p className="admin-alert error" role="alert">{error}</p>}
      <div className="admin-form-footer"><button type="submit" className="admin-btn primary" disabled={busy}>{saving ? '保存中…' : '保存商品'}</button><button type="button" className="admin-btn" onClick={onClose} disabled={busy}>取消</button></div>
    </form>
  </dialog>;
}

function BulkPricing({ productIds, outsideFilter, api, onClose, onSaved }) {
  const dialog = useRef(null);
  const firstField = useRef(null);
  const busyRef = useRef(false);
  const [mode, setMode] = useState('markup');
  const [percent, setPercent] = useState('0');
  const [amount, setAmount] = useState('0.00');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [inputError, setInputError] = useState('');

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.showModal();
    firstField.current?.focus();
    return () => { dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);

  function changePricing(name, value) {
    if (busyRef.current) return;
    if (name === 'mode') setMode(value);
    else if (name === 'amount') setAmount(value);
    else setPercent(value);
    setPreview(null); setError(''); setInputError('');
  }

  async function queryPreview(event) {
    event.preventDefault();
    if (busyRef.current) return;
    const parsed = mode === 'amount' ? parseMoneyInput(amount, '加价金额') : parseMarkupInput(percent);
    if (parsed.error) { setInputError(parsed.error); setPreview(null); firstField.current?.focus(); return; }
    const pricing = mode === 'amount' ? { mode: 'amount', markupBps: null, amountCents: parsed.value } : { mode: 'markup', markupBps: parsed.value };
    busyRef.current = true; setBusy('preview'); setError(''); setInputError(''); setPreview(null);
    try {
      const result = await api('/products/pricing/preview', { method: 'POST', body: JSON.stringify({ productIds, pricing }) });
      const requested = new Set(productIds);
      if (typeof result.previewId !== 'string' || !result.pricing || result.pricing.mode !== pricing.mode || (pricing.mode === 'amount' ? result.pricing.amountCents !== pricing.amountCents : result.pricing.markupBps !== pricing.markupBps) || !Array.isArray(result.rows) || result.rows.length !== productIds.length || new Set(result.rows.map(row => row.id)).size !== requested.size || result.rows.some(row => !requested.has(row.id) || !Number.isSafeInteger(row.originalPriceCents) || row.originalPriceCents < 0 || !Number.isSafeInteger(row.priceCents) || !Number.isSafeInteger(row.previousPriceCents))) throw new Error('调价预览返回结果暂不可用，请重新生成预览。');
      setPreview({ ...result, pricing });
    } catch (error) { setError(error.message || '预览未生成，勾选和定价设置已保留。'); }
    finally { busyRef.current = false; setBusy(''); }
  }

  async function applyPreview() {
    if (busyRef.current || !preview) return;
    busyRef.current = true; setBusy('apply'); setError('');
    try {
      const result = await api('/products/pricing/apply', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId }) });
      if (!Array.isArray(result.products) || result.products.length !== productIds.length) throw new Error('调价结果暂不可用，可重试确认或刷新商品核对。');
      await onSaved(result, productIds.length);
      onClose();
    } catch (error) { setError(error.message || '批量定价未完成，预览与勾选已保留，可核对后重试。'); }
    finally { busyRef.current = false; setBusy(''); }
  }

  return <dialog className="catalog-editor catalog-bulk-pricing" ref={dialog} onCancel={event => { event.preventDefault(); if (!busyRef.current) onClose(); }} aria-labelledby="catalog-bulk-pricing-title" aria-busy={Boolean(busy)}>
    <div className="catalog-editor-header"><div><p className="admin-eyebrow">先预览，再确认</p><h2 id="catalog-bulk-pricing-title">批量定价</h2><p className="admin-help">已选 {productIds.length} 件{outsideFilter ? `，包含当前筛选外 ${outsideFilter} 件` : ''}</p></div><button type="button" className="admin-btn small" onClick={onClose} disabled={Boolean(busy)} aria-label="关闭批量定价">关闭</button></div>
    <form onSubmit={queryPreview}>
      <fieldset disabled={Boolean(busy)}>
        <fieldset className="catalog-pricing-modes"><legend>批量定价方式</legend><label><input type="radio" name="catalog-bulk-pricing-mode" checked={mode === 'markup'} onChange={() => changePricing('mode', 'markup')} /><span>按比例加价</span></label><label><input type="radio" name="catalog-bulk-pricing-mode" checked={mode === 'amount'} onChange={() => changePricing('mode', 'amount')} /><span>固定金额加价</span></label></fieldset>
        <label className="admin-field">{mode === 'amount' ? '统一加价金额（元）' : '统一加价比例（%）'}<input ref={firstField} value={mode === 'amount' ? amount : percent} onChange={event => changePricing(mode === 'amount' ? 'amount' : 'percent', event.target.value)} inputMode="decimal" maxLength={mode === 'amount' ? 16 : 10} required aria-invalid={Boolean(inputError)} aria-describedby={`catalog-bulk-pricing-help${inputError ? ' catalog-bulk-pricing-error' : ''}`} placeholder={mode === 'amount' ? '例如：5.00' : '例如：5'} /></label>
        <p className="admin-help" id="catalog-bulk-pricing-help">按每件商品自己的原价计算，不在现有售价上叠加。{mode === 'amount' ? '售价 = 原价 + 固定加价金额；最低 0 元，最多两位小数。' : '0% 按原价销售，最高 1000%，最多两位小数。'}</p>
        {inputError && <p className="catalog-field-error" id="catalog-bulk-pricing-error" role="alert">{inputError}</p>}
        <button type="submit" className="admin-btn catalog-generate-preview" disabled={Boolean(busy)}>{busy === 'preview' ? '正在生成预览…' : preview ? '重新生成预览' : '生成调价预览'}</button>
      </fieldset>
      {error && <p className="admin-alert error" role="alert">{error}</p>}
      {preview && <section className="catalog-pricing-preview" aria-labelledby="catalog-pricing-preview-title"><div className="catalog-pricing-preview-heading"><h3 id="catalog-pricing-preview-title">{productIds.length} 件商品 · {preview.pricing.mode === 'amount' ? `固定加价 ${money(preview.pricing.amountCents)}` : `加价 ${markupLabel(preview.pricing.markupBps)}%`}</h3><p>{Number.isSafeInteger(preview.updated) ? `${preview.updated} 件调整，${preview.unchanged ?? 0} 件无需调整` : '逐项核对原价和新售价后确认'}{preview.expiresAt ? ` · 有效至 ${time(preview.expiresAt)}` : ''}</p></div><ul>{preview.rows.map(row => <li key={row.id}><strong>{row.name}</strong><dl><div><dt>原价</dt><dd>{money(row.originalPriceCents)}</dd></div><div><dt>当前售价</dt><dd>{money(row.previousPriceCents)}</dd></div><div><dt>新售价</dt><dd className="catalog-new-price">{money(row.priceCents)}</dd></div></dl></li>)}</ul><p className="admin-help">确认后全部已选商品改为{preview.pricing.mode === 'amount' ? '固定金额加价' : '按比例加价'}。调价仅用于新订单；代购费与本期拼份售价仍单独设置。</p></section>}
      <div className="admin-form-footer"><button type="button" className="admin-btn primary" onClick={applyPreview} disabled={Boolean(busy) || !preview}>{busy === 'apply' ? '正在保存定价…' : `确认应用到 ${productIds.length} 件`}</button><button type="button" className="admin-btn" onClick={onClose} disabled={Boolean(busy)}>取消</button></div>
    </form>
  </dialog>;
}

function CatalogPrice({ product }) {
  const original = Number.isSafeInteger(product.originalPriceCents) ? product.originalPriceCents : null;
  const delta = original === null ? null : product.priceCents - original;
  return <div className="catalog-prices catalog-pricing-summary"><span className="catalog-original-price">原价 {money(original)}</span><strong><span className="catalog-sale-price-label">售价</span>{money(product.priceCents)}<small>/{product.unit || '份'}</small></strong><span className="catalog-pricing-method">{product.pricing?.mode === 'markup' ? `按比例 +${markupLabel(product.pricing.markupBps)}%` : product.pricing?.mode === 'amount' ? `固定加价 +${money(product.pricing.amountCents)}` : '沿用售价'}</span>{delta !== null && <span className={`catalog-markup-amount${delta < 0 ? ' is-negative' : ''}`}>{delta < 0 ? `低于原价 ${money(-delta)}` : `加价 ${money(delta)}`}</span>}</div>;
}

function RemoveProductsDialog({ target, busy, error, onConfirm, onClose, fallbackFocus }) {
  const dialog = useRef(null);
  const cancel = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => {
      dialog.current?.close();
      if (opener?.isConnected && !opener.disabled) opener.focus();
      else fallbackFocus.current?.focus();
    };
  }, [fallbackFocus]);
  const count = target.products.length;
  return <dialog className="catalog-remove-dialog" ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="catalog-remove-title" aria-describedby="catalog-remove-help" aria-busy={busy}>
    <div className="catalog-remove-heading"><div><p className="admin-eyebrow">可在已移除商品中恢复</p><h2 id="catalog-remove-title">{count === 1 ? '移除这件商品？' : `移除已选的 ${count} 件商品？`}</h2></div><button type="button" className="admin-btn small" onClick={onClose} disabled={busy} aria-label="关闭商品移除确认">关闭</button></div>
    <p className="catalog-remove-help" id="catalog-remove-help">商品会从商品库和推荐页隐藏，并自动下架。已有订单和本期商品关联保留；恢复后需重新上架。</p>
    {target.outsideFilter > 0 && <p className="catalog-remove-outside">包含当前筛选外的 {target.outsideFilter} 件已选商品。</p>}
    <ul className="catalog-remove-list" aria-label="将移除的商品">{target.products.map(product => <li key={product.id}><strong>{product.name}</strong><small>{product.id}</small></li>)}</ul>
    {error && <p className="admin-alert error" role="alert">{error} 商品清单与勾选已保留，可核对后重试。</p>}
    <div className="catalog-remove-footer"><button type="button" className="admin-btn" ref={cancel} onClick={onClose} disabled={busy}>取消</button><button type="button" className="admin-btn catalog-remove-confirm" onClick={onConfirm} disabled={busy}>{busy ? '正在移除并核对…' : `确认移除 ${count} 件`}</button></div>
  </dialog>;
}

export default function ProductCatalog({ products, removedProducts = [], batches = [], api, onUpdated, onCatalogReloaded, notify, onSelection, onBatches, startBackup, backupBusy, backup }) {
  const [search, setSearch] = useState('');
  const [sale, setSale] = useState('all');
  const [backupFilter, setBackupFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [pricingSelection, setPricingSelection] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [lifecycleBusy, setLifecycleBusy] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [restoreError, setRestoreError] = useState(null);
  const lifecycleBusyRef = useRef(false);
  const removedSummaryRef = useRef(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState('');
  const [bulkError, setBulkError] = useState('');
  const bulkBusyRef = useRef(false);
  const selectFilteredRef = useRef(null);
  const pending = [...products, ...removedProducts].filter(product => !backedUp(product)).length;
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
  const selectionLocked = Boolean(bulkBusy) || Boolean(editing) || Boolean(pricingSelection) || Boolean(removeTarget) || Boolean(lifecycleBusy) || Boolean(backupBusy);

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
    if (bulkBusyRef.current || lifecycleBusyRef.current || selectionLocked || checked && selectedIds.size >= MAX_SELECTED) return;
    setBulkError('');
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (checked && next.size < MAX_SELECTED) next.add(id);
      else if (!checked) next.delete(id);
      return next;
    });
  }

  function toggleFiltered(checked) {
    if (bulkBusyRef.current || lifecycleBusyRef.current || selectionLocked) return;
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
    if (bulkBusyRef.current || lifecycleBusyRef.current || selectionLocked || !selectedIds.size) return;
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

  async function pricingSaved(result, count) {
    await onUpdated(result.products);
    setSelectedIds(new Set()); setBulkError('');
    const changed = Number.isSafeInteger(result.updated) ? result.updated : count;
    const unchanged = Number.isSafeInteger(result.unchanged) ? result.unchanged : 0;
    notify(`已调整 ${changed} 件商品定价${unchanged ? `，${unchanged} 件无需调整` : ''}；新订单使用新售价，商品待同步到飞书备份。`);
  }

  function openRemove(productIds, outsideFilter = 0, bulk = false) {
    if (bulkBusyRef.current || lifecycleBusyRef.current || selectionLocked) return;
    const targetProducts = products.filter(product => productIds.includes(product.id));
    if (!targetProducts.length || targetProducts.length > MAX_SELECTED) return;
    setRemoveError('');
    setRemoveTarget({ products: targetProducts, outsideFilter, bulk });
  }

  async function reloadLifecycleCatalog(productIds, removed) {
    const catalog = await api('/products');
    if (!Array.isArray(catalog.products) || !Array.isArray(catalog.removedProducts)) throw new Error('商品列表暂未刷新成功，请重试核对。');
    const activeIds = new Set(catalog.products.map(product => product.id));
    const removedIds = new Set(catalog.removedProducts.map(product => product.id));
    if (productIds.some(id => removed ? activeIds.has(id) || !removedIds.has(id) || catalog.removedProducts.find(product => product.id === id)?.onSale !== false : !activeIds.has(id) || removedIds.has(id) || catalog.products.find(product => product.id === id)?.onSale !== false)) throw new Error('商品状态尚未核对一致，请重试或刷新页面查看。');
    return onCatalogReloaded ? await onCatalogReloaded(catalog) : (await onUpdated(catalog.products), {});
  }

  async function removeProducts() {
    if (lifecycleBusyRef.current || !removeTarget) return;
    const productIds = removeTarget.products.map(product => product.id);
    lifecycleBusyRef.current = true; setLifecycleBusy('remove'); setRemoveError('');
    try {
      const result = !removeTarget.bulk
        ? await api(`/products/${encodeURIComponent(productIds[0])}`, { method: 'DELETE', body: '{}' })
        : await api('/products/remove', { method: 'POST', body: JSON.stringify({ productIds }) });
      const returnedIds = new Set((Array.isArray(result.products) ? result.products : result.product ? [result.product] : []).map(product => product.id));
      if (result.removed !== true || productIds.some(id => !returnedIds.has(id))) throw new Error('移除返回结果暂不可用，请重试核对。');
      const feedback = await reloadLifecycleCatalog(productIds, true);
      setSelectedIds(previous => new Set([...previous].filter(id => !productIds.includes(id))));
      setRemoveTarget(null); setBulkError('');
      notify(`已移除 ${productIds.length} 件商品，已有订单保留，可从“已移除商品”恢复。${feedback?.overviewWarning || ''}`, Boolean(feedback?.overviewWarning));
    } catch (error) { setRemoveError(error.message || '商品移除尚未完成，请重试。'); }
    finally { lifecycleBusyRef.current = false; setLifecycleBusy(''); }
  }

  async function restoreProduct(product) {
    if (bulkBusyRef.current || lifecycleBusyRef.current || selectionLocked) return;
    lifecycleBusyRef.current = true; setLifecycleBusy(`restore:${product.id}`); setRestoreError(null);
    try {
      const result = await api(`/products/${encodeURIComponent(product.id)}/restore`, { method: 'POST', body: '{}' });
      if (result.restored !== true || result.product?.id !== product.id) throw new Error('恢复返回结果暂不可用，请重试核对。');
      const feedback = await reloadLifecycleCatalog([product.id], false);
      notify(`已恢复“${product.name}”，目前为待上架；核对后可重新上架。${feedback?.overviewWarning || ''}`, Boolean(feedback?.overviewWarning));
      removedSummaryRef.current?.focus();
    } catch (error) { setRestoreError({ productId: product.id, message: error.message || '恢复尚未完成，请重试。' }); }
    finally { lifecycleBusyRef.current = false; setLifecycleBusy(''); }
  }

  return <div className="catalog-page">
    <section className="admin-sync-banner"><span className="admin-banner-icon" aria-hidden="true"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3h13l3 3v15H4V3Z"/><path d="M8 3v6h8V3M8 21v-8h8v8"/></svg></span><div><h2>商品在本地维护，飞书保留备份</h2><p>山姆选品加入商品库后，可设置原价、售价、规格与上架状态，再按需备份。已移除商品仍保留备份。</p><small>{pending} 件待备份{backup?.lastSyncedAt ? ` · 最近备份：${time(backup.lastSyncedAt)}` : ' · 尚未完成备份'}</small></div><button className="admin-btn primary" type="button" disabled={backupBusy || selectionLocked || !products.length && !removedProducts.length} onClick={startBackup}>{backupBusy ? '备份中…' : '同步到飞书备份'}</button></section>
    {backup?.error && <p className="admin-alert error" role="alert">{typeof backup.error === 'string' ? backup.error : backup.error.message}</p>}
    {undisplayed > 0 && <div className="admin-alert warning catalog-visibility-callout" role="status"><div><strong>有 {undisplayed} 件在售商品尚未加入收集中期次</strong><p>到团购期次编辑“本期商品”，保存设置后，顾客即可在该期次看到新商品。</p></div><button className="admin-btn" type="button" onClick={onBatches}>设置本期展示商品</button></div>}
    <div className="admin-section-heading"><div><h2>全部商品<span>{products.length} 件 · 在售 {products.filter(product => product.onSale).length} 件 · 待上架 {products.filter(product => !product.onSale).length} 件</span></h2><p>上架后，新商品还需选入对应团购期次，顾客页才会展示。选品入库不会覆盖已有商品。</p></div><button className="admin-btn" type="button" onClick={onSelection}>去山姆选品</button></div>
    <div className="catalog-filters"><label className="catalog-search">搜索商品<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="名称、规格、编号或来源门店" disabled={Boolean(bulkBusy)} /></label><label>上架状态<select value={sale} onChange={event => setSale(event.target.value)} disabled={Boolean(bulkBusy)}><option value="all">全部状态</option><option value="on">在售</option><option value="off">待上架</option></select></label><label>飞书备份<select value={backupFilter} onChange={event => setBackupFilter(event.target.value)} disabled={Boolean(bulkBusy)}><option value="all">全部商品</option><option value="pending">待备份</option><option value="done">已备份</option></select></label></div>
    {!!products.length && <section className="catalog-bulk-toolbar" aria-label="批量管理商品" aria-busy={Boolean(bulkBusy)}>
      <div className="catalog-bulk-selection"><label className="admin-checkbox catalog-select-filtered"><input ref={selectFilteredRef} type="checkbox" checked={allFilteredSelected} onChange={event => toggleFiltered(event.target.checked)} disabled={selectionLocked || !filtered.length || !allFilteredSelected && filteredSelectionTooLarge} aria-describedby="catalog-bulk-help" /><span>全选当前筛选结果（{filtered.length} 件）</span></label><strong role="status" aria-atomic="true">已选 {selectedIds.size} / {MAX_SELECTED} 件</strong><button type="button" className="admin-link" disabled={selectionLocked || !selectedIds.size} onClick={() => { setSelectedIds(new Set()); setBulkError(''); }}>清空勾选</button></div>
      <div className="admin-actions"><button type="button" className="admin-btn primary" disabled={selectionLocked || !selectedIds.size} onClick={() => setSelectedStatus(true)}>{bulkBusy === 'on' ? '正在批量上架…' : '批量上架'}</button><button type="button" className="admin-btn" disabled={selectionLocked || !selectedIds.size} onClick={() => setSelectedStatus(false)}>{bulkBusy === 'off' ? '正在批量下架…' : '批量下架'}</button><button type="button" className="admin-btn" disabled={selectionLocked || !selectedIds.size} onClick={() => { if (!selectionLocked && !bulkBusyRef.current && !lifecycleBusyRef.current) setPricingSelection({ productIds: [...selectedIds], outsideFilter: selectedOutsideFilter }); }}>批量定价</button><button type="button" className="admin-btn catalog-remove-button" disabled={selectionLocked || !selectedIds.size} onClick={() => openRemove([...selectedIds], selectedOutsideFilter, true)}>批量移除</button></div>
      <p id="catalog-bulk-help">{selectedOutsideFilter > 0 ? `其中 ${selectedOutsideFilter} 件不在当前筛选中，批量操作会应用全部已选商品。` : '批量操作会应用全部已选商品，每次最多 200 件。'}上架后还需选入团购期次。</p>
      {filteredSelectionTooLarge && !allFilteredSelected && <p className="catalog-bulk-limit">全选后将超过 200 件，请缩小筛选范围或逐件勾选。</p>}
    </section>}
    {bulkError && <p className="admin-alert error catalog-bulk-error" role="alert">{bulkError} 勾选已保留，可核对后重试。</p>}
    {!products.length ? <div className="admin-empty"><h3>商品库还是空的</h3><p>在“山姆选品”浏览榜单或搜索商品，勾选入库，再核对原价、售价与上架状态。</p><button className="admin-btn primary" type="button" onClick={onSelection}>开始选品</button></div> : !filtered.length ? <div className="admin-empty"><h3>没有匹配的商品</h3><p>换个关键词，或调整上架状态与备份筛选。</p></div> : <div className="admin-card catalog-table" aria-busy={Boolean(bulkBusy)}><div className="catalog-table-heading"><span>勾选 / 商品资料</span><span>原价 / 售价</span><span>来源与备份</span><span>管理</span></div>{filtered.map(product => <article className={`catalog-row ${selectedIds.has(product.id) ? 'is-selected' : ''}`} key={product.id}>
      <div className="catalog-product"><label className="catalog-row-select"><input type="checkbox" checked={selectedIds.has(product.id)} onChange={event => toggleProduct(product.id, event.target.checked)} disabled={selectionLocked || !selectedIds.has(product.id) && selectedIds.size >= MAX_SELECTED} aria-label={`选择${product.name}`} /></label><CatalogImage src={product.imageUrl} name={product.name} /><div><h3>{product.name}</h3><ProductDescription text={productSummary(product)} name={product.name} className="catalog-product-description" /><small>{product.id}</small></div></div>
      <CatalogPrice product={product} />
      <div className="catalog-provenance"><span className={`admin-pill ${product.onSale ? '' : 'neutral'}`}>{product.onSale ? '在售' : isCustomerSelected(product) && product.revision === 1 ? '待推荐' : '待上架'}</span><p>{sourceLabel(product)}</p><small className={backedUp(product) ? 'catalog-backed' : ''}>{backedUp(product) ? `已备份 · ${time(product.lastBackedUpAt)}` : '待飞书备份'}</small></div>
      <div className="catalog-row-actions"><button className="admin-btn small" type="button" disabled={selectionLocked} onClick={() => { if (!selectionLocked && !bulkBusyRef.current && !lifecycleBusyRef.current) setEditing(product); }} aria-label={`编辑${product.name}`}>编辑</button><button className="admin-btn small catalog-remove-button" type="button" disabled={selectionLocked} onClick={() => openRemove([product.id])} aria-label={`移除${product.name}`}>移除</button></div>
    </article>)}</div>}
    {products.length > 0 && <p className="admin-help catalog-result-count" role="status">显示 {filtered.length} / {products.length} 件商品</p>}
    <details className="catalog-removed-products"><summary ref={removedSummaryRef}>已移除商品（{removedProducts.length}）<span>可恢复</span></summary><p className="admin-help">已移除商品不出现在正常商品库和推荐页，已有订单保留。恢复后仍下架，请核对资料后重新上架。</p>{removedProducts.length ? <ul>{removedProducts.map(product => <li key={product.id}><CatalogImage src={product.imageUrl} name={product.name} /><div><strong>{product.name}</strong><p>{product.spec}</p><small>移除于 {time(product.removedAt)}</small><small className={backedUp(product) ? 'catalog-backed' : ''}>{backedUp(product) ? `已备份 · ${time(product.lastBackedUpAt)}` : '待飞书备份'}</small></div><button type="button" className="admin-btn small" disabled={selectionLocked} onClick={() => restoreProduct(product)} aria-label={`恢复${product.name}`}>{lifecycleBusy === `restore:${product.id}` ? '恢复并核对中…' : '恢复商品'}</button>{restoreError?.productId === product.id && <p className="admin-alert error catalog-restore-error" role="alert">{restoreError.message} 可重试恢复。</p>}</li>)}</ul> : <p className="admin-help catalog-removed-empty">暂无已移除商品。</p>}</details>
    {editing && <EditProduct key={`${editing.id}:${editing.revision || 0}`} product={editing} api={api} onSaved={saved} onClose={() => setEditing(null)} />}
    {pricingSelection && <BulkPricing productIds={pricingSelection.productIds} outsideFilter={pricingSelection.outsideFilter} api={api} onSaved={pricingSaved} onClose={() => setPricingSelection(null)} />}
    {removeTarget && <RemoveProductsDialog target={removeTarget} busy={lifecycleBusy === 'remove'} error={removeError} onConfirm={removeProducts} onClose={() => { if (!lifecycleBusyRef.current) { setRemoveTarget(null); setRemoveError(''); } }} fallbackFocus={removedSummaryRef} />}
  </div>;
}
