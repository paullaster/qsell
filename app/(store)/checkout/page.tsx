import type { Metadata } from 'next';
import { CheckoutScreen } from '@/components/store/checkout/CheckoutScreen';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false, follow: false } };

export default function CheckoutPage() {
  return <CheckoutScreen />;
}
