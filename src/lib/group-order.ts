/**
 * Group orders (docs/architecture/configurable-packages.md, section 9): pure rules shared by the page and the server.
 * The token in a group's link is 24 random bytes in base64url: 32 characters from this alphabet. Anything else is not one of ours.
 */
export const GROUP_TOKEN_LENGTH = 32;
export const MAX_GROUP_ENTRIES = 100;
export const MAX_PERSON_NAME = 60;
export const MAX_GROUP_TITLE = 80;

export const isWellFormedGroupToken = (value: unknown): value is string => typeof value === 'string' && value.length === GROUP_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);

/** A person's name as typed: trimmed, runs of spaces made one, bounded; empty when there is nothing readable. Plain text, never markup. */
export const cleanPersonName = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_PERSON_NAME) : '');

export const cleanTitle = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_TITLE) : '');

/** `YYYY-MM-DD` that is a real calendar day, or null. */
export function cleanDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

export interface GroupState {
  status: 'open' | 'closed' | 'cancelled';
  closesAt: Date | null;
}

/** Whether people can still add or change a choice: the group is open and its closing time has not come. The clock is passed in. */
export const groupAcceptsChoices = (group: GroupState, now: Date): boolean => group.status === 'open' && (group.closesAt === null || group.closesAt.getTime() > now.getTime());

/** Why choices are not being taken, in plain words, or null when they are. */
export function groupClosedReason(group: GroupState, now: Date): string | null {
  if (group.status === 'cancelled') return 'This group order was cancelled.';
  if (group.status === 'closed') return 'This group order is closed: the organiser has stopped taking choices.';
  if (group.closesAt !== null && group.closesAt.getTime() <= now.getTime()) return 'This group order has closed: its time to choose is over.';
  return null;
}

export interface GroupEntryForCart<P> {
  selectionKey: string;
  personName: string;
  picks: P;
  note: string;
}

/**
 * The organiser's cart lines: identical choices (same selection, same note) are one line with that many servings, in the order they
 * first came. The names that stand behind each line are kept, for the organiser to read.
 */
export function groupCartLines<P>(entries: readonly GroupEntryForCart<P>[]): { selectionKey: string; picks: P; note: string; servings: number; people: string[] }[] {
  const lines: { selectionKey: string; picks: P; note: string; servings: number; people: string[] }[] = [];
  for (const entry of entries) {
    const found = lines.find((l) => l.selectionKey === entry.selectionKey);
    if (found === undefined) lines.push({ selectionKey: entry.selectionKey, picks: entry.picks, note: entry.note, servings: 1, people: [entry.personName] });
    else {
      found.servings += 1;
      found.people.push(entry.personName);
    }
  }
  return lines;
}
