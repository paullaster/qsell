'use client';

import { canonicalSale, type OfflineSale, type SignedOfflineSale } from '@/server/domains/selling/offline/offline-rules';

/** Signs a sale with the shift's key in the browser (HMAC-SHA256 over the same text the server signs), so a change made after it was rung up is seen. */
export async function signInBrowser(secret: string, sale: OfflineSale): Promise<SignedOfflineSale> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalSale(sale)));
  return { ...sale, signature: Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('') };
}
