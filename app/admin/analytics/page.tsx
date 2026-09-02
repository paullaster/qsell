import { listAnalyticsAction } from '@/server/domains/analytics/actions';
import { listCustomersAction } from '@/server/domains/customers/actions';
import { AdminAnalyticsClient } from '@/components/admin/AdminAnalyticsClient';
import type { UserProfile } from '@/types/index';

export default async function Page() {
  const analyticsPromise = listAnalyticsAction();
  const userProfilesPromise = listCustomersAction().then((customers) =>
    customers.map(
      (c): UserProfile => ({
        ...c,
        preferredPaymentMethod: c.paymentPreferences?.preferredMethod || 'mpesa_daraja',
      })
    )
  );
  return (
    <AdminAnalyticsClient
      analyticsPromise={analyticsPromise}
      userProfilesPromise={userProfilesPromise}
    />
  );
}
