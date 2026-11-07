import { ArrowLeftRight } from 'lucide-react';

/** The Replace button on a line, the same on a quote, a quote template and a section template. */
export function ReplaceLineButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Replace this item with another product"
      aria-label={`Replace ${name}`}
      className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-indigo-600 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-indigo-500"
    >
      <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Replace</span>
    </button>
  );
}
