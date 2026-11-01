import type { Metadata } from 'next';
import { CountFormPage } from '@/components/admin/stock/CountFormPage';

export const metadata: Metadata = { title: 'New stock count' };

export default function NewStockCountPage() {
  return <CountFormPage />;
}
