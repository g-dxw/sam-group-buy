import { useId, useLayoutEffect, useRef, useState } from 'react';
import './product-description.css';

export default function ProductDescription({ text, className = '', name = '' }) {
  const content = typeof text === 'string' ? text.trim() : '';
  const id = useId();
  const paragraph = useRef(null);
  const [canExpand, setCanExpand] = useState(false);
  const [expandedText, setExpandedText] = useState(null);
  const expanded = expandedText === content && Boolean(content);

  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element) { setCanExpand(false); return; }
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setCanExpand(Number.isFinite(lineHeight) && element.scrollHeight > lineHeight * 2 + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [content]);

  if (!content) return null;
  return <div className={`product-description-block ${canExpand ? 'has-overflow' : ''} ${expanded ? 'is-expanded' : ''}`}>
    <p id={id} ref={paragraph} className={`${className} product-description-copy ${expanded ? 'is-expanded' : 'is-collapsed'}`}>{content}</p>
    {canExpand && <button type="button" className="product-description-toggle" aria-controls={id} aria-expanded={expanded}
      aria-label={`${expanded ? '收起' : '展开'}${name ? `${name}的` : ''}商品说明`}
      onClick={() => setExpandedText(expanded ? null : content)}>{expanded ? '收起' : '展开'}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg></button>}
  </div>;
}
