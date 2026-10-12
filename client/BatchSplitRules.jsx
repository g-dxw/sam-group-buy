import { useId, useState } from 'react';
import './split-admin.css';

const money = cents => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const priceText = cents => (Number(cents || 0) / 100).toFixed(2);

export function parsePortionPrice(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('每份售价请填写不小于 0 的金额，最多两位小数。');
  const [whole, decimal = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) throw new Error('每份售价不能超过 100 万元，请调整金额。');
  return cents;
}

export function splitRulesFromForm(form) {
  const rules = JSON.parse(String(form.get('splitRules') || '{}'));
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('按份拼单设置无效，请重新打开本期编辑。');
  const selectedIds = new Set(form.getAll('productIds').map(String));
  const normalized = {};
  for (const [id, rule] of Object.entries(rules)) {
    if (!selectedIds.has(id)) throw new Error('按份拼单商品必须保留在本期商品中。');
    const partsPerPack = Number(rule.partsPerPack);
    if (!Number.isInteger(partsPerPack) || partsPerPack < 2 || partsPerPack > 1000) throw new Error('每包拆分份数请填写 2 至 1000 的整数。');
    const portionSpec = String(rule.portionSpec || '').trim();
    if (!portionSpec || portionSpec.length > 200) throw new Error('请填写每份规格，最多 200 字。');
    const priceCents = rule.priceText === undefined ? rule.priceCents : parsePortionPrice(rule.priceText);
    if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100_000_000) throw new Error('每份售价请填写 0 至 100 万元的金额。');
    normalized[id] = { partsPerPack, portionSpec, priceCents };
  }
  return normalized;
}

export default function BatchSplitRules({ products, selectedIds, value = {}, lockedProductIds = [] }) {
  const id = useId();
  const [rules, setRules] = useState(() => Object.fromEntries(Object.entries(value).map(([productId, rule]) => [productId, { ...rule, priceText: priceText(rule.priceCents) }])));
  const selected = new Set(selectedIds);
  const locked = new Set(lockedProductIds);
  const rows = products.filter(product => selected.has(product.id));
  const serialized = Object.fromEntries(Object.entries(rules).filter(([productId]) => selected.has(productId) || locked.has(productId)));
  const enabledCount = Object.keys(serialized).length;
  function change(productId, key, next) {
    setRules(previous => ({ ...previous, [productId]: { ...previous[productId], [key]: next } }));
  }
  function toggle(product, enabled) {
    setRules(previous => {
      const next = { ...previous };
      if (enabled) next[product.id] = { partsPerPack: 2, portionSpec: '', priceText: priceText(Math.round((product.priceCents || 0) / 2)) };
      else delete next[product.id];
      return next;
    });
  }
  return <section className="admin-batch-splits" aria-labelledby={`${id}-title`}>
    <input type="hidden" name="splitRules" value={JSON.stringify(serialized)} />
    <h3 id={`${id}-title`}>按份拼单 <span>{enabledCount ? `${enabledCount} 件` : '选填'}</span></h3>
    <p className="admin-help">选中的商品可按份售卖。客户选份数，截单后按整包确认采购；每份金额沿用本期推荐商品代购费率。</p>
    {!rows.length ? <p className="admin-help admin-split-empty">请先选择本期商品。</p> : <details className="admin-split-rules-list" open={enabledCount > 0 || undefined}><summary>设置本期商品的售卖方式</summary><div>{rows.map(product => {
      const rule = rules[product.id];
      const isLocked = locked.has(product.id);
      const rowId = `${id}-${product.id}`;
      return <div className={`admin-split-rule ${rule ? 'is-enabled' : ''}`} key={product.id}>
        <div className="admin-split-rule-heading"><div><strong>{product.name}</strong><small>原包装：{product.spec || '详见商品名称'} · 整包售价 {money(product.priceCents)}/{product.unit || '包'}</small>{Number.isSafeInteger(product.originalPriceCents) && <small>原价参考：{money(product.originalPriceCents)}/{product.unit || '包'}</small>}</div><label className="admin-checkbox"><input type="checkbox" checked={Boolean(rule)} disabled={isLocked} onChange={event => toggle(product, event.currentTarget.checked)} aria-label={`${product.name}按份拼单`} /><span>按份拼单</span></label></div>
        {rule && <div className="admin-split-rule-fields">
          <label className="admin-field" htmlFor={`${rowId}-parts`}>每包拆分份数<input id={`${rowId}-parts`} type="number" inputMode="numeric" min="2" max="1000" step="1" required value={rule.partsPerPack} disabled={isLocked} onChange={event => change(product.id, 'partsPerPack', event.currentTarget.value)} onInput={event => change(product.id, 'partsPerPack', event.currentTarget.value)} /></label>
          <label className="admin-field" htmlFor={`${rowId}-price`}>每份售价（元）<input id={`${rowId}-price`} type="number" inputMode="decimal" min="0" max="1000000" step="0.01" required value={rule.priceText} onChange={event => change(product.id, 'priceText', event.currentTarget.value)} onInput={event => change(product.id, 'priceText', event.currentTarget.value)} /><button type="button" className="admin-link admin-split-price-fill" disabled={!Number.isInteger(Number(rule.partsPerPack)) || Number(rule.partsPerPack) < 2 || Number(rule.partsPerPack) > 1000} onClick={() => change(product.id, 'priceText', priceText(Math.round((product.priceCents || 0) / Number(rule.partsPerPack))))}>按整包价 ÷ 份数填入</button></label>
          <label className="admin-field admin-split-spec" htmlFor={`${rowId}-spec`}>每份规格说明<input id={`${rowId}-spec`} type="text" maxLength={200} required value={rule.portionSpec} placeholder="例如：约 600g，或每份 2 小袋" disabled={isLocked} onChange={event => change(product.id, 'portionSpec', event.currentTarget.value)} onInput={event => change(product.id, 'portionSpec', event.currentTarget.value)} onCompositionEnd={event => change(product.id, 'portionSpec', event.currentTarget.value)} /></label>
        </div>}
        {isLocked && <p className="admin-help admin-split-lock-note">已有订单，售卖方式{rule ? '、拆分份数和规格' : ''}已锁定{rule ? '；每份售价可调整，仅影响后续新订单' : '，本期不能改为按份拼单'}。</p>}
      </div>;
    })}</div></details>}
    <p className="admin-help admin-split-policy-note">每份售价按整包售价预填，四舍五入至分，可单独调整；商品库调价不会自动覆盖本期每份售价。同一期同款商品使用一种售卖方式。确认采购前均为待拼；截单余份默认不成团，也可由你补齐。</p>
  </section>;
}

