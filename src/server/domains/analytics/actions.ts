'use server';

import { AnalyticsService } from './service';
import type { DashboardAnalytics } from '@/types/index';

export async function listAnalyticsAction(): Promise<DashboardAnalytics> {
  return AnalyticsService.getDashboardAnalytics();
}

export const fetchAnalyticsAction = listAnalyticsAction;
export const fetchDashboardAnalyticsAction = listAnalyticsAction;

export async function getUserAnalyticsAction(userId: string) {
  return AnalyticsService.getUserAnalytics(userId);
}
