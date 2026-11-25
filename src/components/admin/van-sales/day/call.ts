import type { DayScreen } from '@/server/domains/van-sales/actions';

/** Runs one change to the day and shows the refreshed day. It answers null when the change was made, or the words it was refused in. */
export type DayCall = (call: Promise<{ ok: true; data: DayScreen } | { ok: false; error: string }>, okText: string) => Promise<string | null>;
