'use client';

import { useEffect, useRef, useState } from 'react';
import { previewQuoteTotalsAction } from '@/server/domains/quotes/form-actions';
import type { QuoteInput } from '@/server/domains/quotes/service';
import type { QuoteTotals } from '@/server/domains/quotes/totals';

const PAUSE_MS = 250;

/**
 * What the quote being typed comes to. The server works it out (net, tax, cost, margin, section
 * totals, and whether the margin is under the floor) a moment after the last change; this only
 * asks and keeps the newest answer. Until the first answer, `totals` is null.
 */
export function useQuoteTotals(input: QuoteInput): {
  totals: QuoteTotals | null;
  failed: string | null;
} {
  const [totals, setTotals] = useState<QuoteTotals | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef('');

  const request = {
    lines: input.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      discountPercent: line.discountPercent,
      ...(line.unitPrice === undefined ? {} : { unitPrice: line.unitPrice }),
      sectionId: line.sectionId ?? null,
    })),
    discountPercent: input.discountPercent,
    shippingFee: Number.isFinite(input.shippingFee) ? input.shippingFee : 0,
  };
  const signature = JSON.stringify(request);

  useEffect(() => {
    latest.current = signature;
    const timer = setTimeout(() => {
      void previewQuoteTotalsAction(JSON.parse(signature)).then((result) => {
        // An answer for a quote that has since changed would be wrong: drop it.
        if (latest.current !== signature) return;
        if (result.ok) {
          setTotals(result.data);
          setFailed(null);
        } else {
          setFailed(result.error);
        }
      });
    }, PAUSE_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  return { totals, failed };
}
