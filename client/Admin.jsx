import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { createSubmissionId } from './submission-id.js';
import FeishuConfig from './FeishuConfig.jsx';
import SamsSelection from './SamsSelection.jsx';
import ProductCatalog from './ProductCatalog.jsx';
import BatchSamsStore from './BatchSamsStore.jsx';
import BatchFees, { CustomerFeeBill, feeCategoryLabel, feePolicyFromForm, feeTotals, formatFeeRate, resolveFeeRates } from './BatchFees.jsx';
import BatchSplitRules, { BatchSplitSummary, SplitGroups, SplitOrderProgress, splitRulesFromForm } from './BatchSplitRules.jsx';
import './admin.css';
import './batch-drawer.css';
import './batch-delete.css';
import './group-orders.css';

const sections = [
  { id: 'batches', title: '团购期次', icon: 'calendar', description: '按小区开新一期，分享给群里的邻居。' },
  { id: 'selection', title: '山姆选品', icon: 'search', description: '选择门店，浏览官方榜单或搜索商品，勾选加入本地商品库。' },
  { id: 'products', title: '商品库', icon: 'box', description: '在本地编辑商品、核对售价，按需同步到飞书备份。' },
  { id: 'orders', title: '订单统计', icon: 'list', description: '查看采购清单、管理订单，再同步到飞书。' },
  { id: 'feishu', title: '飞书备份', icon: 'settings', description: '设置商品共享备份，订单按群独立同步。' },
];
const pageFromURL = () => {
  const view = new URLSearchParams(location.search).get('view');
  if (sections.some(section => section.id === view)) return view;
  const hash = location.hash.slice(1);
  return sections.some(section => section.id === hash) ? hash : 'batches';
};
const orderStatuses = { 待采购: '待采购', 已买到: '已买到', 缺货: '缺货', 已领取: '已领取', 已取消: '已取消' };
const legacyStatuses = { pending: '待采购', purchased: '已买到', out_of_stock: '缺货', collected: '已领取', cancelled: '已取消', canceled: '已取消' };
const canonicalStatus = value => legacyStatuses[value] || value;
const activeQuantity = product => product.split ? (product.statuses || []).filter(item => !['已取消', '缺货'].includes(canonicalStatus(item.status))).reduce((sum, item) => sum + item.quantity, 0) : product.statuses?.length ? product.statuses.filter(item => !['已取消', '缺货'].includes(canonicalStatus(item.status))).reduce((sum, item) => sum + item.quantity, 0) : product.quantity;
const money = value => value === null ? '待核对' : `¥${(Number(value || 0) / 100).toFixed(2)}`;
const dateTime = value => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }) : '未设置';
const localDate = value => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const isoDate = value => value ? new Date(value).toISOString() : '';
const closed = batch => !batch.collecting || Boolean(batch.cutoffAt && new Date(batch.cutoffAt).getTime() <= Date.now());
const orderFeeCategory = order => order.feeCategory || (order.selfSelected ? 'selfSelected' : 'recommended');
const orderFeeAmount = order => order.feeCents === undefined ? 0 : order.feeCents;
const orderPayableAmount = order => order.payableCents === undefined ? order.amountCents : order.payableCents;
const batchFeeSummary = batch => {
  const rates = resolveFeeRates(batch.feePolicy);
  return `推荐 ${formatFeeRate(rates.recommended)} · 自选 ${formatFeeRate(rates.selfSelected)}${rates.follows ? '（跟随推荐）' : ''}`;
};

function Icon({ name, size = 20 }) {
  const paths = {
    bag: <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" /></>,
    box: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9M7 5.8l9 5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    list: <><path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    sync: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    link: <><path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.92)" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    exit: <><path d="M10 3H4v18h6M8 12h13m-4-4 4 4-4 4" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--admin-bg)" /><circle cx="15" cy="17" r="3" fill="var(--admin-bg)" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.bag}</svg>;
}

async function request(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || '操作未完成，请稍后重试。');
    error.status = response.status;
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* LAN browsers can require the fallback. */ }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('浏览器未允许复制，请手动选中链接复制。');
}

function ProductImage({ product }) {
  return <img src={product.imageUrl || '/images/placeholder.svg'} alt={product.name} loading="lazy" onError={event => { if (!event.currentTarget.src.endsWith('/images/placeholder.svg')) event.currentTarget.src = '/images/placeholder.svg'; }} />;
}

function Empty({ icon = 'box', title, children }) {
  return <div className="admin-empty"><span><Icon name={icon} size={28} /></span><h3>{title}</h3><p>{children}</p></div>;
}

function BatchBadge({ batch }) {
  return <span className={`admin-pill ${closed(batch) ? 'neutral' : ''}`}><i />{closed(batch) ? '已截单' : '收集中'}</span>;
}

function GroupOrderSyncTarget({ sync = {}, onConfigure }) {
  const group = sync.groupTable || {};
  const status = ['pending', 'ready', 'error'].includes(group.status) ? group.status : 'unconfigured';
  const groupError = typeof group.error === 'string' ? group.error : group.error?.message;
  const pendingCheck = status === 'pending' && Boolean(groupError);
  const statusLabel = { unconfigured: '尚未配置', pending: pendingCheck ? '待核查' : '同步后创建', ready: '已建立', error: '同步未完成' }[status];
  return <section className={`admin-group-order-target is-${status}`} aria-label="本群飞书订单同步目标">
    <div className="admin-group-order-heading"><div><p>同步目标 · 本群订单表</p><h3>{status === 'ready' ? group.tableName || '本群订单表已建立' : status === 'pending' ? pendingCheck ? '等待确认本群订单表' : '待建本群订单表' : status === 'error' ? group.tableName || '本群订单表同步未完成' : '请先连接飞书多维表格'}</h3></div><span className={`admin-pill ${status === 'ready' ? '' : 'neutral'}`}>{statusLabel}</span></div>
    {status === 'pending' && <p className="admin-group-order-help">{pendingCheck ? '再次同步会先核查上次建表结果；本地订单保留，可稍后重试核查。' : '首次手动同步本期订单时自动建表，无需选择群表；同群其他期次会沿用这张表。'}</p>}
    {status === 'ready' && <p className="admin-group-order-help">本群订单保存在这张表中，各期订单通过独立视图查看。</p>}
    {status === 'unconfigured' && <p className="admin-group-order-help">保存飞书配置后，首次手动同步会为本群创建独立订单表。</p>}
    {(status === 'error' || pendingCheck) && <p className="admin-group-order-error" role="alert">{groupError || '暂时未能建立或同步本群订单表，请重新同步本期订单。'}</p>}
    <div className="admin-group-order-footer"><span>上次本期同步：{sync.lastSyncedAt ? dateTime(sync.lastSyncedAt) : '尚未同步'}</span><div className="admin-group-order-links">{status === 'unconfigured' && <button type="button" className="admin-link" onClick={onConfigure}>配置飞书备份<Icon name="arrow" size={15} /></button>}{status === 'ready' && group.url && <a className="admin-link" href={group.url} target="_blank" rel="noreferrer">打开本群订单表<Icon name="arrow" size={15} /></a>}{status === 'ready' && sync.viewUrl && <a className="admin-link" href={sync.viewUrl} target="_blank" rel="noreferrer">查看本期订单视图<Icon name="arrow" size={15} /></a>}</div></div>
    {sync.legacyViewUrl && <div className="admin-group-order-legacy"><span>历史订单仍保留在原总表中。</span><a className="admin-link" href={sync.legacyViewUrl} target="_blank" rel="noreferrer">查看历史总表备份<Icon name="arrow" size={15} /></a></div>}
  </section>;
}

