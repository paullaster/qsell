'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { AnalyticsService } from './service';
import type { DashboardAnalytics } from '@/types/index';

export async function listAnalyticsAction(): Promise<DashboardAnalytics> {
  await requirePermission('analytics:read');
  return AnalyticsService.getDashboardAnalytics();
}

export const fetchAnalyticsAction = listAnalyticsAction;
export const fetchDashboardAnalyticsAction = listAnalyticsAction;

export async function getUserAnalyticsAction(userId: string) {
  await requirePermission('analytics:read');
  return AnalyticsService.getUserAnalytics(userId);
}
