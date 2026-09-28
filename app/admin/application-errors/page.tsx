import { AdminApplicationErrors } from '@/components/admin/AdminApplicationErrors';
import { listApplicationErrorsAction } from '@/server/domains/application-errors/actions';
import { canPermission } from '@/server/domains/access-control/guard';

export default async function ApplicationErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string }>;
}) {
  const params = await searchParams;
  if (!(await canPermission('settings:manage'))) {
    return (
      <main className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        You need settings management access to view application error logs.
      </main>
    );
  }
  const requestedPage = Number(params.page ?? '1');
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
  const search = params.search ?? '';
  const errorsPromise = listApplicationErrorsAction({ page, pageSize: 25, search });
  return <AdminApplicationErrors errorsPromise={errorsPromise} search={search} />;
}
