import { describe, expect, it } from 'vitest';
import { MAX_STATEMENT_FILE_BYTES, StatementFileError, readStatementFile } from './statement-file';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('telling what a statement file is', () => {
  it('recognises a camt.053 statement, an MT940 file and a CSV by what is in them, not their names', () => {
    expect(readStatementFile(bytes('<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt/></Document>')).format).toBe('camt053');
    expect(readStatementFile(bytes(':20:STMT\n:25:123\n:61:2610130113C500,00NTRFREF\n:86:Payment')).format).toBe('mt940');
    const csv = readStatementFile(bytes('﻿Date,Amount\n2026-10-13,500'));
    expect(csv).toMatchObject({ format: 'csv', from: 'csv' });
    expect(csv.text.startsWith('Date')).toBe(true);
  });

  it('refuses nothing, too much, and a workbook that cannot be read', () => {
    expect(() => readStatementFile(new Uint8Array())).toThrow(StatementFileError);
    expect(() => readStatementFile(new Uint8Array(MAX_STATEMENT_FILE_BYTES + 1))).toThrow(/10 MB/);
    expect(() => readStatementFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]))).toThrow(StatementFileError);
  });
});
