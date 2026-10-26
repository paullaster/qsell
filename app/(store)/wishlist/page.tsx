import type { Metadata } from 'next';
import { WishlistScreen } from '@/components/store/wishlist/WishlistScreen';

export const metadata: Metadata = { title: 'Saved products', robots: { index: false, follow: false } };

export default function WishlistPage() {
  return <WishlistScreen />;
}
