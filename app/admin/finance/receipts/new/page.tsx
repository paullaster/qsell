import { receiptFormOptionsAction, receiptPresetCustomerAction } from '@/server/domains/finance/receivables/actions';
import { walletFormOptionsAction } from '@/server/domains/finance/wallet-actions';
import { NewReceiptClient } from '@/components/admin/finance/NewReceiptClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  // Everything starts now, side by side; arriving from a customer's statement (?customer=<number>) has that customer already chosen.
  const options = receiptFormOptionsAction();
  const wallet = walletFormOptionsAction();
  const preset = searchParams.then(({ customer }) => (customer === undefined || customer === '' ? null : receiptPresetCustomerAction(customer)));
  return (
    <FinancePage label="the receipt form">
      <NewReceiptClient optionsPromise={options} presetPromise={preset} walletPromise={wallet} />
    </FinancePage>
  );
}
