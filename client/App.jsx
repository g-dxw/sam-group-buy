import { useEffect, useMemo, useRef, useState } from 'react';
import { createSubmissionId } from './submission-id.js';

const money = cents => `¥${((cents || 0) / 100).toFixed(2)}`;
const cleanPhone = value => {
  let phone = value.replace(/[\s()（）-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  else if (phone.startsWith('0086')) phone = phone.slice(4);
  else if (/^86\d{11}$/.test(phone)) phone = phone.slice(2);
  return phone;
};
const activeStatuses = new Set(['pending', 'processing', 'reconciling']);
const isDefiniteRejection = error => error.code?.startsWith('INVALID_') || ['PRODUCT_CHANGED', 'COLLECTION_CLOSED', 'BATCH_ENDED', 'JSON_REQUIRED', 'REQUEST_TOO_LARGE'].includes(error.code);
const labels = { pending: '待采购', purchased: '已买到', out_of_stock: '缺货', collected: '已领取', cancelled: '已取消', canceled: '已取消' };
const readStored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Browsing remains available without storage. */ } };
const removeStored = key => { try { localStorage.removeItem(key); } catch { /* Storage can be unavailable in private browsing. */ } };

function Icon({ name, size = 20, ...props }) {
  const paths = {
    bag: <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    list: <><path d="M8 4h8l2 2v15H6V6l2-2Z" /><path d="M9 11h6M9 15h6M9 7h6" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    leaf: <><path d="M20 3c-8-1-16 2-16 9a7 7 0 0 0 7 7c7 0 10-8 9-16Z" /><path d="m5 19 10-10" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
    phone: <><path d="M6 3h3l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v3c0 2-2 3-4 2A21 21 0 0 1 4 7c-1-2 0-4 2-4Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.bag}</svg>;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || '暂时无法完成操作，请稍后重试。');
    error.code = data.error?.code;
    error.details = data.error?.details;
    error.httpStatus = response.status;
    throw error;
  }
  return data;
}

function ProductImage({ product, className = '' }) {
  return <img className={className} src={product.imageUrl || '/images/placeholder.svg'} alt={product.name || '商品图片'} loading="lazy" onError={event => { const target = event.currentTarget; if (!target.src.endsWith('/images/placeholder.svg')) target.src = '/images/placeholder.svg'; }} />;
}

function Stepper({ product, quantity, onChange, disabled }) {
  return <div className={`stepper ${quantity ? 'has-quantity' : ''}`} aria-label={`${product.name}购买数量`}>
    {quantity > 0 && <><button type="button" aria-label={`减少${product.name}数量`} disabled={disabled} onClick={() => onChange(quantity - 1)}><Icon name="minus" size={16} /></button><span aria-live="polite">{quantity}</span></>}
    <button type="button" className="add-button" aria-label={`增加${product.name}数量`} disabled={disabled || quantity >= 99} onClick={() => onChange(quantity + 1)}><Icon name="plus" size={18} />{!quantity && <span>加购</span>}</button>
  </div>;
}

function EmptyState({ icon = 'bag', title, description, children }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={30} /></span><h2>{title}</h2><p>{description}</p>{children}</div>;
}

