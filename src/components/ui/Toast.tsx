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
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-3 max-w-md w-full pointer-events-none px-4 sm:px-0">
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
              className={`pointer-events-auto flex items-start gap-3 p-4 rounded-xl border backdrop-blur-md shadow-xl ${bgBorder}`}
            >
              <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${iconColor}`} />
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold tracking-tight">{toast.title}</h4>
                <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                  {toast.description || toast.message}
                </p>
              </div>
              <button
                onClick={() => onDismiss(toast.id)}
                className="text-slate-400 hover:text-white transition-colors p-1 -mr-1 -mt-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export const Toast = ToastContainer;
