'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Toast, type ToastNotification } from '@/components/ui/Toast';

type ToastInput = Omit<ToastNotification, 'id'>;

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/** Shows short messages in the corner of the shop; anywhere below can send one with `useToast()`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback(
    (toast: ToastInput) => {
      counter.current += 1;
      const id = `toast-${String(counter.current)}`;
      // The same message twice at once (two parts of the page noticing the same thing) is shown once.
      setToasts((current) =>
        current.some((shown) => shown.title === toast.title && shown.message === toast.message) ? current : [...current.slice(-3), { ...toast, id }],
      );
      // A message goes away by itself; a problem stays a little longer so it can be read.
      setTimeout(() => dismiss(id), toast.type === 'error' || toast.type === 'warning' ? 9000 : 4500);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" role="status">
        <Toast toasts={toasts} onDismiss={dismiss} />
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  const show = useContext(ToastContext);
  if (show === null) throw new Error('useToast must be used inside <ToastProvider>.');
  return show;
}

