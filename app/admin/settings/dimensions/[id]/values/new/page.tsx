import { notFound } from 'next/navigation';
import { getDimensionAction } from '@/server/domains/dimensions/actions';
import { DimensionValueCreateModal } from '@/components/admin/DimensionValueCreateModal';

export default async function DimensionValueCreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ field?: string }>;
}) {
  const { id } = await params;
  const { field } = await searchParams;
  const dimension = await getDimensionAction(id);
  if (!dimension) notFound();
  return (
    <DimensionValueCreateModal
      presentation="page"
      dimensionId={dimension.id}
      dimensionCode={dimension.code}
      fieldName={field ?? ''}
    />
  );
}
