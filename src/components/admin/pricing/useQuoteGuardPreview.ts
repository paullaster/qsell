'use client';

import { useEffect, useRef, useState } from 'react';
import { previewQuoteGuardAction } from '@/server/domains/pricing/guard-actions';
import type { QuoteInput } from '@/server/domains/quotes/service';
import type { GuardTrace } from '@/server/domains/pricing/domain/types';

/**
 * What the price floors and the person's override limit say about each line of the quote being
 * typed. Only a hint on screen: saving checks again, and decides.
 */
export function useQuoteGuardPreview(input: QuoteInput): Record<number, GuardTrace> {
  const [guards, setGuards] = useState<Record<number, GuardTrace>>({});
  const latest = useRef('');
  const signature = JSON.stringify([
    input.customerId ?? null,
    input.paymentMethod,
    input.discountPercent,
    input.lines.map((l) => [l.productId, l.quantity, l.unitPrice ?? null, l.discountPercent]),
  ]);

  useEffect(() => {
    latest.current = signature;
    const lines = input.lines;
    if (lines.length === 0 || lines.every((l) => !l.productId)) return;
    const timer = setTimeout(() => {
      void previewQuoteGuardAction({
        customerId: input.customerId ?? null,
        paymentMethod: input.paymentMethod,
        quoteDiscountPercent: input.discountPercent,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice ?? null,
          discountPercent: l.discountPercent,
        })),
      }).then((r) => {
        if (!r.ok || latest.current !== signature) return;
        const next: Record<number, GuardTrace> = {};
        r.data.forEach((g, i) => {
          if (g) next[i] = g;
        });
        setGuards(next);
      });
    }, 500);
    return () => clearTimeout(timer);
    // The signature carries everything the check depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return guards;
}
