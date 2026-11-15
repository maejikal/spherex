import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Native modal makes the rest of the explorer inert and traps keyboard focus. */
export function ReviewDialog({ title, onClose, children, className = '', closeLabel = 'Close review window' }: { title: string; onClose: () => void; children: ReactNode; className?: string; closeLabel?: string }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog ref={dialog} className={`review-dialog ${className}`.trim()} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close.current(); }}>
      <header className="review-dialog__header">
        <div><p className="review-eyebrow">SPHEREx Community</p><h2 id={titleId}>{title}</h2></div>
        <button className="button button--secondary" type="button" aria-label={closeLabel} onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="review-dialog__body">{children}</div>
    </dialog>, document.body,
  );
}
