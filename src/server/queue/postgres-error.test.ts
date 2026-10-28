import { describe, expect, it } from 'vitest';
import { postgresErrorSummary } from './postgres-error';

describe('postgresErrorSummary', () => {
  it('extracts SQLSTATE and safe database identifiers from Drizzle causes', () => {
    expect(
      postgresErrorSummary({
        message: 'Failed query',
        cause: {
          code: '23503',
          severity: 'ERROR',
          schema_name: 'public',
          table_name: 'product_import_rows',
          constraint_name: 'product_import_rows_job_id_fk',
        },
      }),
    ).toBe(
      'SQLSTATE=23503 severity=ERROR schema=public table=product_import_rows constraint=product_import_rows_job_id_fk',
    );
  });

  it('does not copy raw database messages or values into logs', () => {
    expect(
      postgresErrorSummary({
        cause: { code: '23505', message: 'duplicate key value contains private record data' },
      }),
    ).toBe('SQLSTATE=23505');
  });

  it('handles errors without a PostgreSQL cause', () => {
    expect(postgresErrorSummary(new Error('connection failed'))).toBe(
      'PostgreSQL supplied no structured error fields.',
    );
  });

  it('does not label Node error codes as PostgreSQL SQLSTATEs', () => {
    expect(postgresErrorSummary({ code: 'ERR_INVALID_ARG_TYPE' })).toBe(
      'code=ERR_INVALID_ARG_TYPE',
    );
  });
});
