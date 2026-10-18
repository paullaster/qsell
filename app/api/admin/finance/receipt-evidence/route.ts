import { evidenceUpload } from '@/server/domains/finance/evidence-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Needs `receipts:attach_evidence`. */
export const POST = evidenceUpload({
  permission: 'receipts:attach_evidence',
  idField: 'receiptId',
  noun: 'a receipt',
  surface: 'finance/receipts/detail',
  attach: async (finance, ctx, id, file) => await finance.receipts.attach(ctx, id, file),
  path: (id) => `/admin/finance/receipts/${id}`,
});
