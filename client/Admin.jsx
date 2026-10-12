import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { createSubmissionId } from './submission-id.js';
import FeishuConfig from './FeishuConfig.jsx';
import './admin.css';

const sections = [
  { id: 'batches', title: '团购期次', icon: 'calendar', description: '按小区开新一期，分享给群里的邻居。' },
  { id: 'products', title: '商品库', icon: 'box', description: '在飞书维护商品，在这里同步并查看。' },
  { id: 'orders', title: '订单统计', icon: 'list', description: '查看采购清单、管理订单，再同步到飞书。' },
  { id: 'feishu', title: '飞书配置', icon: 'settings', description: '连接商品来源与订单表，按需手动同步。' },
];
const orderStatuses = { 待采购: '待采购', 已买到: '已买到', 缺货: '缺货', 已领取: '已领取', 已取消: '已取消' };
const legacyStatuses = { pending: '待采购', purchased: '已买到', out_of_stock: '缺货', collected: '已领取', cancelled: '已取消', canceled: '已取消' };
const canonicalStatus = value => legacyStatuses[value] || value;
const activeQuantity = product => product.statuses?.length ? product.statuses.filter(item => !['已取消', '缺货'].includes(canonicalStatus(item.status))).reduce((sum, item) => sum + item.quantity, 0) : product.quantity;
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

