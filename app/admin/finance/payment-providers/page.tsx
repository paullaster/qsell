import { redirect } from 'next/navigation';

/** Payments are set up in one place: Settings → Payments. */
export default function AdminFinancePaymentSetupRedirectPage() {
  redirect('/admin/settings/payments');
}
