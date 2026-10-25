import { PaymentRunProposalClient } from '@/components/admin/vendors/PaymentRunProposalClient';
import { businessDate } from '@/server/kernel/numbering/business-date';

export default function Page() {
  return <PaymentRunProposalClient today={businessDate()} />;
}
