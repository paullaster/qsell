import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import type { CsvMapping } from '@/server/domains/finance/domain/bank-statement';
import { MAX_STATEMENT_BYTES, type StatementFormat } from '@/server/domains/finance/receivables/bank-statement-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file`, `mode` (inspect | preview | import), `bankAccountId`,
 * `format` (csv | mt940), `mapping` (JSON), `headerRow`, `saveFormat`.
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
  const mode = String(form.get('mode') ?? '');
  const bankAccountId = String(form.get('bankAccountId') ?? '');
  if (!(file instanceof File) || !['inspect', 'preview', 'import'].includes(mode) || !bankAccountId) {
    return NextResponse.json({ ok: false, error: 'Choose a file and a bank account.' }, { status: 400 });
  }
  const format: StatementFormat = form.get('format') === 'mt940' ? 'mt940' : 'csv';
  let mapping: CsvMapping | undefined;
  try {
    const raw = form.get('mapping');
    if (typeof raw === 'string' && raw) mapping = JSON.parse(raw) as CsvMapping;
  } catch {
    return NextResponse.json({ ok: false, error: 'The column choices could not be read.' }, { status: 400 });
  }
  const headerRow = Math.max(1, Number(form.get('headerRow') ?? 1) || 1);
  const text = await file.text();

  const result = await run(
    'bank_statements:import',
    { surface: 'finance/bank-statements/account', action: `statement_${mode}` },
    async (ctx) => {
      const svc = getContainer().finance.bankStatements;
      if (mode === 'inspect') return { kind: 'inspect' as const, ...svc.inspect(text, headerRow), mt940: /^:20:|\n:61:/.test(text) };
      if (mode === 'preview') return { kind: 'preview' as const, ...(await svc.preview(ctx.companyId, { bankAccountId, text, format, mapping })) };
      const done = await svc.import(ctx, { bankAccountId, fileName: file.name, text, format, mapping, saveFormat: form.get('saveFormat') === '1' });
      return { kind: 'import' as const, ...done };
    },
    mode === 'import' ? ['/admin/finance/bank-statements', `/admin/finance/bank-statements/${bankAccountId}`] : [],
  );
  if (!result.ok) return NextResponse.json(result, { status: result.forbidden ? 403 : 400 });
  return NextResponse.json(result);
}
