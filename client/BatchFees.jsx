import { useId, useRef, useState } from 'react';

export const formatFeeRate = rate => `${((Number.isInteger(rate) ? rate : 0) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const percentValue = rate => ((Number.isInteger(rate) ? rate : 0) / 100).toFixed(2).replace(/\.?0+$/, '');
export const feeCategoryLabel = category => category === 'selfSelected' ? '自选商品' : '推荐商品';

export function resolveFeeRates(policy) {
  const recommended = Number.isInteger(policy?.recommendedRateBps) ? policy.recommendedRateBps : 0;
  return { recommended, selfSelected: Number.isInteger(policy?.selfSelectedRateBps) ? policy.selfSelectedRateBps : recommended,
    follows: policy?.selfSelectedRateBps == null };
}

export function parseFeePercent(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}请填写 0 至 100%，最多两位小数。`);
  const [whole, decimal = ''] = text.split('.');
  const rate = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (rate > 10000) throw new Error(`${label}请填写 0 至 100%，最多两位小数。`);
  return rate;
}

export function feePolicyFromForm(form) {
  return { recommendedRateBps: parseFeePercent(form.get('recommendedFeePercent'), '推荐商品代购费率'),
    selfSelectedRateBps: form.has('selfSelectedFeeFollows') ? null : parseFeePercent(form.get('selfSelectedFeePercent'), '自选商品代购费率') };
}

export function feeTotals(value) {
  return { goods: value.goodsTotalCents !== undefined ? value.goodsTotalCents : value.totalCents,
    fee: value.feeTotalCents !== undefined ? value.feeTotalCents : 0, payable: value.totalCents };
}

export function CustomerFeeBill({ customer, money }) {
  const totals = feeTotals(customer);
  return <section className="admin-customer-bill" aria-label="顾客金额明细">
    <dl><div><dt>商品金额</dt><dd>{money(totals.goods)}</dd></div><div><dt>代购费</dt><dd>{money(totals.fee)}</dd></div><div className="is-payable"><dt>应付金额</dt><dd>{money(totals.payable)}</dd></div></dl>
    {Array.isArray(customer.feeBreakdown) && customer.feeBreakdown.length > 0 && <ul className="admin-fee-breakdown">{customer.feeBreakdown.map((row, index) => <li key={`${row.category}:${row.rateBps}:${index}`}><span>{feeCategoryLabel(row.category)} · {formatFeeRate(row.rateBps)}<small>商品金额 {money(row.goodsCents)}</small></span><strong>代购费 {money(row.feeCents)}</strong></li>)}</ul>}
    <p className="admin-help">费用按各次下单时的费率保留；缺货和已取消商品不收代购费。</p>
  </section>;
}

export default function BatchFees({ value }) {
  const id = useId();
  const initial = resolveFeeRates(value);
  const [recommended, setRecommended] = useState(() => percentValue(initial.recommended));
  const [selfSelected, setSelfSelected] = useState(() => percentValue(initial.selfSelected));
  const [follows, setFollows] = useState(initial.follows);
  const [errors, setErrors] = useState({});
  const selfField = useRef(null);
  function change(name, event) {
    event.currentTarget.setCustomValidity('');
    (name === 'recommended' ? setRecommended : setSelfSelected)(event.currentTarget.value);
    setErrors(previous => ({ ...previous, [name]: '' }));
  }
  function validate(name, event) {
    let message = '';
    try { parseFeePercent(event.currentTarget.value, name === 'recommended' ? '推荐商品代购费率' : '自选商品代购费率'); }
    catch (error) { message = error.message; }
    event.currentTarget.setCustomValidity(message);
    setErrors(previous => ({ ...previous, [name]: message }));
  }
  return <section className="admin-batch-fees" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>本期代购费</h3>
    <p className="admin-help" id={`${id}-help`}>按商品金额百分比收取，0% 表示不收费。推荐商品售价可能已包含差价，可将推荐费率设为 0。</p>
    <div className="admin-form-grid">
      <label className="admin-field" htmlFor={`${id}-recommended`}>推荐商品代购费率（%）<input id={`${id}-recommended`} name="recommendedFeePercent" type="number" inputMode="decimal" min="0" max="100" step="0.01" required value={recommended} onChange={event => change('recommended', event)} onInput={event => change('recommended', event)} onBlur={event => validate('recommended', event)} aria-invalid={Boolean(errors.recommended)} aria-describedby={errors.recommended ? `${id}-recommended-error` : `${id}-help`} />{errors.recommended && <span className="admin-fee-field-error" id={`${id}-recommended-error`} role="alert">{errors.recommended}</span>}</label>
      <label className="admin-field" htmlFor={`${id}-self`}>自选商品代购费率（%）<input ref={selfField} id={`${id}-self`} name="selfSelectedFeePercent" type="number" inputMode="decimal" min="0" max="100" step="0.01" required={!follows} disabled={follows} value={follows ? recommended : selfSelected} onChange={event => change('selfSelected', event)} onInput={event => change('selfSelected', event)} onBlur={event => validate('selfSelected', event)} aria-invalid={!follows && Boolean(errors.selfSelected)} aria-describedby={!follows && errors.selfSelected ? `${id}-self-error` : `${id}-help`} />{!follows && errors.selfSelected && <span className="admin-fee-field-error" id={`${id}-self-error`} role="alert">{errors.selfSelected}</span>}</label>
    </div>
    <label className="admin-checkbox"><input name="selfSelectedFeeFollows" type="checkbox" checked={follows} onChange={event => { const next = event.currentTarget.checked; if (!next) setSelfSelected(recommended); selfField.current?.setCustomValidity(''); setFollows(next); setErrors(previous => ({ ...previous, selfSelected: '' })); }} /><span>自选商品费率跟随推荐商品</span></label>
    <p className="admin-help admin-batch-fees-note">关闭跟随后，可单独设置自选费率，也可设为 0%。保存只影响后续新订单，已有订单的代购费率保留。</p>
  </section>;
}
