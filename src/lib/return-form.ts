/**
 * The returns screens: wording for states, conditions and what was done with the goods, and what
 * the "confirm what arrived" form sends. Pure.
 */
import type { StatusInfo } from './finance-statuses';

export const RETURN_STATUS: Record<string, StatusInfo> = {
  awaiting_goods: { label: 'Waiting for the goods', tone: 'amber' },
  partially_confirmed: { label: 'Partly received', tone: 'sky' },
  confirmed: { label: 'Received', tone: 'green' },
  rejected: { label: 'Closed: not coming', tone: 'gray' },
};

export const CONDITIONS = [
  { id: 'good', label: 'Good' },
  { id: 'damaged', label: 'Damaged' },
  { id: 'expired', label: 'Expired' },
  { id: 'wrong_item', label: 'Wrong item' },
] as const;

export const DISPOSITIONS = [
  { id: 'return_to_stock', label: 'Put back into stock' },
  { id: 'quarantine', label: 'Quarantine (not for sale)' },
  { id: 'scrap', label: 'Scrap / write off' },
  { id: 'return_to_supplier', label: 'Return to supplier' },
] as const;

export type ConditionId = (typeof CONDITIONS)[number]['id'];
export type DispositionId = (typeof DISPOSITIONS)[number]['id'];

export const conditionLabel = (id: string): string => CONDITIONS.find((c) => c.id === id)?.label ?? id;
export const dispositionLabel = (id: string): string => DISPOSITIONS.find((d) => d.id === id)?.label ?? id;

export interface Entry {
  qty: string;
  condition: { id: string; label: string };
  disposition: { id: string; label: string };
  note: string;
}

export const blankEntry = (suggested: string): Entry => ({
  qty: '',
  condition: { id: 'good', label: conditionLabel('good') },
  disposition: { id: suggested, label: dispositionLabel(suggested) },
  note: '',
});

export const blankEntries = (lineIds: readonly string[], suggested: string): Record<string, Entry> => Object.fromEntries(lineIds.map((id) => [id, blankEntry(suggested)]));

const quantity = (entry: Entry): number => {
  const n = Number(entry.qty);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The lines with something typed, as the server expects them. */
export function confirmItems(
  lineIds: readonly string[],
  entries: Readonly<Record<string, Entry>>,
  /** The unit each line's count is typed in, when it was sold in one (the server checks it against the line). */
  unitOf: Readonly<Record<string, string | null>> = {},
) {
  return lineIds
    .filter((id) => Object.hasOwn(entries, id) && quantity(entries[id]) > 0)
    .map((id) => {
      const e = entries[id];
      const note = e.note.trim();
      return { lineId: id, quantity: quantity(e), ...(Object.hasOwn(unitOf, id) && unitOf[id] !== null ? { unitId: unitOf[id] } : {}), condition: e.condition.id as ConditionId, disposition: e.disposition.id as DispositionId, note: note === '' ? undefined : note };
    });
}

export const nothingTyped = (lineIds: readonly string[], entries: Readonly<Record<string, Entry>>): boolean => confirmItems(lineIds, entries).length === 0;

export function confirmedMessage(stockAdded: number): string {
  if (stockAdded <= 0) return 'Confirmed. Nothing was added to stock.';
  return `Confirmed. ${String(stockAdded)} ${stockAdded === 1 ? 'unit' : 'units'} added to stock.`;
}
