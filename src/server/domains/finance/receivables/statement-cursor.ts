const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StatementCursor {
  date: string | null;
  id: string;
}

export const STATEMENT_PAGE_SIZE = 100;

export function isStatementId(value: string): boolean {
  return UUID.test(value);
}

export function statementFilterDate(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const text = value.trim();
  if (!DATE.test(text)) throw new Error('That statement date is not valid.');
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text)
    throw new Error('That statement date is not valid.');
  return text;
}

export function encodeStatementCursor(cursor: StatementCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeStatementCursor(value: string | undefined | null): StatementCursor | null {
  if (value === undefined || value === null || value === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('That statement page could not be read.');
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('That statement page could not be read.');
  const record = parsed as Record<string, unknown>;
  const date = record.date;
  const id = record.id;
  if (date !== null && typeof date !== 'string')
    throw new Error('That statement page could not be read.');
  if (typeof id !== 'string' || !UUID.test(id))
    throw new Error('That statement page could not be read.');
  return { date: date === null ? null : statementFilterDate(date), id };
}
