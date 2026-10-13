import { listFiscalAction, trialBalanceAction } from '@/server/domains/finance/actions';
import { TrialBalanceClient } from '@/components/admin/finance/TrialBalanceClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminTrialBalancePage() {
  return (
    <FinanceGate>
      {async () => {
        const years = await listFiscalAction();
        if (!years.ok) return <LoadFailed error={years.error} />;
        const today = new Date().toISOString().slice(0, 10);
        const current = years.data.find((y) => y.startsOn <= today && y.endsOn >= today) ?? years.data[years.data.length - 1];
        const from = current?.startsOn ?? today;
        const to = current && current.endsOn < today ? current.endsOn : today;
        const res = await trialBalanceAction(from, to);
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <TrialBalanceClient initial={res.data} from={from} to={to} />;
      }}
    </FinanceGate>
  );
}