export default function App() {
  const code = decodeURIComponent(location.pathname.match(/^\/b\/([^/]+)/)?.[1] || 'demo');
  const base = `/api/batches/${encodeURIComponent(code)}`;
  const cartKey = `sam-cart:${code}`;
  const pendingKey = `sam-pending:${code}`;
  const [view, setView] = useState(() => ['cart', 'query'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'products');
  const [catalog, setCatalog] = useState(null);
  const [catalogState, setCatalogState] = useState('loading');
  const [catalogError, setCatalogError] = useState('');
  const [cart, setCart] = useState(() => readStored(cartKey, {}));
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [form, setForm] = useState(() => {
    const payload = readStored(pendingKey, null)?.payload;
    return { name: payload?.name || '', phone: payload?.phone || '', note: payload?.note || '' };
  });
  const [errors, setErrors] = useState({});
  const [submission, setSubmission] = useState(() => readStored(pendingKey, null));
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState(() => readStored(pendingKey, null)?.requiresReview ? '本次提交编号的内容需要核对，请联系代购并提供下方提交编号。请勿重复下单。' : '');
  const [queryPhone, setQueryPhone] = useState('');
  const [queryState, setQueryState] = useState('idle');
  const [queryError, setQueryError] = useState('');
  const [queryResult, setQueryResult] = useState(null);
  const [notification, setNotification] = useState('');
  const latestRef = useRef({ cart, form, submission });
  latestRef.current = { cart, form, submission };
  const formRef = useRef(null);
  const searchInputRef = useRef(null);
  const queryFormRef = useRef(null);
  const queryInputRef = useRef(null);
  const products = catalog?.products || [];
  const productMap = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const items = useMemo(() => Object.entries(cart).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0).map(([id, quantity]) => ({ product: productMap.get(id), id, quantity })), [cart, productMap]);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = items.reduce((sum, item) => sum + (item.product?.priceCents || 0) * item.quantity, 0);
  const hasUnavailable = items.some(item => !item.product || !item.product.onSale);
  const working = activeStatuses.has(submission?.status) || submission?.requiresReview || submitBusy;
  const cutoffPassed = catalog?.batch.cutoffAt && new Date(catalog.batch.cutoffAt).getTime() <= Date.now();
  const collecting = Boolean(catalog?.batch.collecting && !cutoffPassed && catalogState === 'ready');
  const categories = ['全部', ...new Set(products.map(product => product.category).filter(Boolean))];
  const shownProducts = products.filter(product => (category === '全部' || product.category === category) && `${product.name} ${product.spec} ${product.id}`.toLowerCase().includes(search.trim().toLowerCase()));

  function updateForm(event) {
    // Native fields retain IME text even when an embedded browser misses a change event.
    const { name, value } = event.currentTarget;
    setForm(current => current[name] === value ? current : { ...current, [name]: value });
  }

  function updateSearch(event) {
    setSearch(event.currentTarget.value);
  }

  function clearSearch() {
    if (searchInputRef.current) searchInputRef.current.value = '';
    setSearch('');
  }

  function updateQueryPhone(event) {
    setQueryPhone(event.currentTarget.value);
  }

  async function loadCatalog({ silent = false } = {}) {
    if (!silent) setCatalogState('loading');
    try {
      const result = await api(`${base}/catalog`);
      setCatalog(result);
      setCatalogState('ready');
      setCatalogError('');
      return result;
    } catch (error) {
      setCatalogState(error.httpStatus === 410 ? 'ended' : 'error');
      setCatalogError(error.message);
      throw error;
    }
  }

  useEffect(() => { loadCatalog().catch(() => {}); }, [code]);
  useEffect(() => { saveStored(cartKey, cart); }, [cartKey, cart]);
  useEffect(() => {
    const handler = () => setView(['cart', 'query'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'products');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(''), 3400);
    return () => clearTimeout(timer);
  }, [notification]);
  useEffect(() => {
    if (!catalog) return;
    const timer = setInterval(() => loadCatalog({ silent: true }).catch(() => {}), 60000);
    const refresh = () => { if (document.visibilityState === 'visible') loadCatalog({ silent: true }).catch(() => {}); };
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [code, Boolean(catalog)]);

  function navigate(next) {
    location.hash = next === 'products' ? '' : next;
    setView(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function acceptSubmission(result, payload) {
    const value = { ...latestRef.current.submission, ...result, payload: payload || latestRef.current.submission?.payload };
    setSubmission(value);
    if (value.status === 'completed') {
      setCart({});
      setSubmitError('');
      removeStored(pendingKey);
      if (value.payload?.phone) {
        setQueryPhone(value.payload.phone);
        if (queryInputRef.current) queryInputRef.current.value = value.payload.phone;
      }
    } else {
      saveStored(pendingKey, value);
      if (value.status === 'failed') setSubmitError(value.error?.message || '本次提交已确认失败，请核对后重新提交。');
    }
  }

  function holdSubmissionForReview(error, payload) {
    const value = { ...latestRef.current.submission, payload: payload || latestRef.current.submission?.payload, requiresReview: true, error: { code: error.code, message: error.message } };
    if (payload) { value.submissionId = payload.submissionId; value.status = 'pending'; }
    setSubmission(value);
    saveStored(pendingKey, value);
    setSubmitError('本次提交编号的内容需要核对，请联系代购并提供下方提交编号。请勿重复下单。');
  }

  useEffect(() => {
    if (!activeStatuses.has(submission?.status) || submission?.requiresReview) return;
    let disposed = false;
    let timer;
    const poll = async () => {
      try {
        let result;
        try {
          result = await api(`${base}/submissions/${encodeURIComponent(submission.submissionId)}`);
        } catch (error) {
          if (error.code !== 'SUBMISSION_NOT_FOUND' || !latestRef.current.submission?.payload) throw error;
          // A disconnected first request may never have reached the service. Replay
          // the persisted payload and original ID; the service owns deduplication.
          result = await api(`${base}/orders`, { method: 'POST', body: JSON.stringify(latestRef.current.submission.payload) });
        }
        if (disposed) return;
        acceptSubmission(result);
        if (result.status !== 'failed') setSubmitError('');
        if (result.status === 'failed' && result.error?.code === 'PRODUCT_CHANGED') await loadCatalog({ silent: true }).catch(() => {});
        if (activeStatuses.has(result.status)) timer = setTimeout(poll, 2000);
      } catch (error) {
        if (disposed) return;
        if (error.code === 'SUBMISSION_CONFLICT') {
          holdSubmissionForReview(error);
          return;
        }
        if (isDefiniteRejection(error)) {
          setSubmission(null);
          removeStored(pendingKey);
          setSubmitError(error.code === 'PRODUCT_CHANGED' ? '商品信息发生了变化，已更新购物车。请核对当前价格和规格后再次提交。' : error.message);
          await loadCatalog({ silent: true }).catch(() => {});
          return;
        }
        setSubmitError(error.httpStatus === 429 ? '请求有些频繁，稍后会继续确认同一次提交，请勿重复下单。' : '正在确认保存结果，请保留此页面。网络恢复后会继续检查。');
        timer = setTimeout(poll, error.httpStatus === 429 ? 10000 : 4000);
      }
    };
    poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [submission?.submissionId, submission?.status, submission?.requiresReview, code]);

  function updateQuantity(id, quantity) {
    if (working || !collecting) return;
    setCart(current => {
      const next = { ...current };
      if (quantity > 0) next[id] = Math.min(99, quantity);
      else delete next[id];
      return next;
    });
    if (submission?.status === 'completed') setSubmission(null);
  }

  function removeItem(id) {
    if (working) return;
    setCart(current => { const next = { ...current }; delete next[id]; return next; });
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (working || !collecting || !items.length) return;
    // Read before disabling the fields, including autofill or edits without React events.
    const fields = new FormData(event.currentTarget);
    const draft = { name: String(fields.get('name') ?? ''), phone: String(fields.get('phone') ?? ''), note: String(fields.get('note') ?? '') };
    setForm(draft);
    const phone = cleanPhone(draft.phone);
    const nextErrors = {};
    if (!draft.name.trim()) nextErrors.name = '请填写姓名或群昵称。';
    if (!/^1[3-9]\d{9}$/.test(phone)) nextErrors.phone = '请填写有效的 11 位手机号码。';
    if (hasUnavailable) nextErrors.items = '部分商品已停售或移除，请先从购物车移除。';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const field = nextErrors.name ? 'name' : nextErrors.phone ? 'phone' : null;
      formRef.current?.elements[field]?.focus();
      return;
    }
    const payloadBody = { phone, name: draft.name.trim(), note: draft.note.trim(), items: items.map(item => ({ productId: item.id, quantity: item.quantity, version: item.product.version })).sort((a, b) => a.productId.localeCompare(b.productId)) };
    // Only a confirmed terminal failure can create a new submission. A pending
    // submission is recovered by the poller using its original persisted ID.
    let submissionId;
    try { submissionId = createSubmissionId(); }
    catch { setSubmitError('当前浏览器无法下单，请使用 Safari 或 Chrome 打开本期链接。'); return; }
    const payload = { submissionId, ...payloadBody };
    const pending = { submissionId: payload.submissionId, status: 'pending', payload };
    setSubmitBusy(true);
    setSubmitError('');
    setSubmission(pending);
    saveStored(pendingKey, pending);
    try {
      const result = await api(`${base}/orders`, { method: 'POST', body: JSON.stringify(payload) });
      acceptSubmission(result, payload);
    } catch (error) {
      if (error.code === 'PRODUCT_CHANGED') {
        setSubmission(null);
        removeStored(pendingKey);
        setSubmitError('商品信息发生了变化，已更新购物车。请核对当前价格和规格后再次提交。');
        await loadCatalog({ silent: true }).catch(() => {});
      } else if (error.code === 'SUBMISSION_CONFLICT') {
        holdSubmissionForReview(error, payload);
      } else if (isDefiniteRejection(error)) {
        setSubmission(null);
        removeStored(pendingKey);
        setSubmitError(error.message);
        await loadCatalog({ silent: true }).catch(() => {});
      } else {
        // The server may have saved the order before the connection failed.
        setSubmitError(error.httpStatus === 429 ? '请求有些频繁，稍后会继续确认同一次提交，请勿重复下单。' : '正在确认提交结果，请勿重新下单。');
      }
    } finally { setSubmitBusy(false); }
  }

  async function queryOrders(event) {
    event?.preventDefault();
    const enteredPhone = queryFormRef.current ? String(new FormData(queryFormRef.current).get('query-phone') ?? '') : queryPhone;
    setQueryPhone(enteredPhone);
    const phone = cleanPhone(enteredPhone);
    if (!/^1[3-9]\d{9}$/.test(phone)) { setQueryError('请填写有效的 11 位手机号码。'); return; }
    setQueryState('loading');
    setQueryError('');
    setQueryResult(null);
    try {
      const result = await api(`${base}/query`, { method: 'POST', body: JSON.stringify({ phone }) });
      setQueryResult(result);
      setQueryState('ready');
    } catch (error) { setQueryState('error'); setQueryError(error.message); }
  }

  const batch = catalog?.batch;
  const cutoffText = batch?.cutoffAt ? new Date(batch.cutoffAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }) : null;

  return <>
    <header className="site-header"><div className="header-inner">
      <button className="brand" type="button" onClick={() => navigate('products')} aria-label="返回商品列表"><span className="brand-mark"><Icon name="bag" size={22} /></span><span>一起逛山姆<small>本期代购收集</small></span></button>
      <nav aria-label="主要导航"><button className={view === 'products' ? 'nav-active' : ''} onClick={() => navigate('products')}><Icon name="leaf" /><span>选商品</span></button><button className={view === 'cart' ? 'nav-active' : ''} onClick={() => navigate('cart')}><Icon name="bag" /><span>购物车</span>{itemCount > 0 && <b className="count-badge">{itemCount}</b>}</button><button className={view === 'query' ? 'nav-active' : ''} onClick={() => navigate('query')}><Icon name="list" /><span>查订单</span></button></nav>
    </div></header>
    <main className="page-shell">
      {batch?.communityName && <div className="batch-context"><strong>{batch.communityName} · {batch.periodLabel}</strong><span>下单自动归入本小区、本期</span>{batch.pickupLocation && <small>取货地点：{batch.pickupLocation}{batch.pickupAt && ` · ${new Date(batch.pickupAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })}`}</small>}</div>}
      {catalogState === 'loading' && !catalog ? <div className="loading-panel" role="status"><span className="spinner" />正在准备本期商品…</div> : catalogState === 'ended' ? <EmptyState icon="clock" title="本期收集已结束" description={catalogError || '本期表格已移除，请联系代购获取新一期链接。'} /> : catalogState === 'error' && !catalog ? <EmptyState icon="info" title="暂时无法打开本期商品" description={catalogError}><button className="button primary" onClick={() => loadCatalog().catch(() => {})}>重新加载</button></EmptyState> : <>
        {catalogState === 'error' && <div className="notice error" role="alert"><Icon name="info" /><span>{catalogError} 当前暂时无法下单。</span><button onClick={() => loadCatalog({ silent: true }).catch(() => {})}>重试</button></div>}
        {view === 'products' && <>
          <section className="hero"><div className="hero-copy"><div className="eyebrow"><span className={`status-dot ${collecting ? '' : 'closed'}`} />{collecting ? '本期正在收集' : '本期已截单'}{cutoffText && <span className="cutoff"><Icon name="clock" size={14} />{cutoffText} 截单</span>}</div><h1>{batch?.title || '把喜欢的，<br />一起带回家。'}</h1><p>{batch?.description || '选好商品，填上手机号，我们按清单帮你采购。'}</p><div className="hero-notes"><span><Icon name="check" size={15} />固定规格，按份选购</span><span><Icon name="check" size={15} />手机号查询本期订单</span></div></div><div className="hero-art" aria-hidden="true"><svg viewBox="0 0 280 225"><circle cx="145" cy="109" r="97" fill="#e5eddb"/><ellipse cx="142" cy="201" rx="97" ry="9" fill="#d7dfce"/><path d="m68 88 145-6-17 114H87Z" fill="#c89357"/><path d="M89 89c0-65 104-71 102-5" fill="none" stroke="#9c733f" strokeWidth="9"/><path d="m93 61 24 8-17 70-24-8Z" fill="#f8e8c7"/><path d="m100 52 19 6-1 18-24-8Z" fill="#348268"/><rect x="145" y="54" width="36" height="86" rx="18" fill="#d29642" transform="rotate(20 163 97)"/><path d="m158 76 14 5m-19 12 14 5m-19 12 14 5" stroke="#bd7c2c" strokeWidth="3"/><path d="M181 105c-9-20-1-33 11-31 0-13 17-20 23-7 17-4 25 12 14 23 15 9 2 28-12 21Z" fill="#477d47"/><path d="m187 145 17-48" stroke="#7eaa62" strokeWidth="9"/><path d="m68 88 145-6-17 114H87Z" fill="#e4b47c"/><path d="M101 148h71" stroke="#bd8b56" strokeWidth="1.5"/><path d="M139 166c-17-7-20-18-11-25 10 1 17 11 11 25Zm0 0c2-21 10-28 20-22 1 11-8 20-20 22Z" fill="#557854"/><path d="M139 166v12" stroke="#557854" strokeWidth="2"/><circle cx="50" cy="62" r="4" fill="#d7a569"/><path d="m231 42 5 4m-5 0 5-4" stroke="#729364" strokeWidth="2"/><circle cx="232" cy="156" r="5" fill="#abc69d"/></svg><span>好物一起买 · 生活慢慢选</span></div></section>
          {!collecting && <div className="notice"><Icon name="info" /><span>本期已停止收集，你仍可以查看商品和查询自己的订单。</span></div>}
          <section className="catalog-section" aria-label="商品列表"><div className="section-heading"><div><span className="overline">THIS WEEK’S PICKS</span><h2>本期好物 <span>{products.length} 件商品</span></h2></div><label className="search-field"><Icon name="search" size={19} /><input type="search" aria-label="搜索商品" placeholder="搜索商品名称、规格" ref={searchInputRef} defaultValue={search} onChange={updateSearch} onInput={updateSearch} onCompositionEnd={updateSearch} onBlur={updateSearch} />{search && <button aria-label="清空搜索" type="button" onClick={clearSearch}><Icon name="close" size={15} /></button>}</label></div><div className="category-tabs" aria-label="商品分类">{categories.map(value => <button key={value} aria-pressed={category === value} className={category === value ? 'selected' : ''} onClick={() => setCategory(value)}>{value}</button>)}</div>
            {shownProducts.length ? <div className="product-grid">{shownProducts.map(product => <article className={`product-card ${!product.onSale ? 'sold-out' : ''}`} key={product.id}><div className="product-visual"><ProductImage product={product} /><span className="product-category">{product.category}</span>{!product.onSale && <span className="unavailable-label">本期停售</span>}</div><div className="product-details"><p className="product-id">{product.id}</p><h3>{product.name}</h3><p className="product-spec">{product.spec}</p><div className="product-bottom"><div className="price"><span>{money(product.priceCents)}</span><small> / {product.unit}</small></div><Stepper product={product} quantity={cart[product.id] || 0} disabled={!collecting || !product.onSale || working} onChange={quantity => updateQuantity(product.id, quantity)} /></div></div></article>)}</div> : <EmptyState icon="search" title="没有找到这个商品" description="换个关键词，或查看其他分类。"><button className="button secondary" onClick={() => { clearSearch(); setCategory('全部'); }}>查看全部商品</button></EmptyState>}
          </section>{products.some(product => product.id.startsWith('DEMO-')) && <p className="illustration-note">演示商品及价格仅用于体验 · 图片为商品示意图，非实拍</p>}
        </>}
        {view === 'cart' && <section className="cart-page"><div className="page-title"><span className="overline">YOUR SHOPPING BAG</span><h1>把好物装进购物车</h1><p>核对商品和联系方式，准备好就提交。</p></div>
          {submission?.status === 'completed' ? <div className="success-panel"><span className="success-icon"><Icon name="check" size={36} /></span><h2>下单成功，清单已收好</h2><p>本次商品已追加到你的本期订单。<br />后续修改或取消，请联系代购。</p><div className="success-actions"><button className="button primary" onClick={() => { navigate('query'); }}>查询我的订单<Icon name="arrow" size={16} /></button><button className="button secondary" onClick={() => { setSubmission(null); navigate('products'); }}>继续选购</button></div><small>提交编号：{submission.submissionId}</small></div> : items.length || working ? <div className="checkout-layout"><div className="cart-list"><div className="card-heading"><h2>已选商品 <span>{items.length} 种</span></h2><button className="text-button" disabled={working} onClick={() => navigate('products')}>继续选购<Icon name="arrow" size={14} /></button></div>{items.map(({ product, id, quantity }) => <article className="cart-item" key={id}><ProductImage product={product || { id, name: '商品已移除' }} /><div className="cart-item-info"><h3>{product?.name || `商品 ${id}`}</h3><p>{product?.spec || '商品信息已移除，请联系代购'}{product && ` · ${product.unit}`}</p><div className="cart-item-price">{product ? money(product.priceCents) : '价格待确认'}{(!product || !product.onSale) && <span className="status-chip">已停售，请移除</span>}</div></div><div className="cart-item-controls"><button className="remove-button" type="button" aria-label={`移除${product?.name || id}`} disabled={working} onClick={() => removeItem(id)}><Icon name="close" size={16} /></button>{product && <Stepper product={product} quantity={quantity} disabled={!collecting || working || !product.onSale} onChange={next => updateQuantity(id, next)} />}<strong>{product ? money(product.priceCents * quantity) : '待确认'}</strong></div></article>)}{!items.length && working && <p className="subtle">正在恢复本次提交的确认结果…</p>}<div className="cart-list-footer"><Icon name="info" size={17} /><span>同一手机号再次提交，商品数量会追加到本期订单。</span></div></div><form className="checkout-form" onSubmit={submitOrder} ref={formRef} noValidate><h2>填写下单信息</h2><label htmlFor="name">姓名 / 群昵称 <span>*</span></label><input id="name" name="name" autoComplete="name" maxLength={40} placeholder="方便分货时找到你" disabled={working} defaultValue={form.name} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'name-error' : undefined} onChange={updateForm} onInput={updateForm} onCompositionEnd={updateForm} onBlur={updateForm} />{errors.name && <p className="field-error" id="name-error">{errors.name}</p>}<label htmlFor="phone">手机号码 <span>*</span></label><input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="手机号用于合并和查询订单" maxLength={20} disabled={working} defaultValue={form.phone} aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'phone-error' : 'phone-help'} onChange={updateForm} onInput={updateForm} onCompositionEnd={updateForm} onBlur={updateForm} />{errors.phone ? <p className="field-error" id="phone-error">{errors.phone}</p> : <p className="field-help" id="phone-help">请核对手机号，填错会归入其他人的订单。</p>}<label htmlFor="note">备注 <small>选填</small></label><textarea id="note" name="note" rows={3} maxLength={500} placeholder="有需要说明的事，可以写在这里" disabled={working} defaultValue={form.note} onChange={updateForm} onInput={updateForm} onCompositionEnd={updateForm} onBlur={updateForm} /><div className="checkout-total"><span>本次商品金额<small>{itemCount} 件商品</small></span><strong>{money(cartTotal)}</strong></div><p className="field-help">按当前商品价格计算，最终金额由代购确认。</p>{errors.items && <p className="field-error">{errors.items}</p>}{working && <div className="submission-progress" role="status">{submission?.requiresReview ? <Icon name="info" /> : <span className="spinner" />}<div><strong>{submission?.requiresReview ? '请联系代购核对本次提交' : submission?.status === 'reconciling' ? '正在核对保存结果' : '正在保存你的清单'}</strong><small>{submission?.requiresReview ? '提交编号已保留，请勿重复下单。' : '请勿重复提交，刷新页面也会继续确认。'}</small></div></div>}{submitError && <p className={`notice ${working ? '' : 'error'}`} role="alert">{submitError}</p>}<button className="button primary submit-button" type="submit" disabled={!collecting || working || hasUnavailable}>{submission?.requiresReview ? '请联系代购核对' : working ? '正在确认订单…' : !collecting ? '本期已停止收集' : submission?.status === 'failed' ? '重新提交订单' : '确认并追加下单'}{!working && collecting && <Icon name="arrow" size={17} />}</button><p className="checkout-note">本次提交会追加到本期订单。修改或取消请联系代购。</p>{submission?.submissionId && <p className="submission-id">提交编号：{submission.submissionId}</p>}</form></div> : <EmptyState title="购物车还是空的" description="去选几件喜欢的商品，我们帮你一起带回来。"><button className="button primary" onClick={() => navigate('products')}>去选商品<Icon name="arrow" size={16} /></button></EmptyState>}
        </section>}
        {view === 'query' && <section className="query-page"><div className="page-title"><span className="overline">YOUR ORDER</span><h1>看看你的本期订单</h1><p>输入下单时的手机号，补单商品会合并显示。</p></div><form className="query-form" onSubmit={queryOrders} ref={queryFormRef} noValidate><label htmlFor="query-phone">下单手机号</label><div className="query-input-row"><div className="phone-input"><Icon name="phone" size={19} /><input id="query-phone" name="query-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={20} placeholder="请输入 11 位手机号码" ref={queryInputRef} defaultValue={queryPhone} onChange={updateQueryPhone} onInput={updateQueryPhone} onCompositionEnd={updateQueryPhone} onBlur={updateQueryPhone} aria-describedby={queryError ? 'query-error' : 'query-help'} aria-invalid={Boolean(queryError)} /></div><button className="button primary" disabled={queryState === 'loading'}>{queryState === 'loading' ? <><span className="spinner light" />查询中</> : <><Icon name="search" size={17} />查询订单</>}</button></div>{queryError && <p className="field-error" role="alert" id="query-error">{queryError}</p>}<p className="field-help" id="query-help">仅查询本期订单。知道手机号的人也可以查询，请妥善保管收集链接。</p></form>
          {queryState === 'idle' && <div className="query-guide"><span className="empty-icon"><Icon name="list" size={32} /></span><h2>清单、数量、采购进度</h2><p>本期的每一次补单，都在同一份清单里。</p><div><span><Icon name="check" size={15} />商品数量合并</span><span><Icon name="check" size={15} />采购状态随时查看</span></div></div>}
          {queryState === 'loading' && <div className="loading-panel" role="status"><span className="spinner" />正在查找本期订单…</div>}
          {queryState === 'ready' && !queryResult?.hasOrders && (queryResult?.pendingCount > 0 ? <EmptyState icon="clock" title="你的订单仍在确认中" description={`有 ${queryResult.pendingCount} 次提交正在确认保存，完成后会显示商品清单。请勿重复下单。`}><button className="button secondary" onClick={() => queryOrders()}>刷新确认结果</button></EmptyState> : <EmptyState icon="search" title="本期还没有找到你的订单" description="检查手机号是否正确，或先选购商品并提交。"><button className="button secondary" onClick={() => navigate('products')}>去选商品</button></EmptyState>)}
          {queryState === 'ready' && queryResult?.hasOrders && <div className="order-result"><div className="order-result-heading"><div><span className="order-label">本期订单</span><h2>{queryResult.phone}</h2></div><button className="text-button" onClick={() => queryOrders()}><Icon name="clock" size={15} />刷新状态</button></div>{queryResult.pendingCount > 0 && <div className="notice"><Icon name="clock" /><span>有 {queryResult.pendingCount} 次提交正在确认，确认完成后会合并到下面的清单。</span></div>}<div className="query-products">{queryResult.products.map(product => <article className="query-item" key={product.id}><ProductImage product={product} /><div className="query-item-info"><h3>{product.name}</h3><p>{product.spec}{product.unit ? ` · ${product.unit}` : ''}</p><div className="status-chips">{product.statuses.map(({ status, quantity }) => <span className={`status-chip ${['缺货', '已取消', 'out_of_stock', 'cancelled', 'canceled'].includes(status) ? 'muted-chip' : ''}`} key={status}>{labels[status] || status} {quantity}{product.unit || '份'}</span>)}</div></div><div className="query-item-amount"><strong>{product.missing ? '待确认' : money(product.amountCents)}</strong><small>累计 {product.quantity}{product.unit || '份'}</small>{!product.missing && <small>{money(product.priceCents)} / {product.unit || '份'}</small>}</div></article>)}</div><div className="order-total"><span>本期商品金额<small>缺货和已取消商品不计入金额</small></span><strong>{queryResult.totalCents === null ? '待代购确认' : money(queryResult.totalCents)}</strong></div><div className="order-contact"><Icon name="info" size={18} /><p>{queryResult.contactNote || batch?.contactNote || '需要修改数量、取消商品或确认缺货情况，请联系代购。'}<small>金额按当前商品价格计算，最终金额由代购确认。</small></p></div></div>}
        </section>}
        <footer className="site-footer"><span><Icon name="leaf" size={16} />一起选好物，日常多一点美好。</span><span>{batch?.contactNote || '修改订单或了解领取安排，请联系代购。'}</span></footer>
      </>}
    </main>
    {view === 'products' && itemCount > 0 && catalogState !== 'ended' && <div className="sticky-cart"><div><span className="sticky-cart-icon"><Icon name="bag" size={21} /><b>{itemCount}</b></span><div><strong>{money(cartTotal)}</strong><small>{items.length} 种商品 · {itemCount} 件</small></div></div><button className="button primary" onClick={() => navigate('cart')}>去购物车<Icon name="arrow" size={17} /></button></div>}
    {notification && <div className="toast" role="status">{notification}</div>}
  </>;
}
