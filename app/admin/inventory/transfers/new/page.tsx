import type { Metadata } from 'next';
import { TransferFormPage } from '@/components/admin/stock/TransferFormPage';

export const metadata: Metadata = { title: 'New stock transfer' };

export default function NewStockTransferPage() {
  return <TransferFormPage />;
}
