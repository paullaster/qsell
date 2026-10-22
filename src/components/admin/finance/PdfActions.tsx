'use client';

import { useState } from 'react';
import { buttonClass } from './ui';

/** Fetches the PDF and hands it to the browser's print dialog through a hidden frame, so the person never leaves the page. */
async function printPdf(inlineUrl: string): Promise<string | null> {
  const response = await fetch(inlineUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? 'The document could not be prepared. Please try again.';
  }
  const url = URL.createObjectURL(await response.blob());
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0;';
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      // Some browsers refuse to print a frame; the PDF opens in a tab instead.
      window.open(url, '_blank', 'noopener');
    }
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 120_000);
  };
  frame.src = url;
  document.body.appendChild(frame);
  return null;
}

/**
 * Download and Print for one PDF document served by a finance route (`<url>` downloads, `<url>?inline=1` is for printing).
 * The server decides who may and what is printed; this only asks. `compact` is for table rows and cards.
 */
export function PdfActions({ url, noun, number, compact = false }: { url: string; noun: string; number: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = compact ? 'min-h-10 px-3 py-2' : '';
  const print = async () => {
    setBusy(true);
    setError(null);
    try {
      setError(await printPdf(`${url}?inline=1`));
    } catch {
      setError('The document could not be prepared. Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={url} download className={`${buttonClass} ${size}`} aria-label={`Download ${noun} ${number} as PDF`}>Download PDF</a>
      <button type="button" className={`${buttonClass} ${size}`} disabled={busy} onClick={() => void print()} aria-label={`Print ${noun} ${number}`}>{busy ? 'Preparing…' : 'Print'}</button>
      {error !== null ? <span role="alert" className="basis-full text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
