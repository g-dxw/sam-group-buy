import { useCallback, useEffect, useRef, useState } from 'react';

const emptyConfig = { feishuUrl: '', baseToken: '', productTableId: '', orderTableId: '' };
const normalize = value => Object.fromEntries(Object.keys(emptyConfig).map(key => [key, String(value?.[key] || '').trim()]));
const fingerprint = value => JSON.stringify(normalize(value));
const errorText = error => typeof error === 'string' ? error : error?.message || '操作未完成，请稍后重试。';
const checkedTime = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
const fieldName = value => typeof value === 'string' ? value : value?.name || value?.fieldName || value?.label || '未知字段';
const checkPassed = value => value === true || value === 'success' || value?.ok === true || value?.status === 'success';
const checksPresent = value => value !== null && value !== undefined;

function ConfigIcon({ name, size = 20 }) {
  const paths = {
    link: <><path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.92)" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h16m-5-5 5 5-5 5" />,
    table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M10 10v10" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    save: <><path d="M4 3h13l3 3v15H4V3Z" /><path d="M8 3v6h8V3M8 21v-8h8v8" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.link}</svg>;
}

function TableFeedback({ table, type }) {
  if (!table) return null;
  const missing = type === 'products' ? table.missingProductFields : table.missingOrderFields;
  const compatible = type === 'products' ? table.productCompatible : table.orderCompatible;
  return <div className={`feishu-table-feedback ${compatible ? '' : 'needs-fields'}`}>
    <span>{compatible ? '所需字段齐全' : '所需字段尚未齐全'}</span>
    {missing?.length > 0 && <p>缺少或不匹配的字段：{missing.map(fieldName).join('、')}</p>}
  </div>;
}

function CheckResult({ result, stale }) {
  if (!result) return null;
  if (stale) return <div className="feishu-check-stale" role="status">配置已修改，请重新检查连接。</div>;
  const success = result.status === 'success';
  const rows = [['base', '多维表格访问'], ['products', '商品表字段'], ['orders', '订单表字段']];
  return <section className={`feishu-check-result ${success ? '' : 'has-error'}`} aria-label="连接检查结果">
    <div className="feishu-result-heading"><ConfigIcon name={success ? 'check' : 'shield'} /><div><strong>{success ? '连接和字段检查通过' : '连接检查未通过'}</strong>{result.checkedAt && <small>{checkedTime(result.checkedAt)}</small>}</div></div>
    {result.message && <p>{result.message}</p>}
    <div className="feishu-check-rows">{rows.filter(([key]) => checksPresent(result.checks?.[key])).map(([key, label]) => {
      const check = result.checks[key];
      const passed = checkPassed(check);
      const missing = check?.missingFields || check?.missing || [];
      return <div className="feishu-check-row" key={key}><span>{label}</span><span className={`admin-pill ${passed ? '' : 'neutral'}`}>{passed ? '通过' : '待核对'}</span>{check?.message && <p>{check.message}</p>}{Array.isArray(missing) && missing.length > 0 && <p>缺少或不匹配的字段：{missing.map(fieldName).join('、')}</p>}</div>;
    })}</div>
    <p className="feishu-check-help">此检查核对表格访问和字段；订单写入权限以实际同步结果为准。</p>
  </section>;
}