export function BatchSplitSummary({ batch, products }) {
  const rules = Object.entries(batch.splitRules || {});
  if (!rules.length) return null;
  return <div className="wide"><dt>本期按份拼单</dt><dd><ul className="admin-split-summary">{rules.map(([productId, rule]) => <li key={productId}><strong>{products.find(product => product.id === productId)?.name || productId}</strong><span>每包 {rule.partsPerPack} 份 · {rule.portionSpec} · {money(rule.priceCents)}/份</span></li>)}</ul></dd></div>;
}

export function SplitOrderProgress({ order }) {
  if (!order.split) return null;
  return <div className="admin-split-order-info"><span className="admin-split-badge">按份拼单</span><span>每包 {order.split.partsPerPack} 份 · {order.split.portionSpec}</span><div className="admin-split-order-quantities"><span>成团 <strong>{order.split.formedQuantity || 0} 份</strong></span>{order.split.pendingQuantity > 0 && <span>待拼 <strong>{order.split.pendingQuantity} 份</strong></span>}{order.split.unformedQuantity > 0 && <span>未成团 <strong>{order.split.unformedQuantity} 份</strong></span>}</div>{order.pendingGoodsCents > 0 && <p>待拼商品金额 {money(order.pendingGoodsCents)}，确认成团后计入应付。</p>}{order.split.settledAt && <p>已确认采购，份数已锁定；取消或缺货的份数由你留存。</p>}</div>;
}

