import { redirect } from 'next/navigation';

/** The old gateway toggles were replaced by Finance → Payment Setup → Payment providers. */
export default function AdminGatewaysPage() {
  redirect('/admin/finance/payment-providers');
}