function Icon({ name, size = 20 }) {
  const paths = {
    bag: <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" /></>,
    box: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9M7 5.8l9 5" /></>,
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

function OptionalBatchFields({ batch = {} }) {
  return <>
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
  return { title: String(form.get('title') || '').trim(), description: String(form.get('description') || '').trim(), cutoffAt: isoDate(form.get('cutoffAt')), pickupAt: isoDate(form.get('pickupAt')), pickupLocation: String(form.get('pickupLocation') || '').trim(), contactNote: String(form.get('contactNote') || '').trim(), collecting: form.has('collecting') };
}

function ProductPicker({ products, defaultIds }) {
  const [selected, setSelected] = useState(() => new Set(defaultIds ?? products.filter(product => product.onSale).map(product => product.id)));
  return <details className="admin-product-picker">
    <summary><span>本期商品 <strong>{selected.size} 件</strong></span><span className="admin-small">调整商品 <Icon name="arrow" size={15} /></span></summary>
    <div className="admin-picker-actions"><button type="button" className="admin-link" onClick={() => setSelected(new Set(products.filter(product => product.onSale).map(product => product.id)))}>选中全部在售</button><button type="button" className="admin-link" onClick={() => setSelected(new Set())}>清空选择</button></div>
    <div className="admin-picker-list">{products.map(product => <label className="admin-picker-item" key={product.id}><input type="checkbox" name="productIds" value={product.id} checked={selected.has(product.id)} disabled={!product.onSale && !selected.has(product.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(product.id); else next.delete(product.id); return next; })} /><span>{product.name}<small>{product.spec} · {product.onSale ? money(product.priceCents) : '已下架'}</small></span></label>)}</div>
    {!products.length && <p className="admin-help">请先从飞书同步商品。</p>}
  </details>;
}

function ShareCard({ batch, origin, notify }) {
  const [qr, setQR] = useState('');
  const [error, setError] = useState('');
  const link = `${(origin || location.origin).replace(/\/$/, '')}/b/${encodeURIComponent(batch.code)}`;
  useEffect(() => {
    let active = true;
    setQR(''); setError('');
    QRCode.toDataURL(link, { width: 400, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#174F38', light: '#FFFFFF' } }).then(value => { if (active) setQR(value); }).catch(() => { if (active) setError('二维码生成失败，请复制链接分享。'); });
    return () => { active = false; };
  }, [link]);
  return <div className="admin-share-card">
    <div className="admin-qr">{qr ? <img src={qr} alt={`${batch.communityName}${batch.periodLabel || `第${batch.periodNumber}期`}下单二维码`} /> : <span>{error || '正在生成二维码…'}</span>}</div>
    <div className="admin-share-copy"><h3>分享本期收集页</h3><p>把链接或二维码发到小区群，邻居即可选购下单。</p><input className="admin-share-link" value={link} readOnly aria-label="本期收集页链接" onFocus={event => event.currentTarget.select()} /><div className="admin-actions"><button type="button" className="admin-btn primary" onClick={() => copyText(link).then(() => notify('本期链接已复制')).catch(error => notify(error.message, true))}><Icon name="link" size={17} />复制链接</button>{qr && <a className="admin-btn" href={qr} download={`${batch.communityName}-${batch.periodLabel || batch.code}-下单二维码.png`}><Icon name="download" size={17} />下载二维码</a>}<a className="admin-link" href={`/b/${encodeURIComponent(batch.code)}`} target="_blank" rel="noreferrer">预览收集页 <Icon name="arrow" size={14} /></a></div></div>
  </div>;
}

function OrderEditor({ order, batchCode, saving, locked, onSave }) {
  const cancelled = canonicalStatus(order.status) === '已取消';
  return <form className={`admin-order-line ${cancelled ? 'is-cancelled' : ''}`} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave(batchCode, order.recordId, { quantity: Number(data.get('quantity')), status: String(data.get('status')) });
  }}>
    <div className="admin-order-product"><strong>{order.productName}</strong><span>{order.spec} · {money(order.priceCents)}/{order.unit || '份'}</span>{order.note && <span>备注：{order.note}</span>}<small>{dateTime(order.submittedAt)}{order.revision !== order.syncedRevision ? ' · 待同步' : ' · 已同步'}{order.syncError ? ' · 同步失败' : ''}</small>{order.syncError && <span className="admin-inline-error">{typeof order.syncError === 'string' ? order.syncError : order.syncError.message}</span>}</div>
    <label className="admin-compact-field"><span>数量</span><input type="number" name="quantity" min="0" max="999" step="1" required defaultValue={order.quantity} disabled={locked} aria-label={`${order.productName}数量`} /></label>
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
  const rows = [['小区', '期次', '姓名', '手机号', '商品ID', '商品名称', '规格', '单位', '数量', '当前单价', '金额', '状态', '下单时间', '备注'], ...stats.orders.map(order => [order.communityName, order.periodLabel, order.name, order.phone, order.productId, order.productName, order.spec, order.unit, order.quantity, (order.priceCents / 100).toFixed(2), (order.amountCents / 100).toFixed(2), orderStatuses[order.status] || order.status, order.submittedAt, order.note])];
  const blob = new Blob(['\uFEFF', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `${batch.communityName}-${batch.periodLabel || batch.code}-订单.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Admin() {
  const [authenticated, setAuthenticated] = useState(null);
  const [page, setPage] = useState(() => sections.some(section => section.id === location.hash.slice(1)) ? location.hash.slice(1) : 'batches');
  const [overview, setOverview] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState('');
  const [communityId, setCommunityId] = useState('');
  const [batchCode, setBatchCode] = useState('');
  const [addCommunity, setAddCommunity] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editBatchCode, setEditBatchCode] = useState('');
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [orderView, setOrderView] = useState('purchase');
  const [savingOrder, setSavingOrder] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [job, setJob] = useState(null);
  const createAttempt = useRef(null);
  const statsRequest = useRef(0);
  const currentBatchCode = useRef(batchCode);
  currentBatchCode.current = batchCode;
  const communities = overview?.communities || [];
  const community = communities.find(item => item.id === communityId);
  const communityBatches = useMemo(() => (overview?.batches || []).filter(batch => batch.communityId === communityId), [overview, communityId]);
  const selectedBatch = communityBatches.find(batch => batch.code === batchCode);
  const editingBatch = communityBatches.find(batch => batch.code === editBatchCode);
  const activeJob = job?.status === 'running';
  const currentSection = sections.find(section => section.id === page);

  const notify = useCallback((message, isError = false) => setToast({ message, isError }), []);
  const api = useCallback(async (path, options) => {
    try { return await request(path, options); }
    catch (error) { if (error.status === 401) { setAuthenticated(false); setOverview(null); setProducts([]); setStats(null); setJob(null); } throw error; }
  }, []);

  const refreshOverview = useCallback(async () => {
    const [nextOverview, catalog] = await Promise.all([api('/overview'), api('/products')]);
    setOverview(nextOverview); setProducts(catalog.products || []);
    return nextOverview;
  }, [api]);

  const refreshStats = useCallback(async code => {
    if (code && code !== currentBatchCode.current) return;
    const requestId = ++statsRequest.current;
    if (!code) { setStats(null); setStatsError(''); setStatsLoading(false); return; }
    setStatsLoading(true); setStatsError('');
    try {
      const value = await api(`/stats?codes=${encodeURIComponent(code)}`);
      if (requestId === statsRequest.current && code === currentBatchCode.current) setStats(value);
    } catch (error) { if (requestId === statsRequest.current && code === currentBatchCode.current) setStatsError(error.message); }
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
    const onHash = () => setPage(sections.some(section => section.id === location.hash.slice(1)) ? location.hash.slice(1) : 'batches');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
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
          if (next.status === 'completed') notify(job.kind === 'products' ? '商品同步完成' : next.result?.pending || next.result?.status === 'pending' ? '仍有订单待同步或等待核对，请稍后再同步' : '本期订单同步完成');
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
    location.hash = next;
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
    try { await api('/logout', { method: 'POST', body: '{}' }); setAuthenticated(false); setOverview(null); setProducts([]); setStats(null); setJob(null); }
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
    const payload = { communityId, ...batchFields(form), productIds: form.getAll('productIds').map(String) };
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
    setBusy('edit'); setError('');
    try {
      await api(`/batches/${encodeURIComponent(editBatchCode)}`, { method: 'PATCH', body: JSON.stringify({ ...batchFields(form), productIds: form.getAll('productIds').map(String) }) });
      await refreshOverview(); setEditBatchCode(''); notify('本期设置已保存');
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  async function startSync(kind) {
    if (activeJob || busy) return;
    setBusy(`sync-${kind}`); setError('');
    try {
      const result = await api(kind === 'products' ? '/sync/products' : `/batches/${encodeURIComponent(batchCode)}/sync/orders`, { method: 'POST', body: '{}' });
      setJob({ ...(result.job || result), kind, batchCode: kind === 'orders' ? batchCode : null });
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
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

  function copyPickup(customer) {
    const items = customer.products.filter(product => activeQuantity(product) > 0).map(product => `${product.name} × ${activeQuantity(product)}${product.unit || '份'}`).join('\n');
    const text = `${customer.name}，您好！${selectedBatch.communityName} ${selectedBatch.periodLabel || ''}山姆代购物品：\n${items || '请联系代购确认商品'}\n合计：${money(customer.totalCents)}${selectedBatch.pickupLocation ? `\n取货地点：${selectedBatch.pickupLocation}` : ''}${selectedBatch.pickupAt ? `\n取货时间：${dateTime(selectedBatch.pickupAt)}` : ''}${selectedBatch.contactNote ? `\n联系代购：${selectedBatch.contactNote}` : ''}`;
    copyText(text).then(() => notify('取货通知已复制，可自行发给顾客')).catch(error => notify(error.message, true));
  }

  if (authenticated === null) return <div className="admin-root admin-loading"><span className="admin-spinner" />正在打开管理后台…</div>;
  if (!authenticated) return <div className="admin-root admin-login"><div className="admin-login-card"><div className="admin-login-mark"><Icon name="bag" size={30} /></div><p className="admin-eyebrow">山姆邻里团购</p><h1>管理你的每一期团购</h1><p className="admin-subtitle">商品、期次与订单，在这里有序安排。</p><form onSubmit={login}><label className="admin-field">管理员密码<input name="password" type="password" autoComplete="current-password" placeholder="请输入管理员密码" required autoFocus disabled={busy === 'login'} /></label>{error && <p className="admin-alert error" role="alert">{error}</p>}<button className="admin-btn primary full" disabled={busy === 'login'}><Icon name="lock" size={18} />{busy === 'login' ? '正在登录…' : '进入管理后台'}</button></form><a className="admin-login-back" href="/">查看收集页面 <Icon name="arrow" size={15} /></a></div></div>;

  return <div className="admin-root"><div className="admin-layout">
    <aside className="admin-sidebar"><a href="/admin" className="admin-brand"><span><Icon name="bag" size={25} /></span><div>山姆邻里团购<small>管理后台</small></div></a><nav aria-label="后台导航">{sections.map(section => <button type="button" key={section.id} className={page === section.id ? 'selected' : ''} aria-current={page === section.id ? 'page' : undefined} onClick={() => navigate(section.id)}><Icon name={section.icon} /><span>{section.title}</span><Icon name="arrow" size={15} /></button>)}</nav><div className="admin-sidebar-bottom"><p>每一期，从这里开始。</p><button type="button" className="admin-logout" onClick={logout} disabled={busy === 'logout'}><Icon name="exit" size={17} />退出登录</button></div></aside>
    <div className="admin-workspace"><header className="admin-mobile-header"><a className="admin-brand" href="/admin"><span><Icon name="bag" size={21} /></span><div>山姆邻里团购<small>管理后台</small></div></a><button className="admin-btn small" type="button" onClick={logout} disabled={busy === 'logout'}>退出</button></header><main className="admin-main">
      <div className="admin-page-heading"><div><p className="admin-eyebrow">邻里的需求，心里有数</p><h1>{currentSection.title}</h1><p className="admin-subtitle">{currentSection.description}</p></div>{overview?.feishuUrl && <a className="admin-btn" href={overview.feishuUrl} target="_blank" rel="noreferrer">打开飞书表格 <Icon name="arrow" size={16} /></a>}</div>
      {error && <div className="admin-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" size={17} /></button></div>}
      {job && <div className={`admin-alert ${job.status === 'failed' || job.pollError ? 'error' : job.result?.pending || job.result?.status === 'pending' ? 'warning' : 'success'}`} role={job.status === 'failed' ? 'alert' : 'status'}>{job.status === 'running' ? <span className="admin-spinner" /> : <Icon name={job.status === 'completed' ? 'check' : 'sync'} size={18} />}<span>{job.kind === 'products' ? '商品同步' : '本期订单同步'}{job.status === 'running' ? '进行中，请稍候…' : job.status === 'completed' ? job.result?.pending || job.result?.status === 'pending' ? '仍有待同步或等待核对的订单，请稍后再同步' : '已完成' : '未完成'}{job.error && `：${typeof job.error === 'string' ? job.error : job.error.message}`}{job.pollError && `。正在重新确认结果：${job.pollError}`}{job.result?.error && `。${typeof job.result.error === 'string' ? job.result.error : job.result.error.message}`}{job.result?.counts && `（${job.kind === 'products' ? `新增 ${job.result.counts.added || 0} 件，更新 ${job.result.counts.updated || 0} 件，下架 ${job.result.counts.offSale || 0} 件` : `新增 ${job.result.counts.created || 0} 条，更新 ${job.result.counts.updated || 0} 条，待同步 ${job.result.counts.pending || 0} 条`}）`}</span>{job.status !== 'running' && <button type="button" onClick={() => setJob(null)} aria-label="关闭同步结果"><Icon name="close" size={17} /></button>}</div>}
      {loading && !overview ? <div className="admin-loading"><span className="admin-spinner" />正在加载…</div> : !overview ? <Empty title="暂时无法加载后台">{error || '请刷新页面重试。'}</Empty> : <>
        {['batches', 'orders'].includes(page) && <div className="admin-context"><label className="admin-context-field"><span>当前小区</span><select value={communityId} onChange={event => { setCommunityId(event.target.value); setCreateOpen(false); setEditBatchCode(''); }} aria-label="选择小区">{!communities.length && <option value="">请先添加小区</option>}{communities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{page === 'orders' && <label className="admin-context-field"><span>团购期次</span><select value={batchCode} onChange={event => setBatchCode(event.target.value)} aria-label="选择团购期次">{!communityBatches.length && <option value="">暂无期次</option>}{communityBatches.map(batch => <option key={batch.code} value={batch.code}>{batch.periodLabel || `第${batch.periodNumber}期`}{batch.title ? ` · ${batch.title}` : ''}</option>)}</select></label>}{page === 'batches' && <button className="admin-btn" type="button" onClick={() => setAddCommunity(value => !value)} disabled={Boolean(busy)}><Icon name="plus" size={17} />添加小区</button>}</div>}
        {page === 'batches' && <>
          {(addCommunity || !communities.length) && <form className="admin-add-community" onSubmit={createCommunity}><label className="admin-field">小区名称<input name="name" placeholder="例如：幸福花园" maxLength={80} required autoFocus /></label><div className="admin-actions"><button className="admin-btn primary" disabled={Boolean(busy)}>{busy === 'community' ? '添加中…' : '添加小区'}</button>{communities.length > 0 && <button className="admin-btn" type="button" onClick={() => setAddCommunity(false)}>取消</button>}</div></form>}
          <div className="admin-section-heading"><div><h2>{community?.name || '团购期次'}<span>{communityBatches.length} 期</span></h2><p>本期商品范围独立；商品信息和金额按最新同步价格更新。</p></div><button type="button" className="admin-btn primary" disabled={!communityId || Boolean(busy)} onClick={() => { setCreateOpen(value => !value); setEditBatchCode(''); setError(''); }}><Icon name={createOpen ? 'close' : 'plus'} size={18} />{createOpen ? '收起表单' : '新建一期'}</button></div>
          {createOpen && <section className="admin-card admin-form-card"><div className="admin-card-heading"><div><p className="admin-eyebrow">新的一期</p><h2>{community?.name} · 第 {community?.nextPeriodNumber || 1} 期</h2><p>期号自动生成，默认包含全部本地在售商品。</p></div></div><form onSubmit={createBatch}><fieldset disabled={busy === 'create'}><ProductPicker products={products} /><OptionalBatchFields /><div className="admin-form-footer"><button className="admin-btn primary" disabled={Boolean(busy) || !products.some(product => product.onSale)}>{busy === 'create' ? '创建中…' : '创建本期收集页'}</button><button className="admin-btn" type="button" onClick={() => setCreateOpen(false)} disabled={Boolean(busy)}>取消</button></div></fieldset></form></section>}
          {!communityBatches.length && !createOpen ? <Empty icon="calendar" title={community ? '为这个小区开第一期' : '先添加一个小区'}>{community ? '选择本期商品、补充取货信息，再把收集页发到群里。' : '添加小区后，每个小区会自动从第 1 期开始编号。'}</Empty> : <div className="admin-batch-layout"><div className="admin-batch-list">{communityBatches.map(batch => <button className={`admin-batch-card ${batchCode === batch.code ? 'selected' : ''}`} type="button" key={batch.code} onClick={() => { setBatchCode(batch.code); setEditBatchCode(''); }}><div><span className="admin-period">{batch.periodLabel || `第${batch.periodNumber}期`}</span><BatchBadge batch={batch} /></div><h3>{batch.title || `${batch.communityName}山姆代购`}</h3><p>{batch.productIds?.length ?? products.filter(product => product.onSale).length} 件商品 <span>·</span> 截单 {dateTime(batch.cutoffAt)}</p><small>{batch.pickupLocation || '取货地点待填写'}<Icon name="arrow" size={17} /></small></button>)}</div>{selectedBatch && <div className="admin-batch-detail"><ShareCard batch={selectedBatch} origin={overview.shareOrigin} notify={notify} /><section className="admin-card"><div className="admin-card-heading"><h2>本期安排</h2><button type="button" className="admin-link" onClick={() => setEditBatchCode(editBatchCode ? '' : batchCode)} disabled={Boolean(busy)}>{editBatchCode ? '收起编辑' : '编辑本期'}</button></div>{editingBatch ? <form className="admin-edit-batch" onSubmit={saveBatch} key={editingBatch.code}><fieldset disabled={busy === 'edit'}><ProductPicker products={products} defaultIds={editingBatch.productIds} /><OptionalBatchFields batch={editingBatch} /><div className="admin-form-footer"><button className="admin-btn primary" disabled={Boolean(busy)}>{busy === 'edit' ? '保存中…' : '保存设置'}</button><button type="button" className="admin-btn" onClick={() => setEditBatchCode('')}>取消</button></div></fieldset></form> : <><dl className="admin-batch-info"><div><dt>截单时间</dt><dd>{dateTime(selectedBatch.cutoffAt)}</dd></div><div><dt>取货时间</dt><dd>{dateTime(selectedBatch.pickupAt)}</dd></div><div><dt>取货地点</dt><dd>{selectedBatch.pickupLocation || '未设置'}</dd></div><div><dt>联系方式</dt><dd>{selectedBatch.contactNote || '未设置'}</dd></div>{selectedBatch.description && <div className="wide"><dt>本期说明</dt><dd>{selectedBatch.description}</dd></div>}</dl><div className="admin-card-footer"><button className="admin-btn" type="button" onClick={() => navigate('orders')}>查看本期订单 <Icon name="arrow" size={16} /></button></div></>}</section></div>}</div>}
        </>}
        {page === 'feishu' && <FeishuConfig api={api} onSaved={refreshOverview} notify={notify} />}
        {page === 'products' && <>
          <section className="admin-sync-banner"><span className="admin-banner-icon"><Icon name="sync" size={27} /></span><div><h2>商品从飞书更新</h2><p>名称、规格、价格和上下架状态在飞书维护；图片按商品 ID 匹配。</p><small>{overview.productSync?.lastSyncedAt ? `上次同步：${dateTime(overview.productSync.lastSyncedAt)}` : '还没有完成过商品同步'}{['error', 'failed'].includes(overview.productSync?.status) && ' · 上次同步失败'}</small></div><button type="button" className="admin-btn primary" onClick={() => startSync('products')} disabled={activeJob || Boolean(busy)}><Icon name="sync" size={17} />{job?.kind === 'products' && activeJob || busy === 'sync-products' ? '同步中…' : '从飞书同步商品'}</button></section>
          <p className="admin-price-note">同步后的最新价格会用于已下订单的金额计算。</p>
          {overview.productSync?.error && <div className="admin-alert error">{typeof overview.productSync.error === 'string' ? overview.productSync.error : overview.productSync.error.message}</div>}
          {overview.productSync?.counts && <div className="admin-sync-result">上次结果：共 {overview.productSync.counts.total ?? products.length} 件商品，新增 {overview.productSync.counts.added || 0} 件，更新 {overview.productSync.counts.updated || 0} 件，下架 {overview.productSync.counts.offSale || 0} 件</div>}
          <div className="admin-section-heading"><h2>全部商品<span>{products.length} 件 · 在售 {products.filter(product => product.onSale).length} 件</span></h2><label className="admin-search"><input value={productSearch} onChange={event => setProductSearch(event.target.value)} placeholder="搜索商品名称或 ID" aria-label="搜索商品" /></label></div>
          {!products.length ? <Empty title="商品库还是空的">在飞书准备好商品后，点击“从飞书同步商品”。</Empty> : <div className="admin-card admin-product-table"><div className="admin-table-head"><span>商品</span><span>商品 ID</span><span>当前价格</span><span>状态</span></div>{products.filter(product => `${product.name} ${product.id} ${product.spec}`.toLowerCase().includes(productSearch.trim().toLowerCase())).map(product => <div className="admin-product-row" key={product.id}><div className="admin-product-name"><ProductImage product={product} /><div><strong>{product.name}</strong><small>{product.spec}{product.category ? ` · ${product.category}` : ''}</small></div></div><span className="admin-product-id">{product.id}</span><strong className="admin-product-price">{money(product.priceCents)}<small>/{product.unit || '份'}</small></strong><span className={`admin-pill ${product.onSale ? '' : 'neutral'}`}>{product.onSale ? '在售' : '已下架'}</span></div>)}</div>}
        </>}
        {page === 'orders' && <>
          {!selectedBatch ? <Empty icon="list" title="请选择一个团购期次">先在“团购期次”创建本期收集页。</Empty> : <>
            <section className="admin-order-toolbar"><div><BatchBadge batch={selectedBatch} /><h2>{selectedBatch.communityName} · {selectedBatch.periodLabel || `第${selectedBatch.periodNumber}期`}</h2><p>订单先保存在本地；同步后，可在飞书统计和采买。</p></div><div className="admin-actions"><button type="button" className="admin-btn" disabled={!stats || statsLoading || !stats.orders.length} onClick={() => exportOrders(stats, selectedBatch)}><Icon name="download" size={17} />导出 CSV</button><button type="button" className="admin-btn primary" onClick={() => startSync('orders')} disabled={activeJob || Boolean(busy) || !stats}><Icon name="sync" size={17} />{job?.kind === 'orders' && activeJob || busy === 'sync-orders' ? '同步中…' : '同步本期订单到飞书'}</button></div></section>
            <div className="admin-stat-meta"><span>上次订单同步：{overview.ordersSync?.[batchCode]?.lastSyncedAt ? dateTime(overview.ordersSync[batchCode].lastSyncedAt) : "尚未同步"}</span>{overview.ordersSync?.[batchCode]?.viewUrl && <a className="admin-link" href={overview.ordersSync[batchCode].viewUrl} target="_blank" rel="noreferrer">打开本期飞书视图<Icon name="arrow" size={15} /></a>}</div>
            {statsError && <div className="admin-alert error" role="alert">{statsError}<button type="button" className="admin-link" onClick={() => refreshStats(batchCode)}>重试</button></div>}
            {stats && <><div className="admin-metrics"><div><span>下单顾客</span><strong>{stats.customers.length}<small>位</small></strong></div><div><span>有效商品数量</span><strong>{stats.products.reduce((sum, product) => sum + product.quantity, 0)}<small>件</small></strong></div><div><span>当前订单金额</span><strong>{money(stats.totalCents)}</strong></div><div className={stats.dirtyCount > 0 ? 'has-pending' : ''}><span>待同步明细</span><strong>{stats.dirtyCount}<small>条</small></strong></div></div><div className="admin-stat-meta"><span>金额使用商品库当前价格；缺货和已取消项不计入采购汇总。</span><button className="admin-link" type="button" disabled={statsLoading} onClick={() => refreshStats(batchCode)}><Icon name="sync" size={15} />{statsLoading ? '刷新中…' : '刷新订单'}</button></div>{stats.orders.some(order => order.syncError) && <div className="admin-alert error">有 {stats.orders.filter(order => order.syncError).length} 条明细同步失败，请展开顾客订单查看原因并重试同步。</div>}
              <div className="admin-tabs" role="tablist" aria-label="订单统计方式"><button role="tab" id="purchase-tab" aria-selected={orderView === 'purchase'} aria-controls="purchase-panel" className={orderView === 'purchase' ? 'selected' : ''} onClick={() => setOrderView('purchase')}>采购汇总<span>{stats.products.length}</span></button><button role="tab" id="customers-tab" aria-selected={orderView === 'customers'} aria-controls="customers-panel" className={orderView === 'customers' ? 'selected' : ''} onClick={() => setOrderView('customers')}>顾客订单<span>{stats.customers.length}</span></button></div>
              {orderView === 'purchase' ? <section id="purchase-panel" role="tabpanel" aria-labelledby="purchase-tab">{!stats.products.length ? <Empty icon="list" title="暂时没有需要采购的商品">邻居下单后，这里会按商品汇总数量。</Empty> : <div className="admin-card admin-purchase-table"><div className="admin-table-head"><span>商品</span><span>总数量</span><span>当前单价</span><span>小计</span></div>{stats.products.map(product => <div className="admin-purchase-row" key={product.id}><div className="admin-product-name"><ProductImage product={product} /><div><strong>{product.name}</strong><small>{product.spec}</small></div></div><strong>{product.quantity}<small> {product.unit || '份'}</small></strong><span>{money(product.priceCents)}</span><strong>{money(product.amountCents)}</strong></div>)}</div>}</section> : <section id="customers-panel" role="tabpanel" aria-labelledby="customers-tab"><p className="admin-help admin-cancel-help">可修改数量和状态。删除会标记为“已取消”，下次同步时一并更新飞书。</p>{!stats.customers.length ? <Empty icon="list" title="本期还没有顾客下单">收到订单后，可在这里按手机号查看和管理。</Empty> : <div className="admin-customer-list">{stats.customers.map(customer => <details className="admin-card admin-customer" key={customer.key || customer.phone}><summary><div><strong>{customer.name}</strong><span>{customer.phone}</span><small>{customer.products.filter(product => activeQuantity(product) > 0).map(product => `${product.name} × ${activeQuantity(product)}`).join('、') || '暂无需要采购的商品'}</small></div><div className="admin-customer-total"><strong>{money(customer.totalCents)}</strong><Icon name="arrow" size={18} /></div></summary><div className="admin-customer-details">{stats.orders.filter(order => order.phone === customer.phone).map(order => <OrderEditor key={`${order.recordId}:${order.revision}`} order={order} batchCode={order.batchCode} saving={savingOrder === order.recordId} locked={Boolean(savingOrder)} onSave={saveOrder} />)}<div className="admin-customer-footer"><span>取货通知由你确认后自行发送。</span><button type="button" className="admin-btn small" onClick={() => copyPickup(customer)}><Icon name="link" size={15} />复制取货通知</button></div></div></details>)}</div>}</section>}
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
