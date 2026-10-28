import { asRecord, readText } from '@/lib/values';

/** Safe fields from a postgres-js error cause; never logs SQL parameters or row values. */
export function postgresErrorSummary(error: unknown): string {
  const outer = asRecord(error);
  const cause = asRecord(outer.cause);
  const errorCode = readText(cause.code, outer.code);
  const codeLabel = /^[0-9A-Z]{5}$/.test(errorCode) ? 'SQLSTATE' : 'code';
  const fields = [
    [codeLabel, errorCode],
    ['severity', readText(cause.severity, outer.severity)],
    ['schema', readText(cause.schema_name, outer.schema_name)],
    ['table', readText(cause.table_name, outer.table_name)],
    ['column', readText(cause.column_name, outer.column_name)],
    ['constraint', readText(cause.constraint_name, outer.constraint_name)],
    ['routine', readText(cause.routine, outer.routine)],
  ] as const;

  const summary = fields.flatMap(([name, value]) => (value === '' ? [] : [`${name}=${value}`]));
  return summary.length === 0
    ? 'PostgreSQL supplied no structured error fields.'
    : summary.join(' ');
}