export default function FeishuConfig({ api, onSaved, notify }) {
  const [draft, setDraft] = useState(emptyConfig);
  const [saved, setSaved] = useState(emptyConfig);
  const [revision, setRevision] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [tables, setTables] = useState([]);
  const [discoveredBase, setDiscoveredBase] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [check, setCheck] = useState(null);
  const [savedResult, setSavedResult] = useState(null);
  const [starting, setStarting] = useState('');
  const [job, setJob] = useState(null);
  const [pollVersion, setPollVersion] = useState(0);
  const formRef = useRef(null);
  const live = useRef(true);
  const draftRef = useRef(draft);
  const requestControllers = useRef(new Set());
  const loadGeneration = useRef(0);
  draftRef.current = draft;
  const dirty = fingerprint(draft) !== fingerprint(saved);
  const active = Boolean(starting || job?.status === 'running' || job?.status === 'paused');
  const hasDestination = Boolean(saved.baseToken || saved.feishuUrl);
  const complete = Boolean((draft.feishuUrl || draft.baseToken) && draft.productTableId && draft.orderTableId);
  const currentCheck = check?.signature === fingerprint(draft);

  const boundedRequest = useCallback(async (path, options = {}, limit = 20000) => {
    const controller = new AbortController();
    requestControllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), limit);
    try { return await api(path, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); requestControllers.current.delete(controller); }
  }, [api]);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; for (const controller of requestControllers.current) controller.abort(); };
  }, []);

  const loadConfig = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setError(''); setLoadFailed(false);
    try {
      const result = await boundedRequest('/feishu/config');
      if (!live.current || generation !== loadGeneration.current) return;
      const config = normalize(result.config);
      setSaved(config); setDraft(config); setRevision(result.revision); setTables([]); setDiscoveredBase(null); setSavedResult(null);
      setCheck(result.lastCheck?.config ? { signature: fingerprint(result.lastCheck.config), result: result.lastCheck } : null);
    } catch (error) {
      if (!live.current || generation !== loadGeneration.current) return;
      setError(error.name === 'AbortError' ? '读取配置超时，请重试。' : errorText(error)); setLoadFailed(true);
    } finally { if (live.current && generation === loadGeneration.current) setLoading(false); }
  }, [boundedRequest]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    if (!job?.id || job.status !== 'running') return;
    let disposed = false;
    let timer;
    let errors = 0;
    const deadline = Date.now() + 120000;
    const target = job;
    const poll = async () => {
      if (disposed || !live.current) return;
      if (Date.now() >= deadline) {
        setJob(previous => ({ ...previous, status: 'paused', message: '确认结果超过两分钟。可以继续确认同一次操作。' }));
        return;
      }
      try {
        const response = await boundedRequest(`/jobs/${encodeURIComponent(target.id)}`, {}, 15000);
        if (disposed || !live.current) return;
        errors = 0;
        const next = response.job || response;
        if (next.status === 'running') {
          setJob(previous => ({ ...previous, message: '' }));
          timer = setTimeout(poll, 2000);
          return;
        }
        const result = next.result;
        if (next.status === 'failed' || !result || result.status === 'error') {
          const message = errorText(next.error || result?.error || result?.message);
          setJob(previous => ({ ...previous, status: 'failed', message }));
          if (target.kind === 'check') setCheck({ signature: target.signature, result: result || { status: 'error', message } });
          setError(message);
          return;
        }
        setJob(previous => ({ ...previous, status: 'completed', message: '' }));
        if (target.kind === 'inspect') {
          const base = result.base || {};
          const discovered = Array.isArray(result.tables) ? result.tables : [];
          setTables(discovered); setDiscoveredBase(base);
          setDraft(previous => ({ ...previous, feishuUrl: base.feishuUrl || previous.feishuUrl, baseToken: base.baseToken || previous.baseToken,
            productTableId: discovered.some(table => table.id === previous.productTableId) ? previous.productTableId : '',
            orderTableId: discovered.some(table => table.id === previous.orderTableId) ? previous.orderTableId : '' }));
          setCheck(null); setSavedResult(null);
          notify(`已读取 ${discovered.length} 张数据表，请选择商品表和订单表`);
        } else if (target.kind === 'check') {
          setCheck({ signature: target.signature, result });
          notify(result.status === 'success' ? '连接和字段检查通过' : result.message || '请核对检查结果', result.status !== 'success');
        } else if (target.kind === 'save') {
          const config = normalize(result.config || target.config);
          setSaved(config); setRevision(result.revision); setSavedResult(result);
          if (fingerprint(draftRef.current) === target.signature) setDraft(config);
          notify('飞书配置已保存，尚未执行商品或订单同步');
          try { await onSaved(); }
          catch { if (!disposed && live.current) notify('配置已保存，后台概览暂未刷新，请刷新页面。', true); }
        }
      } catch (error) {
        if (disposed || !live.current || error.status === 401) return;
        errors += 1;
        const message = error.name === 'AbortError' ? '暂时未能确认操作结果。' : errorText(error);
        if (errors >= 3 || Date.now() >= deadline) setJob(previous => ({ ...previous, status: 'paused', message: `${message} 请继续确认同一次操作。` }));
        else { setJob(previous => ({ ...previous, message: `${message} 正在重试确认…` })); timer = setTimeout(poll, 2000); }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id, job?.status, pollVersion, boundedRequest, notify, onSaved]);

  function updateField(name, value) {
    setError(''); setSavedResult(null);
    setDraft(previous => {
      if (previous[name] === value) return previous;
      if (name === 'feishuUrl') return { ...previous, feishuUrl: value, baseToken: '', productTableId: '', orderTableId: '' };
      if (name === 'baseToken') return { ...previous, baseToken: value, feishuUrl: '', productTableId: '', orderTableId: '' };
      return { ...previous, [name]: value };
    });
    if (name === 'feishuUrl' || name === 'baseToken') { setTables([]); setDiscoveredBase(null); }
  }

  function readForm() {
    const form = new FormData(formRef.current);
    const config = normalize({ feishuUrl: form.get('feishuUrl'), baseToken: form.get('baseToken'), productTableId: form.get('productTableId'), orderTableId: form.get('orderTableId') });
    setDraft(config);
    return config;
  }

  async function start(kind) {
    if (active || loading || loadFailed) return;
    const config = readForm();
    setError(''); setSavedResult(null);
    if (!config.feishuUrl && !config.baseToken) { setError('请粘贴飞书多维表格链接，或在高级配置中填写 Base ID。'); return; }
    if (kind !== 'inspect' && (!config.productTableId || !config.orderTableId)) { setError('请先选择商品表和订单表。'); return; }
    setStarting(kind);
    try {
      const response = await boundedRequest(kind === 'inspect' ? '/feishu/inspect' : kind === 'check' ? '/feishu/check' : '/feishu/config', {
        method: kind === 'save' ? 'PUT' : 'POST',
        body: JSON.stringify(kind === 'inspect' ? config.feishuUrl ? { feishuUrl: config.feishuUrl } : { baseToken: config.baseToken } : kind === 'save' ? { ...config, revision } : config),
      });
      if (!live.current) return;
      const next = response.job || response;
      if (!next.id) throw new Error('服务未返回操作编号，请重新读取已保存配置后重试。');
      setJob({ ...next, status: 'running', kind, signature: fingerprint(config), config });
    } catch (error) {
      if (!live.current) return;
      setError(error.name === 'AbortError' ? kind === 'save' ? '保存请求超时，结果暂未确认。请重新读取已保存配置，再决定是否重试。' : '请求超时，请重试。' : errorText(error));
    } finally { if (live.current) setStarting(''); }
  }

  function tableOptions(type, selectedId) {
    const options = [...tables];
    if (selectedId && !options.some(table => table.id === selectedId)) options.unshift({ id: selectedId, name: selectedId === saved[`${type}TableId`] ? `已保存的数据表 · ${selectedId}` : `指定数据表 · ${selectedId}` });
    return options;
  }

  if (loading) return <div className="admin-loading"><span className="admin-spinner" />正在读取飞书配置…</div>;
  if (loadFailed) return <section className="admin-card feishu-load-error"><h2>暂时无法读取飞书配置</h2><p role="alert">{error}</p><button className="admin-btn" type="button" onClick={loadConfig}><ConfigIcon name="refresh" size={17} />重新读取配置</button></section>;

  return <div className="feishu-config-page">
    <section className="feishu-flow-banner"><div><span>商品资料</span><strong>飞书商品表</strong></div><span className="feishu-flow-action">手动同步<ConfigIcon name="arrow" size={18} /></span><div><span>顾客下单</span><strong>本地商品与订单</strong></div><span className="feishu-flow-action">手动同步<ConfigIcon name="arrow" size={18} /></span><div><span>统计采买</span><strong>飞书订单表</strong></div></section>
    <div className="feishu-config-layout"><section className="admin-card feishu-config-card">
      <div className="admin-card-heading"><div><h2>连接飞书多维表格</h2><p>选择商品来源和订单同步目标。</p></div><span className={`admin-pill ${dirty || !hasDestination ? 'neutral' : ''}`}>{active && job?.kind === 'save' || starting === 'save' ? '正在保存' : dirty ? '有未保存的修改' : hasDestination ? '配置已保存' : '尚未配置'}</span></div>
      <form ref={formRef} onSubmit={event => { event.preventDefault(); start('save'); }}>
        <fieldset disabled={active}>
          <label className="admin-field">多维表格链接<input type="url" name="feishuUrl" value={draft.feishuUrl} onChange={event => updateField('feishuUrl', event.currentTarget.value)} onInput={event => updateField('feishuUrl', event.currentTarget.value)} placeholder="粘贴飞书多维表格的完整链接" autoComplete="off" maxLength={2000} /></label>
          <p className="admin-help">修改链接后，重新读取数据表，再选择商品表与订单表。</p>
          <button className="admin-btn feishu-inspect-btn" type="button" onClick={() => start('inspect')} disabled={active || !(draft.feishuUrl || draft.baseToken)}><ConfigIcon name="table" size={17} />{starting === 'inspect' || job?.kind === 'inspect' && job.status === 'running' ? '正在读取数据表…' : '读取数据表'}</button>
          {discoveredBase && <div className="feishu-discovered-base"><ConfigIcon name="table" size={17} /><span>{discoveredBase.name || '已读取多维表格'}<small>{tables.length} 张数据表</small></span></div>}
          <div className="admin-form-grid feishu-table-fields">
            <div><label className="admin-field">商品表<select name={advanced ? undefined : 'productTableId'} value={draft.productTableId} onChange={event => updateField('productTableId', event.currentTarget.value)} aria-describedby="product-table-help"><option value="">请选择商品表</option>{tableOptions('product', draft.productTableId).map(table => <option key={table.id} value={table.id}>{table.name}{table.productCompatible === false ? ' · 缺少所需字段' : ''}</option>)}</select></label><p className="admin-help" id="product-table-help">读取商品名称、价格、规格等资料。</p><TableFeedback table={tables.find(table => table.id === draft.productTableId)} type="products" /></div>
            <div><label className="admin-field">订单表<select name={advanced ? undefined : 'orderTableId'} value={draft.orderTableId} onChange={event => updateField('orderTableId', event.currentTarget.value)} aria-describedby="order-table-help"><option value="">请选择订单表</option>{tableOptions('order', draft.orderTableId).map(table => <option key={table.id} value={table.id}>{table.name}{table.orderCompatible === false ? ' · 缺少所需字段' : ''}</option>)}</select></label><p className="admin-help" id="order-table-help">接收后台手动同步的本地订单。</p><TableFeedback table={tables.find(table => table.id === draft.orderTableId)} type="orders" /></div>
          </div>
          <details className="feishu-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>高级配置：直接填写数据表 ID</summary>{advanced ? <div><label className="admin-field">Base ID<input name="baseToken" value={draft.baseToken} onChange={event => updateField('baseToken', event.currentTarget.value)} onInput={event => updateField('baseToken', event.currentTarget.value)} placeholder="多维表格 Base ID" autoComplete="off" maxLength={200} /></label><div className="admin-form-grid"><label className="admin-field">商品表 ID<input name="productTableId" value={draft.productTableId} onChange={event => updateField('productTableId', event.currentTarget.value)} onInput={event => updateField('productTableId', event.currentTarget.value)} placeholder="tbl…" autoComplete="off" maxLength={200} /></label><label className="admin-field">订单表 ID<input name="orderTableId" value={draft.orderTableId} onChange={event => updateField('orderTableId', event.currentTarget.value)} onInput={event => updateField('orderTableId', event.currentTarget.value)} placeholder="tbl…" autoComplete="off" maxLength={200} /></label></div></div> : <input type="hidden" name="baseToken" value={draft.baseToken} />}</details>
        </fieldset>
        {error && <div className="admin-alert error feishu-config-error" role="alert">{error}</div>}
        {job?.status === 'running' && <div className="admin-alert feishu-job-notice" role="status"><span className="admin-spinner" /><span>{job.kind === 'inspect' ? '正在读取多维表格和数据表' : job.kind === 'check' ? '正在检查连接与字段' : '正在保存配置'}…{job.message && ` ${job.message}`}</span></div>}
        {job?.status === 'paused' && <div className="admin-alert warning feishu-job-notice" role="status"><span>{job.message}</span><button type="button" className="admin-link" onClick={() => { setJob(previous => ({ ...previous, status: 'running', message: '' })); setPollVersion(value => value + 1); }}>继续确认结果</button></div>}
        <CheckResult result={check?.result} stale={!currentCheck} />
        {savedResult && <div className="feishu-saved-result" role="status"><ConfigIcon name="check" size={19} /><div><strong>飞书配置已保存</strong><p>保存配置不会自动同步商品或订单。</p>{savedResult.changedDestination && <p>订单目标已切换，{Number.isInteger(savedResult.markedPending) ? `${savedResult.markedPending} 条` : '已有'}订单明细已标记待同步；原订单表保持不变。</p>}</div></div>}
        <div className="admin-form-footer feishu-config-actions"><button type="button" className="admin-btn" onClick={() => start('check')} disabled={active || !complete}><ConfigIcon name="shield" size={17} />{starting === 'check' || job?.kind === 'check' && job.status === 'running' ? '正在检查…' : '检查连接'}</button><button type="submit" className="admin-btn primary" disabled={active || !complete || !dirty}><ConfigIcon name="save" size={17} />{starting === 'save' || job?.kind === 'save' && job.status === 'running' ? '正在保存…' : '保存配置'}</button><button type="button" className="admin-link feishu-reload" onClick={loadConfig} disabled={active}>重新读取已保存配置</button></div>
      </form>
    </section><aside className="feishu-config-notes"><section className="admin-card"><div className="feishu-note-icon"><ConfigIcon name="shield" size={23} /></div><h3>沿用服务器的飞书授权</h3><p>使用当前服务器已授权的 lark-cli 用户身份访问表格。</p><p>无需在这里填写 App Secret 或访问令牌。当前身份需有商品表的读取权限，以及订单表的编辑权限。</p></section><section className="admin-card"><h3>配置后，按需手动同步</h3><ol><li>在“商品库”点击“从飞书同步商品”。</li><li>邻居下单后，订单即时保存在本地。</li><li>在“订单统计”点击“同步本期订单到飞书”。</li></ol><p>切换订单同步目标，会把已有明细标记待同步；原表中的数据不会修改。</p></section></aside></div>
  </div>;
}
