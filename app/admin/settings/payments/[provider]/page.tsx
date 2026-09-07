import { redirect } from 'next/navigation';

/** Per-provider routes removed — all payment config lives on one screen. */
export default async function AdminPaymentProviderRedirectPage() {
  redirect('/admin/settings/payments');
}
