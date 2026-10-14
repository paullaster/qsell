import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/** True when this dialog is the last modal dialog in the page, which is the one drawn on top. */
function isTopmost(dialog: HTMLElement | null): boolean {
  if (dialog === null) return false;
  const open = document.querySelectorAll(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
  );
  return open.item(open.length - 1) === dialog;
}

/**
 * For a dialog: Escape closes it, Tab stays inside it, and focus goes back to whatever opened it.
 * Put the returned ref on the dialog element.
 */
export function useModalKeys<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  // The newest callback, so a new one on a re-render does not restart the effect below: that would
  // hand focus back to the opener while the dialog is still open.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      // With one dialog open over another, only the one on top reacts.
      if (!isTopmost(ref.current)) return;
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || ref.current === null) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);
  return ref;
}
