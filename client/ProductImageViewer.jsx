import { useId, useLayoutEffect, useRef, useState } from 'react';
import './product-image-viewer.css';

const bodyLocks = new WeakMap();

function lockBody(body) {
  let lock = bodyLocks.get(body);
  if (!lock) {
    lock = { count: 0, overflow: body.style.getPropertyValue('overflow'), priority: body.style.getPropertyPriority('overflow') };
    bodyLocks.set(body, lock);
    body.style.setProperty('overflow', 'hidden');
  }
  lock.count += 1;
  return () => {
    lock.count -= 1;
    if (lock.count > 0) return;
    if (lock.overflow) body.style.setProperty('overflow', lock.overflow, lock.priority);
    else body.style.removeProperty('overflow');
    bodyLocks.delete(body);
  };
}

function focusable(element) {
  return element instanceof HTMLElement && element.isConnected && !element.matches(':disabled')
    && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden';
}

function restoreFocus(trigger) {
  const target = focusable(trigger) ? trigger : [...document.querySelectorAll(
    '[data-product-image-focus-fallback], .catalog-section .search-field input, .customer-sams-form input',
  )].find(focusable);
  target?.focus({ preventScroll: true });
}

function outsideDialog(event) {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

export default function ProductImageViewer({ image, onClose }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const closeRequested = useRef(false);
  const backdropPointer = useRef(false);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  const titleId = useId();
  const isOpen = image !== null && image !== undefined;
  const src = typeof image?.src === 'string' ? image.src.trim() : '';
  const name = typeof image?.name === 'string' && image.name.trim() ? image.name.trim() : '商品图片';
  const [failedSrc, setFailedSrc] = useState(null);
  const failed = !src || failedSrc === src;

  useLayoutEffect(() => { setFailedSrc(null); }, [isOpen, src]);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!isOpen || !element) return;
    closeRequested.current = false;
    backdropPointer.current = false;
    const trigger = document.activeElement;
    const unlock = lockBody(document.body);
    try {
      element.showModal();
      closeButton.current?.focus({ preventScroll: true });
    } catch (error) {
      unlock();
      throw error;
    }
    return () => {
      if (element.open) element.close();
      unlock();
      restoreFocus(trigger);
    };
  }, [isOpen]);

  const requestClose = () => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    closeHandler.current?.();
  };

  return <dialog ref={dialog} className="product-image-viewer-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); requestClose(); }}
    onPointerDown={event => { event.stopPropagation(); backdropPointer.current = outsideDialog(event); }}
    onClick={event => {
      event.stopPropagation();
      if (backdropPointer.current && outsideDialog(event)) requestClose();
      backdropPointer.current = false;
    }}>
    <div className="product-image-viewer-panel">
      <header className="product-image-viewer-header"><h2 id={titleId}>{name}</h2>
        <button ref={closeButton} type="button" className="product-image-viewer-close" aria-label="关闭商品大图"
          onClick={event => { event.stopPropagation(); requestClose(); }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="product-image-viewer-stage">
        {isOpen && (failed ? <div className="product-image-viewer-fallback" role="status">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m3 17 5-5 4 4 3-3 6 6" /></svg>
          <p>图片暂时无法加载</p><span>可以关闭后重新查看。</span>
        </div> : <img key={src} src={src} alt={name} onError={() => setFailedSrc(src)} />)}
      </div>
    </div>
  </dialog>;
}
