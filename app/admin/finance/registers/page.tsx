import { registersAction } from '@/server/domains/finance/actions';
import { RegistersClient } from '@/components/admin/finance/RegistersClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = registersAction();
  return (
    <FinancePage label="postings">
      <RegistersClient viewPromise={view} />
    </FinancePage>
  );
}
