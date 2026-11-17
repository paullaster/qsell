'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { BUILT_IN_TIME_ZONE } from '@/lib/business-timezone';
import { dateIn, whenOrBlank, type Instant } from '@/lib/business-time-format';

const BusinessTimeZoneContext = createContext<string>(BUILT_IN_TIME_ZONE);

/** Gives every screen below it the business's time zone (read from the company on the server), so no screen writes a time in a zone of its own. */
export function BusinessTimeZoneProvider({ timeZone, children }: { timeZone: string; children: ReactNode }) {
  return <BusinessTimeZoneContext.Provider value={timeZone}>{children}</BusinessTimeZoneContext.Provider>;
}

/** The business's time zone, as the company chose it in Settings. */
export function useBusinessTimeZone(): string {
  return useContext(BusinessTimeZoneContext);
}

/** Writes an instant as "18 Oct 2026, 17:00" in the business's time zone. */
export function useWhen(): (iso: Instant | null | undefined) => string {
  const timeZone = useBusinessTimeZone();
  return (iso) => whenOrBlank(iso, timeZone);
}

/** Writes an instant's date as "18 Oct 2026" in the business's time zone. */
export function useDate(): (iso: Instant) => string {
  const timeZone = useBusinessTimeZone();
  return (iso) => dateIn(iso, timeZone);
}
