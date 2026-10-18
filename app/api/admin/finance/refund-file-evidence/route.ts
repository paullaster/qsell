import { evidenceUpload } from '@/server/domains/finance/evidence-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Needs `refund_files:upload_evidence`: the bank's confirmation of a payment file. */
export const POST = evidenceUpload({
  permission: 'refund_files:upload_evidence',
  idField: 'fileId',
  noun: 'a payment file',
  surface: 'finance/refunds/files/detail',
  attach: async (finance, ctx, id, file) => await finance.refundFiles.attach(ctx, id, file),
  path: (id) => `/admin/finance/refunds/files/${id}`,
});
