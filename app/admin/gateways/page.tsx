import { listGatewaysAction } from '@/server/domains/gateways/actions';
import { AdminPaymentConfigClient } from '@/components/admin/AdminPaymentConfigClient';

export default async function Page() {
  const gatewaysPromise = listGatewaysAction();
  return <AdminPaymentConfigClient gatewaysPromise={gatewaysPromise} />;
}
