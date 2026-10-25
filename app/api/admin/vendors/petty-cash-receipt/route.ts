import { getContainer } from '@/server/di/container';
import { evidenceUpload } from '@/server/domains/finance/evidence-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A photo of the receipt for a petty cash voucher. Needs `petty_cash:create`. */
export const POST = evidenceUpload({
  permission: 'petty_cash:create',
  idField: 'voucherId',
  noun: 'a petty cash voucher',
  surface: 'petty_cash/voucher',
  attach: async (_finance, ctx, id, file) => await getContainer().pettyCash.attach(ctx, id, file),
  path: (id) => `/admin/vendors/petty-cash/vouchers/${id}`,
});
