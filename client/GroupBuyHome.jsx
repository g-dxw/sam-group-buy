import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './group-buy-home.css';
import { ServiceFooter } from './ServiceNotice.jsx';

function HomeIcon({ name, size = 20 }) {
  const paths = {
    bag: <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
    leaf: <><path d="M20 3c-8-1-16 2-16 9a7 7 0 0 0 7 7c7 0 10-8 9-16Z" /><path d="m5 19 10-10" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" /></>,
    location: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5" /></>,
    arrow: <path d="M4 12h16m-5-5 5 5-5 5" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.bag}</svg>;
}

const timestamp = value => value ? Date.parse(value) : NaN;
const timeText = value => Number.isFinite(timestamp(value)) ? new Date(value).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
}) : null;
const periodText = batch => batch.periodLabel || `第${batch.periodNumber}期`;

function BatchTime({ value, fallback }) {
  const text = timeText(value);
  return text ? <time dateTime={value}>{text}</time> : fallback;
}

function GroupBuyCard({ batch }) {
  const period = periodText(batch);
  const images = (Array.isArray(batch.coverImages) ? batch.coverImages : []).filter(url => typeof url === 'string' && url).slice(0, 3);
  return <article className="group-buy-card">
    <div className="group-buy-card-body">
      <div className="group-buy-card-heading"><span className="group-buy-community"><HomeIcon name="people" size={17} />{batch.communityName}</span><span className="group-buy-active"><i />收集中</span></div>
      <p className="group-buy-period">{period}</p>
      <h2>{batch.title || '本期山姆好物'}</h2>
      {batch.description && <p className="group-buy-description">{batch.description}</p>}
    </div>
    <div className="group-buy-cover" style={{ '--cover-count': Math.max(1, images.length) }} aria-hidden="true">
      {images.length ? images.map((url, index) => <div key={`${url}:${index}`}><img src={url} alt="" loading="lazy" onError={event => { const image = event.currentTarget; if (!image.src.endsWith('/images/placeholder.svg')) image.src = '/images/placeholder.svg'; }} /></div>) : <div className="group-buy-cover-empty"><HomeIcon name="bag" size={33} /><span>本期好物，等你来选</span></div>}
    </div>
    <div className="group-buy-card-bottom">
      <dl className="group-buy-schedule">
        <div><dt><HomeIcon name="clock" size={16} />截单时间</dt><dd><BatchTime value={batch.cutoffAt} fallback="以团长通知为准" /></dd></div>
        <div><dt><HomeIcon name="calendar" size={16} />取货时间</dt><dd><BatchTime value={batch.pickupAt} fallback="待团长通知" /></dd></div>
        <div className="group-buy-pickup"><dt><HomeIcon name="location" size={16} />取货地点</dt><dd>{batch.pickupLocation || '待团长通知'}</dd></div>
      </dl>
      <div className="group-buy-card-actions"><span><HomeIcon name="bag" size={17} />{batch.productCount} 件商品</span><a className="button primary group-buy-enter" href={`/b/${encodeURIComponent(batch.code)}`} aria-label={`进入${batch.communityName} · ${period}团购`}>进入团购<HomeIcon name="arrow" size={18} /></a></div>
    </div>
  </article>;
}

export default function GroupBuyHome() {
  const [batches, setBatches] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const live = useRef(true);
  const request = useRef(null);
  const generation = useRef(0);

  const loadBatches = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    setState('loading'); setError('');
    try {
      const response = await fetch('/api/batches', { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error?.message || '暂时无法读取团购列表，请稍后重试。');
      if (!Array.isArray(result?.batches) || result.batches.some(batch => !batch || typeof batch.code !== 'string' || !batch.code.trim()
        || typeof batch.communityName !== 'string' || !batch.communityName.trim() || !Number.isSafeInteger(batch.productCount) || batch.productCount < 0)
        || new Set(result.batches.map(batch => batch.code)).size !== result.batches.length) {
        throw new Error('团购列表暂时无法读取，请稍后重试。');
      }
      if (!live.current || current !== generation.current) return;
      setBatches(result.batches); setNow(Date.now()); setState('ready');
    } catch (error) {
      if (!live.current || current !== generation.current || controller.signal.aborted && !timedOut) return;
      setState('error'); setError(timedOut ? '读取团购列表超时，请重新加载。' : error.message || '暂时无法读取团购列表，请稍后重试。');
    } finally { clearTimeout(timer); }
  }, []);

  useEffect(() => {
    live.current = true;
    document.title = '邻里代购 · 进行中的团购';
    loadBatches();
    const onVisible = () => { if (document.visibilityState === 'visible') loadBatches(); };
    const onPageShow = event => { if (event.persisted) loadBatches(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      live.current = false; generation.current += 1; request.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [loadBatches]);

  useEffect(() => {
    const next = Math.min(...batches.map(batch => timestamp(batch.cutoffAt)).filter(time => Number.isFinite(time) && time > now));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, next - Date.now()) + 50, 60000));
    return () => clearTimeout(timer);
  }, [batches, now]);

  const ongoing = useMemo(() => batches.filter(batch => !Number.isFinite(timestamp(batch.cutoffAt)) || timestamp(batch.cutoffAt) > now), [batches, now]);

  return <div className="group-buy-home">
    <header className="site-header"><div className="header-inner"><div className="brand"><span className="brand-mark"><HomeIcon name="bag" size={22} /></span><span>一起逛山姆<small>选择团购 · 一起选购</small></span></div><span className="group-buy-header-note"><HomeIcon name="leaf" size={17} />和邻居一起选好物</span></div></header>
    <main className="group-buy-home-shell">
      <section className="group-buy-home-intro"><span className="group-buy-home-eyebrow"><HomeIcon name="leaf" size={17} />好物一起买</span><h1>进行中的团购</h1><p>选择你所在的群和期次，进入后查看商品并下单。</p>{state === 'ready' && ongoing.length > 0 && <span className="group-buy-home-count" aria-live="polite">{ongoing.length} 期正在收集</span>}</section>
      {state === 'loading' && <div className="group-buy-home-state" role="status"><span className="spinner" />正在查看进行中的团购…</div>}
      {state === 'error' && <section className="group-buy-home-empty" aria-label="团购列表加载失败"><span className="group-buy-state-icon"><HomeIcon name="info" size={30} /></span><h2>暂时无法加载团购</h2><p role="alert">{error}</p><button type="button" className="button primary" onClick={loadBatches}><HomeIcon name="refresh" size={17} />重新加载</button></section>}
      {state === 'ready' && (ongoing.length ? <section className="group-buy-home-grid" aria-label="进行中的团购列表">{ongoing.map(batch => <GroupBuyCard key={batch.code} batch={batch} />)}</section> : <section className="group-buy-home-empty"><span className="group-buy-state-icon"><HomeIcon name="bag" size={31} /></span><h2>暂时没有进行中的团购</h2><p>新一期开放后会出现在这里，也可以向团长了解下一期安排。</p><button type="button" className="button secondary" onClick={loadBatches}><HomeIcon name="refresh" size={17} />重新查看</button></section>)}
      <ServiceFooter><span><HomeIcon name="leaf" size={16} />一起选好物，日常多一点美好。</span></ServiceFooter>
    </main>
  </div>;
}
