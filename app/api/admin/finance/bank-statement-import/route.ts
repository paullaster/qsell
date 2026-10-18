import { NextResponse } from 'next/server';
import { has } from '@/lib/values';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import type { CsvMapping } from '@/server/domains/finance/domain/bank-statement';
import { MAX_STATEMENT_BYTES } from '@/server/domains/finance/receivables/bank-statement-service';
import { FILE_WORDS, StatementFileError, readStatementFile } from '@/server/domains/finance/domain/statement-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file`, `mode` (inspect | preview | import), `bankAccountId`,
 * `mapping` (JSON), `headerRow`, `saveFormat`. The file may be CSV, Excel (.xlsx), MT940 or camt.053 XML; which it is is read from the file.
 * A route handler rather than a server action because a statement can be several megabytes.
 * Needs `bank_statements:import`. The file is read as text, fingerprinted and parsed here; the
 * lines are kept, the file itself is not stored.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_STATEMENT_BYTES + ENVELOPE_BYTES) {
    return NextResponse.json({ ok: false, error: 'That file is larger than 10 MB. Split it by month.' }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Send the file as multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  const field = (name: string): string => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const mode = field('mode');
  const bankAccountId = field('bankAccountId');
  if (!(file instanceof File) || !['inspect', 'preview', 'import'].includes(mode) || !has(bankAccountId)) {
    return NextResponse.json({ ok: false, error: 'Choose a file and a bank account.' }, { status: 400 });
  }
  let mapping: CsvMapping | undefined;
  try {
    const raw = field('mapping');
    if (has(raw)) mapping = JSON.parse(raw) as CsvMapping;
  } catch {
    return NextResponse.json({ ok: false, error: 'The column choices could not be read.' }, { status: 400 });
  }
  const asked = Number(field('headerRow'));
  const headerRow = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1;
  let read: ReturnType<typeof readStatementFile>;
  try {
    read = readStatementFile(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof StatementFileError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    throw error;
  }
  // What the file is, is read from the file; the browser's word for it is not trusted.
  const { text, format } = read;

  const result = await run(
    'bank_statements:import',
    { surface: 'finance/bank-statements/account', action: `statement_${mode}` },
    async (ctx) => {
      const svc = getContainer().finance.bankStatements;
      if (mode === 'inspect') return { kind: 'inspect' as const, ...svc.inspect(text, headerRow), mt940: format === 'mt940', fixed: format !== 'csv', fileFormat: format, source: FILE_WORDS[read.from] };
      if (mode === 'preview') return { kind: 'preview' as const, ...(await svc.preview(ctx.companyId, { bankAccountId, text, format, mapping })) };
      const done = await svc.import(ctx, { bankAccountId, fileName: file.name, text, format, mapping, saveFormat: field('saveFormat') === '1' });
      return { kind: 'import' as const, ...done };
    },
    mode === 'import' ? ['/admin/finance/bank-statements', `/admin/finance/bank-statements/${bankAccountId}`] : [],
  );
  if (!result.ok) return NextResponse.json(result, { status: result.forbidden ? 403 : 400 });
  return NextResponse.json(result);
}
