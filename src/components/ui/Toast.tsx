'use client';

import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { firstFilled } from '@/lib/values';

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

// A neutral shadow reads correctly on the light tint; the original per-hue -950 glow only made sense against a dark surface.
const TONE: Record<ToastMessage['type'], { bgBorder: string; Icon: typeof Info; iconColor: string }> = {
  success: { bgBorder: 'bg-emerald-50/90 border-emerald-500/50 text-emerald-900 shadow-black/20', Icon: CheckCircle2, iconColor: 'text-emerald-600' },
  warning: { bgBorder: 'bg-amber-50/90 border-amber-500/50 text-amber-900 shadow-black/20', Icon: AlertTriangle, iconColor: 'text-amber-600' },
  error: { bgBorder: 'bg-rose-50/90 border-rose-500/50 text-rose-900 shadow-black/20', Icon: XCircle, iconColor: 'text-rose-600' },
  info: {
    bgBorder: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:bg-indigo-500/20 dark:border-indigo-500/30 dark:text-indigo-400',
    Icon: Info,
    iconColor: 'text-indigo-600 dark:text-indigo-400',
  },
};

export function ToastContainer({ toasts, onDismiss }: ToastProps) {
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-md flex-col gap-3 px-4 sm:px-0">
      <AnimatePresence>
        {toasts.map((toast) => {
          // A neutral shadow reads correctly on the light tint; the original
          // per-hue -950 glow only made sense against a dark surface.
          const { bgBorder, Icon, iconColor } = TONE[toast.type];

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
                <p className="mt-0.5 text-xs leading-relaxed text-fg">
                  {firstFilled(toast.description, toast.message)}
                </p>
              </div>
              <button
                onClick={() => onDismiss(toast.id)}
                className="-mt-1 -mr-1 rounded-lg p-1 text-fg-muted transition-colors hover:text-fg-strong"
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
