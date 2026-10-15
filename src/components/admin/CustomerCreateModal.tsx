'use client';

import { useRouter } from 'next/navigation';
import { publishCustomerCreated } from '@/components/admin/customer-created';
import { CustomerCreateForm } from '@/components/admin/CustomerCreateForm';
import { RouteModal } from '@/components/admin/RouteModal';
import { cardClass } from '@/components/ui/screen-kit';

/** The new-customer window over whatever screen asked for it, or the same form as a page of its own. */
export function CustomerCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/customers');
  };

  const form = (
    <CustomerCreateForm
      onCancel={close}
      onSaved={(customer) => {
        if (presentation === 'intercepted') {
          publishCustomerCreated({ id: customer.id, label: customer.name });
          router.back();
        } else {
          router.push('/admin/customers');
          router.refresh();
        }
      }}
    />
  );

  if (presentation === 'intercepted') {
    return (
      <RouteModal title="Create customer" onClose={close}>
        <p className="mb-3 text-xs text-fg-muted">Add the customer, then carry on where you were.</p>
        {form}
      </RouteModal>
    );
  }
  return (
    <div className={`${cardClass} max-w-xl space-y-3`}>
      <h2 className="text-base font-bold text-fg-strong">Create customer</h2>
      {form}
    </div>
  );
}
