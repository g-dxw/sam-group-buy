import './split-purchase.css';

const money = cents => `¥${((cents || 0) / 100).toFixed(2)}`;

export function SplitProductInfo({ split, compact = false }) {
  if (!split) return null;
  const parts = split.partsPerPack;
  return <div className={`customer-split-info ${compact ? 'compact' : ''}`}>
    <div><strong>按份拼单</strong><span>每包拆 {parts} 份 · {split.portionSpec}</span></div>
    {!compact && !split.progress?.settled && <small>截单后确认成团，不足整包的部分可能未成团。</small>}
  </div>;
}

export function SplitCartNotice({ pendingGoodsCents }) {
  return <div className="customer-split-cart-notice" role="note">
    <strong>分装商品按份报名，成团后采购</strong>
    <p>{Number.isSafeInteger(pendingGoodsCents) && <>其中 {money(pendingGoodsCents)} 为待拼商品金额。</>}下方金额为预计金额，最终按成团份数收取商品款和代购费。</p>
    <small>按下单顺序凑份；一次购买多份可能部分成团。未成团部分不收费。</small>
  </div>;
}

export function SplitOrderInfo({ split }) {
  if (!split) return null;
  return <div className="customer-split-order-info">
    <span>按份拼单 · 每包 {split.partsPerPack} 份 · {split.portionSpec}</span>
    <div className="status-chips">
      {split.formedQuantity > 0 && <span className="status-chip">已成团 {split.formedQuantity} 份</span>}
      {split.pendingQuantity > 0 && <span className="status-chip split-pending-chip">待拼 {split.pendingQuantity} 份</span>}
      {split.unformedQuantity > 0 && <span className="status-chip muted-chip">未成团 {split.unformedQuantity} 份 · 不收费</span>}
    </div>
  </div>;
}

export function PendingSplitBill({ quantity, goodsCents }) {
  if (!(quantity > 0)) return null;
  return <div className="customer-pending-split-bill">
    <div><strong>待拼 {quantity} 份</strong><span>预计商品金额 {money(goodsCents)}</span></div>
    <p>暂未计入上方应付金额。截单后按成团份数和本期最新代购费率计算；未成团部分不收费。</p>
  </div>;
}
