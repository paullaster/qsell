'use server';

import { getContainer } from '@/server/di/container';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What we have paid this vendor: the vendor comes from the session, never from the request. */
export async function vendorPaymentsAction(before: { stamp: string; id: string } | null = null) {
  return await portal('payments_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.stamp.length <= 40 ? { stamp: before.stamp, id: before.id } : null;
    return await getContainer().vendorPayments.remittances(me.vendorId, cursor);
  });
}

export async function vendorCertificatesAction(before: { stamp: string; id: string } | null = null) {
  return await portal('certificates_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.stamp.length <= 40 ? { stamp: before.stamp, id: before.id } : null;
    return await getContainer().paymentTerms.vendorCertificates(me.vendorId, cursor);
  });
}

export async function vendorCertificateAction(certificateId: string) {
  return await portal('certificate_view', async (me) => {
    if (!UUID.test(certificateId)) throw new ProfileError('NOT_FOUND', 'That certificate does not exist.');
    const found = await getContainer().paymentTerms.certificate(me.companyId, certificateId, me.vendorId);
    if (found === null) throw new ProfileError('NOT_FOUND', 'That certificate does not exist.');
    return found;
  });
}
