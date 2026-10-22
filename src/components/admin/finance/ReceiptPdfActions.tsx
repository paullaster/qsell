'use client';

import { useState } from 'react';
import { buttonClass } from './ui';

const pdfUrl = (receiptId: string, inline: boolean): string => `/api/admin/finance/receipts/${encodeURIComponent(receiptId)}/pdf${inline ? '?inline=1' : ''}`;

/** A draft is not money received and a cancelled one never was, so only posted and reversed receipts have a PDF. */
export const hasReceiptPdf = (status: string): boolean => status === 'posted' || status === 'reversed';

/** Fetches the PDF and hands it to the browser's print dialog through a hidden frame, so the person never leaves the page. */
async function printPdf(receiptId: string): Promise<string | null> {
  const response = await fetch(pdfUrl(receiptId, true), { credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? 'The receipt could not be prepared. Please try again.';
  }
  const url = URL.createObjectURL(await response.blob());
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0;';
  const cleanup = () => {
    frame.remove();
    URL.revokeObjectURL(url);
  };
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      // Some browsers refuse to print a frame; the PDF opens in a tab instead.
      window.open(url, '_blank', 'noopener');
    }
    window.setTimeout(cleanup, 120_000);
  };
  frame.src = url;
  document.body.appendChild(frame);
  return null;
}

/**
 * Download and Print for one receipt. The server decides who may and what is printed (`receipts:read`); this only asks.
 * `compact` is for table rows and cards, where the buttons sit beside other links.
 */
export function ReceiptPdfActions({ receiptId, status, number, compact = false }: { receiptId: string; status: string; number: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!hasReceiptPdf(status)) return null;
  const size = compact ? 'min-h-10 px-3 py-2' : '';
  const print = async () => {
    setBusy(true);
    setError(null);
    try {
      setError(await printPdf(receiptId));
    } catch {
      setError('The receipt could not be prepared. Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={pdfUrl(receiptId, false)} download className={`${buttonClass} ${size}`} aria-label={`Download receipt ${number} as PDF`}>Download PDF</a>
      <button type="button" className={`${buttonClass} ${size}`} disabled={busy} onClick={() => void print()} aria-label={`Print receipt ${number}`}>{busy ? 'Preparing…' : 'Print'}</button>
      {error !== null ? <span role="alert" className="basis-full text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
