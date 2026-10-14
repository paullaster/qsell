import { redirect } from 'next/navigation';

/** The old gateway toggles were replaced by Settings → Payments. */
export default function AdminGatewaysPage() {
  redirect('/admin/settings/payments');
}
