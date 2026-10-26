import { useEffect, type RefObject } from 'react';

/** Closes a pop-up menu on Escape or a press outside it. Pointer-down covers mouse, pen and touch. */
export function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    // Capture, so the menu closes even if the thing pressed stops the event from bubbling.
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, root, onDismiss]);
}
