export function formatBatchTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai',
  }) : null;
}

export default function BatchPickupInfo({ batch }) {
  const pickupTime = formatBatchTime(batch?.pickupAt);
  if (!batch?.pickupLocation && !pickupTime) return null;
  return <div className="customer-batch-pickup">
    <span>取货安排</span>
    <div>
      {batch?.pickupLocation && <span>{batch.pickupLocation}</span>}
      {pickupTime && <time dateTime={batch.pickupAt}>{pickupTime}</time>}
    </div>
  </div>;
}
