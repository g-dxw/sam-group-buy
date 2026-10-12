import './order-fees.css';

export const percent = rateBps => `${Number(rateBps || 0) / 100}%`;
const money = cents => cents == null ? '待确认' : `¥${(cents / 100).toFixed(2)}`;
const feeName = category => category === 'selfSelected' ? '自选商品代购费' : '推荐商品代购费';

export function FeePolicyNotice({ policy }) {
  const recommended = policy?.recommendedRateBps || 0;
  const personal = policy?.selfSelectedRateBps ?? recommended;
  return <div className="customer-fee-policy">
    <strong>本期代购费</strong><span>推荐商品 {percent(recommended)} · 自选商品 {percent(personal)}</span>
    <small>{recommended || personal ? '按商品金额另计，提交前可核对费用明细。' : '本期免代购费。'}</small>
  </div>;
}

export default function OrderFees({ billing, goodsCents, goodsLabel = '商品金额', totalLabel = '应付合计', pending = false }) {
  const groups = billing?.feeBreakdown || [];
  return <div className="customer-order-fees" aria-busy={pending}>
    <div><span>{goodsLabel}</span><strong>{money(billing?.goodsTotalCents ?? goodsCents)}</strong></div>
    {billing ? <>
      {groups.map((group, index) => <div className="customer-fee-detail" key={`${group.category}:${group.rateBps}:${index}`}>
        <span>{feeName(group.category)}<small>{percent(group.rateBps)} · 商品 {money(group.goodsCents)}</small></span><span>{money(group.feeCents)}</span>
      </div>)}
      <div><span>代购费合计</span><strong>{money(billing.feeTotalCents)}</strong></div>
      <div className="customer-fee-payable"><span>{totalLabel}</span><strong>{money(billing.totalCents)}</strong></div>
    </> : <div className="customer-fee-payable" role="status"><span>{totalLabel}</span><strong>{pending ? '正在核对…' : '待核对'}</strong></div>}
  </div>;
}
