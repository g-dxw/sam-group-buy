import './service-notice.css';

export function ServiceFooter({ children }) {
  return <footer className="customer-service-footer" aria-label="代购服务说明">
    <div className="customer-footer-summary">{children}</div>
    <div className="customer-service-notice">
      <strong>到货后付款 · 本网页只登记订单，不在线收款</strong>
      <p>代购由本期活动组织者安排。本网页非山姆官方商城，与山姆官方无隶属关系。</p>
      <nav className="customer-service-links" aria-label="服务与隐私说明"><a href="/service.html">代购服务说明</a><a href="/privacy.html">隐私说明</a></nav>
    </div>
  </footer>;
}

export function OrderDataNotice() {
  return <div className="customer-order-data-notice">
    <p>填写手机号后，会用于核对本期商品和代购费；提交后，昵称、手机号和选填备注用于采购、分货与联系。到货后付款。</p>
    <p>提交前可查看 <a href="/service.html">代购服务说明</a> 和 <a href="/privacy.html">隐私说明</a>；修改或取消订单，请在原小区群联系本期活动组织者。</p>
  </div>;
}
