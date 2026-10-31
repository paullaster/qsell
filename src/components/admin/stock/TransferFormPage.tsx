'use client';

import { useRouter } from 'next/navigation';
import { TransferForm } from './TransferForm';
import { PageHeader, cardClass } from '@/components/ui/screen-kit';

/** The page for a new transfer. Saving it opens the transfer, ready to be sent for approval or sent. */
export function TransferFormPage() {
  const router = useRouter();
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New stock transfer" intro="Choose where the stock leaves from and where it is going, then the products and how many. Nothing moves until the transfer is sent." />
      <div className={cardClass}>
        <TransferForm draft={null} onCancel={() => router.push('/admin/inventory/transfers')} onSaved={(id) => router.push(`/admin/inventory/transfers/${id}`)} />
      </div>
    </div>
  );
}
