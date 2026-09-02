'use client';

import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  title: string;
  description?: string;
  message?: string;
}

export type ToastNotification = ToastMessage;

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastProps) {
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-md flex-col gap-3 px-4 sm:px-0">
      <AnimatePresence>
        {toasts.map((toast) => {
          const bgBorder =
            toast.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-100 shadow-emerald-950/50'
              : toast.type === 'warning'
                ? 'bg-amber-950/90 border-amber-500/50 text-amber-100 shadow-amber-950/50'
                : toast.type === 'error'
                  ? 'bg-rose-950/90 border-rose-500/50 text-rose-100 shadow-rose-950/50'
                  : 'bg-indigo-950/90 border-indigo-500/50 text-indigo-100 shadow-indigo-950/50';

          const Icon =
            toast.type === 'success'
              ? CheckCircle2
              : toast.type === 'warning'
                ? AlertTriangle
                : toast.type === 'error'
                  ? XCircle
                  : Info;

          const iconColor =
            toast.type === 'success'
              ? 'text-emerald-400'
              : toast.type === 'warning'
                ? 'text-amber-400'
                : toast.type === 'error'
                  ? 'text-rose-400'
                  : 'text-indigo-400';

          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.95 }}
              transition={{ duration: 0.25 }}
              className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-4 shadow-xl backdrop-blur-md ${bgBorder}`}
            >
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconColor}`} />
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold tracking-tight">{toast.title}</h4>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-300">
                  {toast.description || toast.message}
                </p>
              </div>
              <button
                onClick={() => onDismiss(toast.id)}
                className="-mt-1 -mr-1 rounded-lg p-1 text-slate-400 transition-colors hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export const Toast = ToastContainer;