function BatchDrawer({ title, description, busy, error, submitLabel, submitDisabled, onSubmit, onClose, children }) {
  const dialog = useRef(null);
  const heading = useRef(null);
  const feedback = useRef(null);

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (error) feedback.current?.focus();
  }, [error]);

  return <dialog ref={dialog} className="admin-batch-drawer" aria-labelledby="admin-batch-drawer-title" aria-describedby="admin-batch-drawer-description" aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="admin-batch-drawer-header"><div><p className="admin-eyebrow">团购期次设置</p><h2 ref={heading} tabIndex={-1} id="admin-batch-drawer-title">{title}</h2><p id="admin-batch-drawer-description">{description}</p></div><button type="button" className="admin-btn small" disabled={busy} onClick={onClose} aria-label={`关闭${title}`}><Icon name="close" size={17} />关闭</button></header>
    <form onSubmit={onSubmit}>
      <div className="admin-batch-drawer-body">
        {error && <div className="admin-alert error" role="alert" ref={feedback} tabIndex={-1}>{error}</div>}
        <fieldset disabled={busy}>{children}</fieldset>
      </div>
      <div className="admin-form-footer"><button type="submit" className="admin-btn primary" disabled={busy || submitDisabled}>{busy ? <span className="admin-spinner" /> : null}{submitLabel}</button><button type="button" className="admin-btn" disabled={busy} onClick={onClose}>取消</button></div>
    </form>
  </dialog>;
}

function BatchDeleteDialog({ batch, busy, error, onConfirm, onClose }) {
  const dialog = useRef(null);
  const heading = useRef(null);
  const feedback = useRef(null);
  const label = `${batch.communityName} · ${batch.periodLabel || `第${batch.periodNumber}期`}`;
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { if (error) feedback.current?.focus(); }, [error]);
  return <dialog ref={dialog} className="admin-batch-delete-dialog" aria-labelledby="admin-batch-delete-title" aria-describedby="admin-batch-delete-description" aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="admin-batch-delete-heading"><h2 ref={heading} tabIndex={-1} id="admin-batch-delete-title">删除 {label}？</h2><button type="button" className="admin-link" disabled={busy} onClick={onClose} aria-label="关闭删除确认"><Icon name="close" size={19} /></button></div>
    <p id="admin-batch-delete-description">删除后，本期从正常列表移除，客户收集链接将不可访问。商品和订单会保留，可在“已删除期次”恢复。</p>
    <p className="admin-help">恢复后仍为已截单状态，需要重新开放时可再编辑本期。</p>
    {error && <div className="admin-alert error" ref={feedback} role="alert" tabIndex={-1}>{error}</div>}
    <div className="admin-batch-delete-actions"><button type="button" className="admin-btn" disabled={busy} onClick={onClose}>取消</button><button type="button" className="admin-btn batch-delete-confirm" disabled={busy} onClick={onConfirm}>{busy && <span className="admin-spinner" />}{busy ? '删除中…' : '确认删除本期'}</button></div>
  </dialog>;
}

function OptionalBatchFields({ batch = {}, api }) {
  return <>
    <BatchSamsStore api={api} value={batch.samsStore || null} />
    <BatchFees value={batch.feePolicy} />
    <label className="admin-field">本期标题 <span>选填</span><input name="title" defaultValue={batch.title || ''} placeholder="例如：本周山姆好物" maxLength={100} /></label>
    <label className="admin-field">本期说明 <span>选填</span><textarea name="description" defaultValue={batch.description || ''} placeholder="补充代购说明、费用和注意事项" rows={3} maxLength={1000} /></label>
    <div className="admin-form-grid">
      <label className="admin-field">截单时间 <span>选填</span><input type="datetime-local" name="cutoffAt" defaultValue={localDate(batch.cutoffAt)} /></label>
      <label className="admin-field">取货时间 <span>选填</span><input type="datetime-local" name="pickupAt" defaultValue={localDate(batch.pickupAt)} /></label>
    </div>
    <label className="admin-field">取货地点 <span>选填</span><input name="pickupLocation" defaultValue={batch.pickupLocation || ''} placeholder="例如：小区南门门卫处" maxLength={200} /></label>
    <label className="admin-field">联系方式 <span>选填</span><input name="contactNote" defaultValue={batch.contactNote || ''} placeholder="代购人的微信或电话" maxLength={300} /></label>
    <label className="admin-checkbox"><input type="checkbox" name="collecting" defaultChecked={batch.collectionEnabled ?? batch.collecting ?? true} /><span>开放本期下单</span></label>
  </>;
}

function batchFields(form) {
  return { title: String(form.get('title') || '').trim(), description: String(form.get('description') || '').trim(), cutoffAt: isoDate(form.get('cutoffAt')), pickupAt: isoDate(form.get('pickupAt')), pickupLocation: String(form.get('pickupLocation') || '').trim(), contactNote: String(form.get('contactNote') || '').trim(), collecting: form.has('collecting'), samsStore: JSON.parse(String(form.get('samsStore') || 'null')), feePolicy: feePolicyFromForm(form), splitRules: splitRulesFromForm(form) };
}

function ProductPicker({ products, defaultIds, splitRules = {}, lockedProductIds = [] }) {
  const [selected, setSelected] = useState(() => new Set([...(defaultIds ?? products.filter(product => product.onSale).map(product => product.id)), ...lockedProductIds]));
  const lockedIds = new Set(lockedProductIds);
  const editing = defaultIds !== undefined;
  const onSaleIds = products.filter(product => product.onSale).map(product => product.id);
  const newOnSaleIds = onSaleIds.filter(id => !selected.has(id));
  const appendedSize = new Set([...selected, ...onSaleIds]).size;
  return <><details className="admin-product-picker">
    <summary><span>本期商品 <strong>{selected.size} 件</strong></span><span className="admin-small">调整商品 <Icon name="arrow" size={15} /></span></summary>
    <div className="admin-picker-actions">{editing && <button type="button" className="admin-link" disabled={!newOnSaleIds.length || appendedSize > 200} onClick={() => setSelected(previous => new Set([...previous, ...onSaleIds]))}>追加新上架商品 ({newOnSaleIds.length})</button>}<button type="button" className="admin-link" onClick={() => setSelected(new Set([...onSaleIds, ...lockedProductIds]))}>选中全部在售</button><button type="button" className="admin-link" onClick={() => setSelected(new Set(lockedProductIds))}>{lockedProductIds.length ? '清空未下单商品' : '清空选择'}</button></div>
    <p className="admin-help admin-picker-help">{editing ? '追加会保留原选择；选中全部在售会替换选择。调整后需点击“保存设置”才会应用。' : '选中全部在售会替换当前选择；创建本期收集页后应用。'}{editing && appendedSize > 200 ? '追加后超过 200 件，请手动调整本期商品。' : ''}</p>
    {lockedProductIds.length > 0 && <p className="admin-help admin-picker-help">已有订单的商品保留在本期，售卖方式已锁定；取消订单也不会解除锁定。</p>}
    <div className="admin-picker-list">{products.map(product => <label className="admin-picker-item" key={product.id}><input type="checkbox" name="productIds" value={product.id} checked={selected.has(product.id)} disabled={lockedIds.has(product.id) || !product.onSale && !selected.has(product.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(product.id); else next.delete(product.id); return next; })} />{lockedIds.has(product.id) && <input type="hidden" name="productIds" value={product.id} />}<span>{product.name}<small>{product.spec} · {product.removedAt ? '已移除 · 仅保留本期历史关联' : product.onSale ? money(product.priceCents) : '待上架'}{lockedIds.has(product.id) ? ' · 已有订单' : ''}</small></span></label>)}</div>
    {!products.length && <p className="admin-help">请先去山姆选品，并在商品库核对售价、审核上架。</p>}
  </details><BatchSplitRules products={products} selectedIds={[...selected]} value={splitRules} lockedProductIds={lockedProductIds} /></>;
}

