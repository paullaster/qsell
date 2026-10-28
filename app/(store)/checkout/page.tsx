import type { Metadata } from 'next';
import { CheckoutScreen } from '@/components/store/checkout/CheckoutScreen';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false, follow: false } };

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ handoff?: string | string[] }>;
}) {
  const { handoff } = await searchParams;
  return <CheckoutScreen cartHandoff={Array.isArray(handoff) ? handoff[0] : handoff} />;
}
