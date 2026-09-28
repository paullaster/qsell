'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import {
  listApplicationErrors,
  recordApplicationError,
} from '@/server/observability/application-errors';

export async function listApplicationErrorsAction(
  input: {
    page?: number;
    pageSize?: number;
    search?: string;
  } = {},
) {
  await requirePermission('settings:manage');
  return listApplicationErrors(input);
}

export async function reportClientApplicationErrorAction(input: {
  errorName: string;
  message: string;
  stack?: string | null;
  digest?: string | null;
  path?: string | null;
}) {
  const { auth } = await import('@/auth');
  const session = await auth();
  const actorUserId = session?.user?.id;
  if (!actorUserId) return;
  await recordApplicationError({
    source: 'client-boundary',
    errorName: input.errorName,
    message: input.message,
    stack: input.stack,
    digest: input.digest,
    path: input.path,
    actorUserId,
  });
}