export function SplitGroups({ groups, onConfirm, confirming, locked }) {
  if (!groups?.length) return null;
  return <section className="admin-split-groups" aria-label="按份拼单进度"><div className="admin-section-heading"><div><h2>按份拼单</h2><p>先核对份数，截单后确认原包装采购数量和分货名单。</p></div></div><div className="admin-split-group-list">{groups.map(group => {
    const progress = group.progress;
    const organizerPortions = (progress.topUpPortions || 0) + (progress.retainedPortions || 0);
    const key = `${group.batchCode}:${group.productId}`;
    const saving = confirming === key;
    return <article className="admin-card admin-split-group" key={key}>
      <div className="admin-split-group-heading"><div><h3>{group.productName}</h3><p>每包 {group.partsPerPack} 份 · {group.portionSpec}</p><small>原包装：{group.packSpec} · {group.packPriceSource === 'reference' ? '原价参考' : '售价参考'} {money(group.packPriceCents)}/{group.packUnit || '包'}</small></div><span className={`admin-pill ${progress.settled ? '' : 'neutral'}`}>{progress.settled ? '已确认采购' : '待确认'}</span></div>
      <dl className="admin-split-group-numbers"><div><dt>{progress.settled ? '确认报名' : '有效报名'}</dt><dd>{progress.totalPortions}<small>份</small></dd></div><div><dt>{progress.settled ? '采购原包装' : '已凑满'}</dt><dd>{progress.settled ? progress.purchasedPacks : progress.fullPacks}<small>{group.packUnit || '包'}</small></dd></div><div><dt>{progress.settled ? '你需处理的份数' : '下一包还差'}</dt><dd>{progress.settled ? organizerPortions : progress.neededPortions}<small>份</small></dd></div></dl>
      {progress.settled ? <div className="admin-help admin-split-group-note"><p>确认成团 {progress.formedPortions} 份 · 未成团 {progress.unformedPortions} 份。按下单顺序分货，未成团部分不收费。</p>{organizerPortions > 0 && <p>你补齐 {progress.topUpPortions || 0} 份，确认后取消或缺货留存 {progress.retainedPortions || 0} 份，合计 {organizerPortions} 份由你处理；其他客户不承担差额。</p>}</div> : <div className="admin-split-confirm"><p className="admin-help">{progress.remainingPortions > 0 ? `有 ${progress.remainingPortions} 份尚未凑满一包。可只采购满包，或由你补齐余份。` : '当前份数已凑齐整包。'}确认后份数锁定，商品金额和代购费按成团数量计算。</p>{group.canConfirm ? <div className="admin-actions"><button type="button" className="admin-btn primary" disabled={locked || Boolean(confirming)} onClick={() => onConfirm(group, 'cancel')}>{saving ? '确认中…' : progress.remainingPortions > 0 ? `确认 ${progress.fullPacks} ${group.packUnit || '包'}，余份不成团` : `确认采购 ${progress.fullPacks} ${group.packUnit || '包'}`}</button>{progress.remainingPortions > 0 && <button type="button" className="admin-btn" disabled={locked || Boolean(confirming)} onClick={() => onConfirm(group, 'topUp')}>{saving ? '确认中…' : `补齐 ${progress.neededPortions} 份并确认`}</button>}</div> : <p className="admin-help">本期仍在收集，请先在“团购期次”关闭下单或等待截单时间。</p>}</div>}
      <details className="admin-split-distribution"><summary>{progress.settled ? '查看分货名单' : '查看报名名单'} <span>{group.customers.length} 条</span></summary>{group.customers.length ? <ul>{group.customers.map(customer => <li key={customer.lineId || customer.recordId}><div><strong>{customer.name}</strong><span>{customer.phone}</span><small>报名 {customer.quantity} 份 · {customer.status}</small></div><div>{customer.formedQuantity > 0 && <span className="is-formed">{['已取消', '缺货'].includes(customer.status) ? '你留存' : '成团'} {customer.formedQuantity} 份</span>}{customer.pendingQuantity > 0 && <span>待拼 {customer.pendingQuantity} 份</span>}{customer.unformedQuantity > 0 && <span>未成团 {customer.unformedQuantity} 份</span>}{!customer.formedQuantity && !customer.pendingQuantity && !customer.unformedQuantity && <span>无需分货</span>}</div></li>)}</ul> : <p className="admin-help">暂无报名。</p>}</details>
    </article>;
  })}</div></section>;
}
