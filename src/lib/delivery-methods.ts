export const DELIVERY_METHODS = ['own_fleet', 'courier', 'pickup', 'scheduled_visit'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const isDeliveryMethod = (value: unknown): value is DeliveryMethod => typeof value === 'string' && (DELIVERY_METHODS as readonly string[]).includes(value);

/** What each way of getting an order to the customer is called, and what it means, in everyday words. */
export const METHOD_WORDS: Record<DeliveryMethod, { name: string; means: string }> = {
  own_fleet: { name: 'Our own riders or vehicles', means: 'We deliver with our own riders, vans or motorbikes.' },
  courier: { name: 'A courier', means: 'We hand the parcel to a courier company, who delivers it.' },
  pickup: { name: 'Customer collects', means: 'The customer comes to the branch for their order.' },
  scheduled_visit: { name: 'A booked visit', means: 'A crew visits at an agreed time, for example to install or set up.' },
};

export interface MethodSettings {
  isActive: boolean;
  leadTimeMinutes: number;
  note: string | null;
}

export const DEFAULT_METHOD_SETTINGS: MethodSettings = { isActive: false, leadTimeMinutes: 0, note: null };

const MAX_LEAD_MINUTES = 43200;

/** The settings for one method as typed, or the first thing wrong with them in plain words. */
export function readMethodSettings(raw: Record<string, unknown>): { ok: true; value: MethodSettings } | { ok: false; error: string } {
  if (typeof raw.isActive !== 'boolean') return { ok: false, error: 'Say whether the branch offers this method.' };
  const lead = typeof raw.leadTimeMinutes === 'string' && raw.leadTimeMinutes.trim() !== '' ? Number(raw.leadTimeMinutes) : raw.leadTimeMinutes;
  if (typeof lead !== 'number' || !Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_MINUTES) return { ok: false, error: 'The preparation time is a whole number of minutes, from 0 to 43200 (30 days).' };
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '';
  return { ok: true, value: { isActive: raw.isActive, leadTimeMinutes: lead, note: note === '' ? null : note } };
}

/** A preparation time in words: "Ready at once", "30 minutes", "2 hours", "1 day". */
export function leadTimeWords(minutes: number): string {
  if (minutes <= 0) return 'Ready at once';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return `${String(minutes / 1440)} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${String(minutes / 60)} hour${minutes === 60 ? '' : 's'}`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}
