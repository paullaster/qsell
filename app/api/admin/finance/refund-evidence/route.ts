import { evidenceUpload } from '@/server/domains/finance/evidence-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Needs `refunds:upload_evidence`. */
export const POST = evidenceUpload({
  permission: 'refunds:upload_evidence',
  idField: 'refundId',
  noun: 'a refund',
  surface: 'finance/refunds/detail',
  attach: async (finance, ctx, id, file) => await finance.refunds.attach(ctx, id, file),
  path: (id) => `/admin/finance/refunds/${id}`,
});
