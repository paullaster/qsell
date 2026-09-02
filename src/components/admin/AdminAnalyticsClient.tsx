'use client';

import { AdminAnalytics } from '@/components/admin/AdminAnalytics';
import type { DashboardAnalytics, UserProfile } from '@/types/index';

export function AdminAnalyticsClient({
  analyticsPromise,
  userProfilesPromise,
}: {
  analyticsPromise: Promise<DashboardAnalytics>;
  userProfilesPromise: Promise<UserProfile[]>;
}) {
  return (
    <AdminAnalytics
      analyticsPromise={analyticsPromise}
      userProfilesPromise={userProfilesPromise}
    />
  );
}