function ShareCard({ batch, origin, notify }) {
  const [qr, setQR] = useState('');
  const [error, setError] = useState('');
  const link = `${(origin || location.origin).replace(/\/$/, '')}/b/${encodeURIComponent(batch.code)}`;
  useEffect(() => {
    let active = true;
    setQR(''); setError('');
    QRCode.toDataURL(link, { width: 400, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#003A81', light: '#FFFFFF' } }).then(value => { if (active) setQR(value); }).catch(() => { if (active) setError('二维码生成失败，请复制链接分享。'); });
    return () => { active = false; };
  }, [link]);
  return <div className="admin-share-card">
    <div className="admin-qr">{qr ? <img src={qr} alt={`${batch.communityName}${batch.periodLabel || `第${batch.periodNumber}期`}下单二维码`} /> : <span>{error || '正在生成二维码…'}</span>}</div>
    <div className="admin-share-copy"><h3>分享本期收集页</h3><p>把链接或二维码发到小区群，邻居即可选购下单。</p><input className="admin-share-link" value={link} readOnly aria-label="本期收集页链接" onFocus={event => event.currentTarget.select()} /><div className="admin-actions"><button type="button" className="admin-btn primary" onClick={() => copyText(link).then(() => notify('本期链接已复制')).catch(error => notify(error.message, true))}><Icon name="link" size={17} />复制链接</button>{qr && <a className="admin-btn" href={qr} download={`${batch.communityName}-${batch.periodLabel || batch.code}-下单二维码.png`}><Icon name="download" size={17} />下载二维码</a>}<a className="admin-link" href={`/b/${encodeURIComponent(batch.code)}`} target="_blank" rel="noreferrer">预览收集页 <Icon name="arrow" size={14} /></a></div></div>
  </div>;
}

function OrderEditor({ order, batchCode, saving, locked, onSave }) {
  const cancelled = canonicalStatus(order.status) === '已取消';
  const quantityLocked = Boolean(order.split?.settledAt);
  return <form className={`admin-order-line ${cancelled ? 'is-cancelled' : ''}`} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave(batchCode, order.recordId, { quantity: quantityLocked ? order.quantity : Number(data.get('quantity')), status: String(data.get('status')) });
  }}>
    <div className="admin-order-product"><div className="admin-product-title"><strong>{order.productName}</strong>{order.selfSelected && <span className="admin-self-selected">顾客自选</span>}</div><span>{order.spec} · 下单单价 {money(order.priceCents)}/{order.split ? '份' : order.unit || '份'}</span><SplitOrderProgress order={order} /><div className="admin-order-amounts"><span>{order.split ? '成团商品金额' : '商品金额'} <strong>{money(order.amountCents)}</strong></span><span>{feeCategoryLabel(orderFeeCategory(order))}代购费 {formatFeeRate(order.feeRateBps)} <strong>{money(orderFeeAmount(order))}</strong></span><span>应付 <strong>{money(orderPayableAmount(order))}</strong></span></div>{order.note && <span>备注：{order.note}</span>}<small>{dateTime(order.submittedAt)}{order.revision !== order.syncedRevision ? ' · 待同步' : ' · 已同步'}{order.syncError ? ' · 同步失败' : ''}</small>{order.syncError && <span className="admin-inline-error">{typeof order.syncError === 'string' ? order.syncError : order.syncError.message}</span>}</div>
    <label className="admin-compact-field"><span>{order.split ? '报名份数' : '数量'}</span><input type="number" name="quantity" min="0" max="999" step="1" required defaultValue={order.quantity} disabled={locked || quantityLocked} aria-label={`${order.productName}数量`} /></label>
    <label className="admin-compact-field"><span>状态</span><select name="status" defaultValue={canonicalStatus(order.status)} disabled={locked} aria-label={`${order.productName}状态`}>{Object.entries(orderStatuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <div className="admin-line-actions"><button className="admin-btn small" type="submit" disabled={locked}>{saving ? '保存中…' : '保存'}</button>{!cancelled && <button type="button" className="admin-link danger" disabled={locked} onClick={() => onSave(batchCode, order.recordId, { quantity: order.quantity, status: '已取消' })}>删除</button>}</div>
  </form>;
}

function exportOrders(stats, batch) {
  const cell = value => {
    const text = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const cents = value => Number.isSafeInteger(value) ? (value / 100).toFixed(2) : '';
  const rows = [['小区', '期次', '姓名', '手机号', '商品ID', '商品名称', '规格', '单位', '数量', '下单单价', '费用类别', '代购费率', '商品金额', '代购费', '应付金额', '状态', '下单时间', '备注', '售卖方式', '每包份数', '每份规格', '原包装规格', '成团份数', '待拼份数', '未成团份数', '待拼商品金额'], ...stats.orders.map(order => [order.communityName, order.periodLabel, order.name, order.phone, order.productId, order.productName, order.spec, order.split ? '份' : order.unit, order.quantity, cents(order.priceCents), feeCategoryLabel(orderFeeCategory(order)), formatFeeRate(order.feeRateBps), cents(order.amountCents), cents(orderFeeAmount(order)), cents(orderPayableAmount(order)), orderStatuses[order.status] || order.status, order.submittedAt, order.note, order.split ? '按份拼单' : '整包购买', order.split?.partsPerPack ?? '', order.split?.portionSpec ?? '', order.split?.packSpec ?? '', order.split?.formedQuantity ?? '', order.split?.pendingQuantity ?? '', order.split?.unformedQuantity ?? '', cents(order.pendingGoodsCents ?? 0)])];
  const blob = new Blob(['\uFEFF', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `${batch.communityName}-${batch.periodLabel || batch.code}-订单.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Admin() {
  const [authenticated, setAuthenticated] = useState(null);
  const [page, setPage] = useState(pageFromURL);
  const [overview, setOverview] = useState(null);
  const [products, setProducts] = useState([]);
  const [removedProducts, setRemovedProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState('');
  const [communityId, setCommunityId] = useState('');
  const [batchCode, setBatchCode] = useState('');
  const [addCommunity, setAddCommunity] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editBatchCode, setEditBatchCode] = useState('');
  const [deleteBatchTarget, setDeleteBatchTarget] = useState(null);
  const [deleteBatchError, setDeleteBatchError] = useState('');
  const [restoreBatchError, setRestoreBatchError] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [orderView, setOrderView] = useState('purchase');
  const [savingOrder, setSavingOrder] = useState('');
  const [confirmingSplit, setConfirmingSplit] = useState('');
  const [job, setJob] = useState(null);
  const createAttempt = useRef(null);
  const batchLifecycleBusy = useRef(false);
  const deletedBatchesSummary = useRef(null);
  const restoreBatchFeedback = useRef(null);
  const statsRequest = useRef(0);
  const currentBatchCode = useRef(batchCode);
  currentBatchCode.current = batchCode;
  const communities = overview?.communities || [];
  const community = communities.find(item => item.id === communityId);
  const communityBatches = useMemo(() => (overview?.batches || []).filter(batch => batch.communityId === communityId), [overview, communityId]);
  const deletedCommunityBatches = useMemo(() => (overview?.deletedBatches || []).filter(batch => batch.communityId === communityId), [overview, communityId]);
  const selectedBatch = communityBatches.find(batch => batch.code === batchCode);
  const editingBatch = communityBatches.find(batch => batch.code === editBatchCode);
  const activeJob = job?.status === 'running';
  const currentSection = sections.find(section => section.id === page);

  const notify = useCallback((message, isError = false) => setToast({ message, isError }), []);
  const api = useCallback(async (path, options) => {
    try { return await request(path, options); }
    catch (error) { if (error.status === 401) { setAuthenticated(false); setOverview(null); setProducts([]); setRemovedProducts([]); setStats(null); setJob(null); } throw error; }
  }, []);

  const refreshOverview = useCallback(async () => {
    const [nextOverview, catalog] = await Promise.all([api('/overview'), api('/products')]);
    setOverview(nextOverview); setProducts(catalog.products || []); setRemovedProducts(catalog.removedProducts || []);
    return nextOverview;
  }, [api]);

  const refreshStats = useCallback(async code => {
    if (code && code !== currentBatchCode.current) return;
    const requestId = ++statsRequest.current;
    if (!code) { setStats(null); setStatsError(''); setStatsLoading(false); return; }
    setStatsLoading(true); setStatsError('');
    try {
      const value = await api(`/stats?codes=${encodeURIComponent(code)}`);
      if (requestId === statsRequest.current && code === currentBatchCode.current) { setStats(value); return true; }
    } catch (error) { if (requestId === statsRequest.current && code === currentBatchCode.current) { setStatsError(error.message); return false; } }
    finally { if (requestId === statsRequest.current && code === currentBatchCode.current) setStatsLoading(false); }
  }, [api]);

  useEffect(() => {
    let live = true;
    request('/session').then(result => { if (live) setAuthenticated(Boolean(result.authenticated)); }).catch(error => { if (live) { setAuthenticated(false); setError(error.message); } });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    setLoading(true); setError('');
    refreshOverview().catch(error => setError(error.message)).finally(() => setLoading(false));
  }, [authenticated, refreshOverview]);
  useEffect(() => {
    if (overview && !communities.some(item => item.id === communityId)) setCommunityId(communities[0]?.id || '');
  }, [overview, communityId]);
  useEffect(() => {
    if (!communityBatches.some(batch => batch.code === batchCode)) setBatchCode(communityBatches[0]?.code || '');
  }, [communityBatches, batchCode]);
  useEffect(() => {
    setStats(null);
    if (authenticated && page === 'orders') refreshStats(batchCode);
  }, [authenticated, page, batchCode, refreshStats]);
  useEffect(() => {
    const onURL = () => setPage(pageFromURL());
    window.addEventListener('hashchange', onURL);
    window.addEventListener('popstate', onURL);
    return () => { window.removeEventListener('hashchange', onURL); window.removeEventListener('popstate', onURL); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (page !== 'batches') { setCreateOpen(false); setEditBatchCode(''); setDeleteBatchTarget(null); setDeleteBatchError(''); }
  }, [page]);
  useEffect(() => {
    if (restoreBatchError?.communityId === communityId) restoreBatchFeedback.current?.focus();
  }, [restoreBatchError, communityId]);
  useEffect(() => {
    if (!job?.id || job.status !== 'running') return;
    let live = true;
    let timer;
    const poll = async () => {
      try {
        const result = await api(`/jobs/${encodeURIComponent(job.id)}`);
        if (!live) return;
        const next = result.job || result;
        setJob(previous => ({ ...previous, ...next, pollError: '' }));
        if (next.status === 'running') timer = setTimeout(poll, 2000);
        else {
          if (next.status === 'completed') notify(next.result?.pending || next.result?.status === 'pending' ? job.kind === 'products' ? '仍有商品待备份或等待核对，请稍后再备份' : '仍有订单待同步或等待核对，请稍后再同步' : job.kind === 'products' ? '商品飞书备份已完成' : '本期订单同步完成');
          await refreshOverview();
          if (job.batchCode) await refreshStats(job.batchCode);
        }
      } catch (error) {
        if (!live) return;
        setJob(previous => ({ ...previous, pollError: error.message }));
        if (error.status !== 401) timer = setTimeout(poll, 4000);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => { live = false; clearTimeout(timer); };
  }, [job?.id, job?.status, api, notify, refreshOverview, refreshStats]);

  function navigate(next) {
    const url = new URL(location.href);
    url.searchParams.set('view', next); url.hash = '';
    history.pushState(null, '', url);
    setPage(next); setError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function login(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy('login'); setError('');
    try { await request('/login', { method: 'POST', body: JSON.stringify({ password: String(data.get('password') || '') }) }); setAuthenticated(true); }
    catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  async function logout() {
    setBusy('logout');
    try { await api('/logout', { method: 'POST', body: '{}' }); setAuthenticated(false); setOverview(null); setProducts([]); setRemovedProducts([]); setStats(null); setJob(null); }
    catch (error) { notify(error.message, true); }
    finally { setBusy(''); }
  }

  async function createCommunity(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('community'); setError('');
    try {
      const result = await api('/communities', { method: 'POST', body: JSON.stringify({ name: String(form.get('name') || '').trim() }) });
      await refreshOverview(); setCommunityId(result.community.id); setAddCommunity(false); notify('小区已添加');
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  async function createBatch(event) {
    event.preventDefault();
    if (!communityId) return;
    const form = new FormData(event.currentTarget);
    let payload;
    try { payload = { communityId, ...batchFields(form), productIds: form.getAll('productIds').map(String) }; }
    catch (error) { setError(error.message); return; }
    if (!payload.productIds.length) { setError('请至少选择一件本期商品。'); return; }
    setBusy('create'); setError('');
    try {
      const encoded = JSON.stringify(payload);
      if (createAttempt.current?.encoded !== encoded) createAttempt.current = { encoded, requestId: createSubmissionId() };
      const result = await api('/batches', { method: 'POST', body: JSON.stringify({ ...payload, requestId: createAttempt.current.requestId }) });
      await refreshOverview(); setBatchCode(result.batch.code); setCreateOpen(false); createAttempt.current = null; notify(`${result.batch.periodLabel || `第${result.batch.periodNumber}期`}已创建`);
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  async function saveBatch(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = editBatchCode;
    setBusy('edit'); setError('');
    try {
      const fields = batchFields(form);
      const feesChanged = JSON.stringify(fields.feePolicy) !== JSON.stringify(editingBatch?.feePolicy);
      await api(`/batches/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ ...fields, productIds: form.getAll('productIds').map(String) }) });
      await refreshOverview();
      const statsRefreshed = code === currentBatchCode.current ? await refreshStats(code) : undefined;
      setEditBatchCode('');
      notify(statsRefreshed === false ? '本期设置已保存，订单统计暂未刷新，请重新查看本期订单。'
        : feesChanged ? '本期设置已保存，已有订单已按最新代购费率重算。' : '本期设置已保存', statsRefreshed === false);
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  function openBatchDelete(batch) {
    if (!closed(batch) || busy || batchLifecycleBusy.current || activeJob || savingOrder || confirmingSplit) return;
    setCreateOpen(false); setEditBatchCode(''); setError('');
    setDeleteBatchTarget(batch); setDeleteBatchError('');
  }

  function closeBatchDelete() {
    if (batchLifecycleBusy.current) return;
    setDeleteBatchTarget(null); setDeleteBatchError('');
  }

  async function deleteBatch() {
    const batch = deleteBatchTarget;
    if (!batch || batchLifecycleBusy.current || busy) return;
    batchLifecycleBusy.current = true;
    setBusy(`delete-batch:${batch.code}`); setDeleteBatchError('');
    let deleted = false;
    try {
      const result = await api(`/batches/${encodeURIComponent(batch.code)}`, { method: 'DELETE', body: '{}' });
      if (result.deleted !== true || result.batch?.code !== batch.code) throw new Error('删除结果暂时无法确认，请重试。');
      deleted = true;
      if (batch.code === currentBatchCode.current) { statsRequest.current += 1; setStats(null); setStatsError(''); }
      const next = await refreshOverview();
      if (next.batches?.some(item => item.code === batch.code) || !next.deletedBatches?.some(item => item.code === batch.code)) throw new Error('列表尚未确认本期已删除，请重试。');
      setDeleteBatchTarget(null); setDeleteBatchError('');
      requestAnimationFrame(() => deletedBatchesSummary.current?.focus({ preventScroll: true }));
      notify('本期已删除，商品和订单已保留，可在已删除期次恢复');
    } catch (error) {
      setDeleteBatchError(deleted ? `删除已提交，列表暂未核对完成，请重试确认。${error.message}` : error.message);
    } finally { batchLifecycleBusy.current = false; setBusy(''); }
  }

  async function restoreBatch(batch) {
    if (batchLifecycleBusy.current || busy || activeJob || savingOrder || confirmingSplit) return;
    batchLifecycleBusy.current = true;
    setBusy(`restore-batch:${batch.code}`); setError(''); setRestoreBatchError(null);
    let restored = false;
    try {
      const result = await api(`/batches/${encodeURIComponent(batch.code)}/restore`, { method: 'POST', body: '{}' });
      if (result.restored !== true || result.batch?.code !== batch.code) throw new Error('恢复结果暂时无法确认，请重试。');
      restored = true;
      const next = await refreshOverview();
      if (!next.batches?.some(item => item.code === batch.code) || next.deletedBatches?.some(item => item.code === batch.code)) throw new Error('列表尚未确认本期已恢复，请重试。');
      setBatchCode(batch.code);
      deletedBatchesSummary.current?.focus({ preventScroll: true });
      notify('本期已恢复，仍为已截单；需要重新开放时请编辑本期');
    } catch (error) {
      setRestoreBatchError({ communityId: batch.communityId, message: restored ? `恢复已提交，列表暂未核对完成，请重试确认。${error.message}` : error.message });
    }
    finally { batchLifecycleBusy.current = false; setBusy(''); }
  }

  async function startSync(kind) {
    if (activeJob || busy || confirmingSplit) return;
    setBusy(`sync-${kind}`); setError('');
    try {
      const result = await api(kind === 'products' ? '/sync/products/backup' : `/batches/${encodeURIComponent(batchCode)}/sync/orders`, { method: 'POST', body: '{}' });
      setJob({ ...(result.job || result), kind, batchCode: kind === 'orders' ? batchCode : null });
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  async function updateCatalogProducts(changed) {
    const updates = Array.isArray(changed) ? changed : changed ? [changed] : [];
    if (updates.length) setProducts(previous => {
      const merged = new Map(previous.map(product => [product.id, product]));
      for (const product of updates) if (product?.id) merged.set(product.id, product);
      return [...merged.values()].sort((a, b) => (a.sort || 0) - (b.sort || 0));
    });
    try { await refreshOverview(); }
    catch { notify('商品已保存，后台概览暂未刷新，请稍后刷新页面。', true); }
  }

  async function reloadCatalogProducts(catalog) {
    setProducts(catalog.products);
    setRemovedProducts(catalog.removedProducts);
    try {
      setOverview(await api('/overview'));
      return {};
    } catch {
      return { overviewWarning: '商品列表已核对，后台概览暂未刷新，请稍后刷新页面。' };
    }
  }

  async function saveOrder(code, id, patch) {
    if (savingOrder) return;
    setSavingOrder(id); setStatsError('');
    try {
      await api(`/batches/${encodeURIComponent(code)}/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await refreshStats(code); notify(patch.status === '已取消' ? '该项已取消，请同步本期订单更新飞书' : '订单已保存，请同步本期订单更新飞书');
    } catch (error) { setStatsError(error.message); }
    finally { setSavingOrder(''); }
  }

  async function confirmSplit(group, remainderPolicy) {
    if (confirmingSplit || savingOrder || busy || activeJob) return;
    setConfirmingSplit(`${group.batchCode}:${group.productId}`); setStatsError('');
    try {
      await api(`/batches/${encodeURIComponent(group.batchCode)}/split/${encodeURIComponent(group.productId)}/confirm`, { method: 'POST', body: JSON.stringify({ remainderPolicy }) });
      await refreshStats(group.batchCode); await refreshOverview();
      notify('拼单采购已确认，分货名单和应付金额已更新');
    } catch (error) { setStatsError(error.message); }
    finally { setConfirmingSplit(''); }
  }

  function copyPickup(customer) {
    const pickupProducts = new Map();
    for (const order of stats.orders.filter(order => order.phone === customer.phone && !['已取消', '缺货'].includes(canonicalStatus(order.status)))) {
      const quantity = order.split ? order.split.formedQuantity : order.quantity;
      if (!quantity) continue;
      const key = `${order.productId}:${order.split ? 'split' : 'whole'}`;
      const product = pickupProducts.get(key) || { name: order.productName, unit: order.split ? '份' : order.unit || '份', quantity: 0 };
      product.quantity += quantity; pickupProducts.set(key, product);
    }
    const items = [...pickupProducts.values()].map(product => `${product.name} × ${product.quantity}${product.unit}`).join('\n');
    const totals = feeTotals(customer);
    const feeLines = Array.isArray(customer.feeBreakdown) ? customer.feeBreakdown.map(row => `${feeCategoryLabel(row.category)}代购费（${formatFeeRate(row.rateBps)}）：${money(row.feeCents)}`).join('\n') : '';
    const text = `${customer.name}，您好！${selectedBatch.communityName} ${selectedBatch.periodLabel || ''}山姆代购物品：\n${items || '请联系代购确认商品'}\n商品金额：${money(totals.goods)}\n代购费：${money(totals.fee)}${feeLines ? `\n${feeLines}` : ''}\n应付合计：${money(totals.payable)}${customer.pendingGoodsCents > 0 ? `\n另有待拼商品 ${money(customer.pendingGoodsCents)}，尚未计入应付或本次分货。` : ''}${selectedBatch.pickupLocation ? `\n取货地点：${selectedBatch.pickupLocation}` : ''}${selectedBatch.pickupAt ? `\n取货时间：${dateTime(selectedBatch.pickupAt)}` : ''}${selectedBatch.contactNote ? `\n联系代购：${selectedBatch.contactNote}` : ''}`;
    copyText(text).then(() => notify('取货通知已复制，可自行发给顾客')).catch(error => notify(error.message, true));
  }

  if (authenticated === null) return <div className="admin-root admin-loading"><span className="admin-spinner" />正在打开管理后台…</div>;
  if (!authenticated) return <div className="admin-root admin-login"><div className="admin-login-card"><div className="admin-login-mark"><Icon name="bag" size={30} /></div><p className="admin-eyebrow">山姆邻里团购</p><h1>管理你的每一期团购</h1><p className="admin-subtitle">商品、期次与订单，在这里有序安排。</p><form onSubmit={login}><label className="admin-field">管理员密码<input name="password" type="password" autoComplete="current-password" placeholder="请输入管理员密码" required autoFocus disabled={busy === 'login'} /></label>{error && <p className="admin-alert error" role="alert">{error}</p>}<button className="admin-btn primary full" disabled={busy === 'login'}><Icon name="lock" size={18} />{busy === 'login' ? '正在登录…' : '进入管理后台'}</button></form><a className="admin-login-back" href="/">查看收集页面 <Icon name="arrow" size={15} /></a></div></div>;

  return <div className="admin-root"><div className="admin-layout">
    <aside className="admin-sidebar"><a href="/admin" className="admin-brand"><span><Icon name="bag" size={25} /></span><div>山姆邻里团购<small>管理后台</small></div></a><nav aria-label="后台导航">{sections.map(section => <button type="button" key={section.id} className={page === section.id ? 'selected' : ''} aria-current={page === section.id ? 'page' : undefined} onClick={() => navigate(section.id)}><Icon name={section.icon} /><span>{section.title}</span><Icon name="arrow" size={15} /></button>)}</nav><div className="admin-sidebar-bottom"><p>每一期，从这里开始。</p><button type="button" className="admin-logout" onClick={logout} disabled={busy === 'logout'}><Icon name="exit" size={17} />退出登录</button></div></aside>
    <div className="admin-workspace"><header className="admin-mobile-header"><a className="admin-brand" href="/admin"><span><Icon name="bag" size={21} /></span><div>山姆邻里团购<small>管理后台</small></div></a><button className="admin-btn small" type="button" onClick={logout} disabled={busy === 'logout'}>退出</button></header><main className="admin-main">
      <div className="admin-page-heading"><div><p className="admin-eyebrow">邻里的需求，心里有数</p><h1>{currentSection.title}</h1><p className="admin-subtitle">{currentSection.description}</p></div>{overview?.feishuUrl && <a className="admin-btn" href={overview.feishuUrl} target="_blank" rel="noreferrer">打开飞书表格 <Icon name="arrow" size={16} /></a>}</div>
      {error && !createOpen && !editingBatch && <div className="admin-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" size={17} /></button></div>}
      {job && <div className={`admin-alert ${job.status === 'failed' || job.pollError ? 'error' : job.result?.pending || job.result?.status === 'pending' ? 'warning' : 'success'}`} role={job.status === 'failed' ? 'alert' : 'status'}>{job.status === 'running' ? <span className="admin-spinner" /> : <Icon name={job.status === 'completed' ? 'check' : 'sync'} size={18} />}<span>{job.kind === 'products' ? '商品飞书备份' : '本期订单同步'}{job.status === 'running' ? '进行中，请稍候…' : job.status === 'completed' ? job.result?.pending || job.result?.status === 'pending' ? job.kind === 'products' ? '仍有商品待备份或等待核对，请稍后再备份' : '仍有订单待同步或等待核对，请稍后再同步' : '已完成' : '未完成'}{job.error && `：${typeof job.error === 'string' ? job.error : job.error.message}`}{job.pollError && `。正在重新确认结果：${job.pollError}`}{job.result?.error && `。${typeof job.result.error === 'string' ? job.result.error : job.result.error.message}`}{job.result?.counts && `（${job.kind === 'products' ? `新增备份 ${job.result.counts.created || job.result.counts.added || 0} 件，更新 ${job.result.counts.updated || 0} 件${job.result.counts.pending ? `，待备份 ${job.result.counts.pending} 件` : ''}` : `新增 ${job.result.counts.created || 0} 条，更新 ${job.result.counts.updated || 0} 条，待同步 ${job.result.counts.pending || 0} 条`}）`}</span>{job.status !== 'running' && <button type="button" onClick={() => setJob(null)} aria-label="关闭同步结果"><Icon name="close" size={17} /></button>}</div>}
      {loading && !overview ? <div className="admin-loading"><span className="admin-spinner" />正在加载…</div> : !overview ? <Empty title="暂时无法加载后台">{error || '请刷新页面重试。'}</Empty> : <>
        {['batches', 'orders'].includes(page) && <div className="admin-context"><label className="admin-context-field"><span>当前小区</span><select value={communityId} onChange={event => { setCommunityId(event.target.value); setCreateOpen(false); setEditBatchCode(''); }} aria-label="选择小区">{!communities.length && <option value="">请先添加小区</option>}{communities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{page === 'orders' && <label className="admin-context-field"><span>团购期次</span><select value={batchCode} onChange={event => setBatchCode(event.target.value)} aria-label="选择团购期次">{!communityBatches.length && <option value="">暂无期次</option>}{communityBatches.map(batch => <option key={batch.code} value={batch.code}>{batch.periodLabel || `第${batch.periodNumber}期`}{batch.title ? ` · ${batch.title}` : ''}</option>)}</select></label>}{page === 'batches' && <button className="admin-btn" type="button" onClick={() => setAddCommunity(value => !value)} disabled={Boolean(busy)}><Icon name="plus" size={17} />添加小区</button>}</div>}
        {page === 'batches' && <>
          {(addCommunity || !communities.length) && <form className="admin-add-community" onSubmit={createCommunity}><label className="admin-field">小区名称<input name="name" placeholder="例如：幸福花园" maxLength={80} required autoFocus /></label><div className="admin-actions"><button className="admin-btn primary" disabled={Boolean(busy)}>{busy === 'community' ? '添加中…' : '添加小区'}</button>{communities.length > 0 && <button className="admin-btn" type="button" onClick={() => setAddCommunity(false)}>取消</button>}</div></form>}
          <div className="admin-section-heading"><div><h2>{community?.name || '团购期次'}<span>{communityBatches.length} 期</span></h2><p>本期商品范围独立；商品资料与售价以本地商品库为准。</p></div><button type="button" className="admin-btn primary" disabled={!communityId || Boolean(busy)} onClick={() => { setCreateOpen(true); setEditBatchCode(''); setError(''); }}><Icon name="plus" size={18} />新建一期</button></div>
          {createOpen && <BatchDrawer title="新建一期" description={`${community?.name} · 第 ${community?.nextPeriodNumber || 1} 期，默认包含全部在售商品。`} busy={Boolean(busy)} error={error} submitLabel={busy === 'create' ? '创建中…' : '创建本期收集页'} submitDisabled={!products.some(product => product.onSale)} onSubmit={createBatch} onClose={() => { setCreateOpen(false); setError(''); }}><ProductPicker products={products} /><OptionalBatchFields api={api} /></BatchDrawer>}
          {!communityBatches.length ? <Empty icon="calendar" title={community ? community.nextPeriodNumber > 1 || deletedCommunityBatches.length > 0 ? '为这个小区开新一期' : '为这个小区开第一期' : '先添加一个小区'}>{community ? '选择本期商品、补充取货信息，再把收集页发到群里。' : '添加小区后，每个小区会自动从第 1 期开始编号。'}</Empty> : <div className="admin-batch-layout"><div className="admin-batch-list">{communityBatches.map(batch => <button className={`admin-batch-card ${batchCode === batch.code ? 'selected' : ''}`} type="button" key={batch.code} onClick={() => { setBatchCode(batch.code); setEditBatchCode(''); }}><div><span className="admin-period">{batch.periodLabel || `第${batch.periodNumber}期`}</span><BatchBadge batch={batch} /></div><h3>{batch.title || `${batch.communityName}山姆代购`}</h3><p>{batch.productIds?.length ?? products.filter(product => product.onSale).length} 件商品 <span>·</span> 截单 {dateTime(batch.cutoffAt)}</p><p className="admin-batch-store-note">{batch.samsStore ? `采购门店：${batch.samsStore.name}` : '未开启顾客自选'}</p><p className="admin-batch-fee-note">代购费：{batchFeeSummary(batch)}</p>{Object.keys(batch.splitRules || {}).length > 0 && <p className="admin-batch-split-note">按份拼单：{Object.keys(batch.splitRules).length} 件</p>}<small>{batch.pickupLocation || '取货地点待填写'}<Icon name="arrow" size={17} /></small></button>)}</div>{selectedBatch && <div className="admin-batch-detail"><ShareCard batch={selectedBatch} origin={overview.shareOrigin} notify={notify} /><section className="admin-card"><div className="admin-card-heading"><h2>本期安排</h2><button type="button" className="admin-link" onClick={() => { setCreateOpen(false); setEditBatchCode(batchCode); setError(''); }} disabled={Boolean(busy)}>编辑本期</button></div><dl className="admin-batch-info"><div className="wide"><dt>本期采购门店</dt><dd>{selectedBatch.samsStore ? `${selectedBatch.samsStore.cityName} · ${selectedBatch.samsStore.name}` : '未设置 · 顾客自选未开启'}</dd><p className="admin-help admin-batch-store-help">{selectedBatch.samsStore ? '每期固定门店，自选商品按山姆查询价核对。' : '本期推荐商品仍可下单。'}</p></div><div><dt>推荐商品代购费率</dt><dd>{formatFeeRate(resolveFeeRates(selectedBatch.feePolicy).recommended)}</dd></div><div><dt>自选商品代购费率</dt><dd>{formatFeeRate(resolveFeeRates(selectedBatch.feePolicy).selfSelected)}{resolveFeeRates(selectedBatch.feePolicy).follows ? ' · 跟随推荐' : ''}</dd></div><div className="wide"><p className="admin-help">本期所有订单按当前代购费率计算；保存新比例后，已有订单的代购费和应付金额同步重算。</p></div><BatchSplitSummary batch={selectedBatch} products={products} /><div><dt>截单时间</dt><dd>{dateTime(selectedBatch.cutoffAt)}</dd></div><div><dt>取货时间</dt><dd>{dateTime(selectedBatch.pickupAt)}</dd></div><div><dt>取货地点</dt><dd>{selectedBatch.pickupLocation || '未设置'}</dd></div><div><dt>联系方式</dt><dd>{selectedBatch.contactNote || '未设置'}</dd></div>{selectedBatch.description && <div className="wide"><dt>本期说明</dt><dd>{selectedBatch.description}</dd></div>}</dl><div className="admin-card-footer admin-batch-actions-footer"><button className="admin-btn" type="button" onClick={() => navigate('orders')}>查看本期订单 <Icon name="arrow" size={16} /></button>{closed(selectedBatch) && <button className="admin-btn batch-delete-action" type="button" disabled={Boolean(busy) || activeJob || Boolean(savingOrder) || Boolean(confirmingSplit)} onClick={() => openBatchDelete(selectedBatch)}>删除本期</button>}</div></section></div>}</div>}
          {editingBatch && <BatchDrawer key={editingBatch.code} title="编辑本期" description={`${editingBatch.communityName} · ${editingBatch.periodLabel || `第${editingBatch.periodNumber}期`}`} busy={Boolean(busy)} error={error} submitLabel={busy === 'edit' ? '保存中…' : '保存设置'} onSubmit={saveBatch} onClose={() => { setEditBatchCode(''); setError(''); }}><ProductPicker products={[...products, ...removedProducts.filter(product => (editingBatch.productIds || []).includes(product.id))]} defaultIds={editingBatch.productIds} splitRules={editingBatch.splitRules} lockedProductIds={editingBatch.splitLockedProductIds} /><OptionalBatchFields batch={editingBatch} api={api} /></BatchDrawer>}
          {communityId && <details className="admin-deleted-batches" key={`deleted:${communityId}`}><summary ref={deletedBatchesSummary}>已删除期次（{deletedCommunityBatches.length}）</summary>{restoreBatchError?.communityId === communityId && <div className="admin-alert error" ref={restoreBatchFeedback} role="alert" tabIndex={-1}>{restoreBatchError.message}</div>}<p className="admin-help">商品与订单保留。恢复后仍为已截单，重新开放请编辑本期。</p>{deletedCommunityBatches.length ? <ul className="admin-deleted-batch-list">{deletedCommunityBatches.map(batch => <li key={batch.code}><div><strong>{batch.periodLabel || `第${batch.periodNumber}期`}{batch.title ? ` · ${batch.title}` : ''}</strong><small>{batch.communityName} · 删除于 {dateTime(batch.deletedAt)}</small></div><button type="button" className="admin-btn small" disabled={Boolean(busy) || activeJob || Boolean(savingOrder) || Boolean(confirmingSplit)} onClick={() => restoreBatch(batch)} aria-label={`恢复${batch.communityName}${batch.periodLabel || `第${batch.periodNumber}期`}`}>{busy === `restore-batch:${batch.code}` ? '恢复中…' : '恢复本期'}</button></li>)}</ul> : <p className="admin-help">当前小区暂无已删除期次。</p>}</details>}
          {deleteBatchTarget && <BatchDeleteDialog batch={deleteBatchTarget} busy={Boolean(busy)} error={deleteBatchError} onConfirm={deleteBatch} onClose={closeBatchDelete} />}
        </>}
        {page === 'feishu' && <FeishuConfig api={api} onSaved={refreshOverview} notify={notify} />}
        {page === 'selection' && <SamsSelection api={api} products={products} onAdded={result => updateCatalogProducts(result.products)} notify={notify} onCatalog={() => navigate('products')} />}
        {page === 'products' && <ProductCatalog products={products} removedProducts={removedProducts} batches={overview.batches} api={api} onUpdated={updateCatalogProducts} onCatalogReloaded={reloadCatalogProducts} notify={notify} onSelection={() => navigate('selection')} onBatches={() => navigate('batches')} startBackup={() => startSync('products')} backupBusy={activeJob || Boolean(busy)} backup={overview.productSync?.backup || overview.productSync} />}
        {page === 'orders' && <>
          {!selectedBatch ? <Empty icon="list" title="请选择一个团购期次">先在“团购期次”创建本期收集页。</Empty> : <>
            <section className="admin-order-toolbar"><div><BatchBadge batch={selectedBatch} /><h2>{selectedBatch.communityName} · {selectedBatch.periodLabel || `第${selectedBatch.periodNumber}期`}</h2><p>每个群独立订单表，同群各期分开查看，首次同步自动建表。订单保存在本地，分装采购与分货以本地清单为准。</p></div><div className="admin-actions"><button type="button" className="admin-btn" disabled={!stats || statsLoading || !stats.orders.length || Boolean(confirmingSplit)} onClick={() => exportOrders(stats, selectedBatch)}><Icon name="download" size={17} />导出 CSV</button><button type="button" className="admin-btn primary" onClick={() => startSync('orders')} disabled={activeJob || Boolean(busy) || Boolean(confirmingSplit) || !stats}><Icon name="sync" size={17} />{job?.kind === 'orders' && activeJob || busy === 'sync-orders' ? '同步中…' : '同步本期订单到飞书'}</button></div></section>
            <GroupOrderSyncTarget sync={overview.ordersSync?.[batchCode]} onConfigure={() => navigate('feishu')} />
            {statsError && <div className="admin-alert error" role="alert">{statsError}<button type="button" className="admin-link" onClick={() => refreshStats(batchCode)}>重试</button></div>}
            {stats && <><div className="admin-metrics admin-fee-metrics"><div><span>下单顾客</span><strong>{stats.customers.length}<small>位</small></strong></div><div><span>确认采购数量</span><strong>{stats.products.reduce((sum, product) => sum + product.quantity, 0)}<small>件</small></strong></div><div><span>商品金额</span><strong>{money(feeTotals(stats).goods)}</strong></div><div><span>代购费</span><strong>{money(feeTotals(stats).fee)}</strong><p>推荐 {money(stats.recommendedFeeCents === undefined ? 0 : stats.recommendedFeeCents)} · 自选 {money(stats.selfSelectedFeeCents === undefined ? 0 : stats.selfSelectedFeeCents)}</p></div><div className="is-payable"><span>应付金额</span><strong>{money(stats.totalCents)}</strong></div><div className={stats.dirtyCount > 0 ? 'has-pending' : ''}><span>待同步明细</span><strong>{stats.dirtyCount}<small>条</small></strong></div></div><div className="admin-stat-meta"><span>应付按整包商品和已成团份数计算；待拼、未成团、缺货和已取消项不收费。采购汇总按原包装统计。</span><button className="admin-link" type="button" disabled={statsLoading} onClick={() => refreshStats(batchCode)}><Icon name="sync" size={15} />{statsLoading ? '刷新中…' : '刷新订单'}</button></div>{stats.orders.some(order => order.syncError) && <div className="admin-alert error">有 {stats.orders.filter(order => order.syncError).length} 条明细同步失败，请展开顾客订单查看原因并重试同步。</div>}
              {stats.pendingGoodsCents > 0 && <p className="admin-split-pending-bill">待拼商品金额 <strong>{money(stats.pendingGoodsCents)}</strong>，尚未计入应付；截单确认后按成团份数计算。</p>}<SplitGroups groups={stats.splitGroups} onConfirm={confirmSplit} confirming={confirmingSplit} locked={Boolean(busy) || activeJob || Boolean(savingOrder)} /><div className="admin-tabs" role="tablist" aria-label="订单统计方式"><button role="tab" id="purchase-tab" aria-selected={orderView === 'purchase'} aria-controls="purchase-panel" className={orderView === 'purchase' ? 'selected' : ''} onClick={() => setOrderView('purchase')}>采购汇总<span>{stats.products.length}</span></button><button role="tab" id="customers-tab" aria-selected={orderView === 'customers'} aria-controls="customers-panel" className={orderView === 'customers' ? 'selected' : ''} onClick={() => setOrderView('customers')}>顾客订单<span>{stats.customers.length}</span></button></div>
              {orderView === 'purchase' ? <section id="purchase-panel" role="tabpanel" aria-labelledby="purchase-tab">{!stats.products.length ? <Empty icon="list" title="暂时没有需要采购的商品">邻居下单后，这里会按商品汇总数量。</Empty> : <div className="admin-card admin-purchase-table"><div className="admin-table-head"><span>商品</span><span>采购数量</span><span>原包装参考价</span><span>采购参考金额</span></div>{stats.products.map(product => <div className="admin-purchase-row" key={product.id}><div className="admin-product-name"><ProductImage product={product} /><div><div className="admin-product-title"><strong>{product.name}</strong>{product.selfSelected && <span className="admin-self-selected">顾客自选</span>}</div><small>{product.spec}{product.split ? " · 按份拼单，整包采购" : ""}</small></div></div><strong>{product.quantity}<small> {product.unit || '份'}</small></strong><span>{product.mixedPrices ? '多次报价' : <>{money(product.priceCents)}<small> {product.priceSource === 'reference' ? '原价参考' : '售价参考'}</small></>}</span><strong>{money(product.amountCents)}</strong></div>)}</div>}</section> : <section id="customers-panel" role="tabpanel" aria-labelledby="customers-tab"><p className="admin-help admin-cancel-help">可修改数量和状态。拼单确认采购后，报名份数锁定，仍可修改状态。商品保留下单单价，代购费跟随本期当前比例；删除会标记为“已取消”，待拼、未成团、缺货和已取消部分不收费。</p>{!stats.customers.length ? <Empty icon="list" title="本期还没有顾客下单">收到订单后，可在这里按手机号查看和管理。</Empty> : <div className="admin-customer-list">{stats.customers.map(customer => <details className="admin-card admin-customer" key={customer.key || customer.phone}><summary><div><strong>{customer.name}</strong><span>{customer.phone}</span><small>{customer.products.filter(product => activeQuantity(product) > 0).map(product => `${product.name} × ${activeQuantity(product)}`).join('、') || (customer.pendingQuantity > 0 ? `待拼 ${customer.pendingQuantity} 份，尚未计入应付` : '暂无需要采购的商品')}</small></div><div className="admin-customer-total"><strong>{money(customer.totalCents)}<small>应付金额</small></strong><Icon name="arrow" size={18} /></div></summary><div className="admin-customer-details"><CustomerFeeBill customer={customer} money={money} />{customer.pendingGoodsCents > 0 && <p className="admin-split-pending-bill">待拼商品金额 <strong>{money(customer.pendingGoodsCents)}</strong>，尚未计入应付。</p>}{stats.orders.filter(order => order.phone === customer.phone).map(order => <OrderEditor key={`${order.recordId}:${order.revision}`} order={order} batchCode={order.batchCode} saving={savingOrder === order.recordId} locked={Boolean(savingOrder) || Boolean(confirmingSplit)} onSave={saveOrder} />)}<div className="admin-customer-footer"><span>取货通知由你确认后自行发送。</span><button type="button" className="admin-btn small" onClick={() => copyPickup(customer)}><Icon name="link" size={15} />复制取货通知</button></div></div></details>)}</div>}</section>}
            </>}{statsLoading && !stats && <div className="admin-loading"><span className="admin-spinner" />正在加载本期订单…</div>}
          </>}
        </>}
      </>}
      <footer className="admin-footer">山姆邻里团购 · 把每一期安排好</footer>
    </main></div>
    <nav className="admin-mobile-nav" aria-label="手机后台导航">{sections.map(section => <button type="button" className={page === section.id ? 'selected' : ''} key={section.id} aria-current={page === section.id ? 'page' : undefined} onClick={() => navigate(section.id)}><Icon name={section.icon} size={21} /><span>{section.title}</span></button>)}</nav>
    {toast && <div className={`admin-toast ${toast.isError ? 'error' : ''}`} role="status">{toast.message}</div>}
  </div></div>;
}
