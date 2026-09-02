'use client';

import { useRouter } from 'next/navigation';
import { AdminPaymentConfig } from '@/components/admin/AdminPaymentConfig';
import type { PaymentGatewayConfig } from '@/types/index';

export function AdminPaymentConfigClient({
  gatewaysPromise,
}: {
  gatewaysPromise: Promise<PaymentGatewayConfig[]>;
}) {
  const router = useRouter();
  return (
    <AdminPaymentConfig gatewaysPromise={gatewaysPromise} onRefresh={() => router.refresh()} />
  );
}
