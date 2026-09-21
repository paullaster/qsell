import { notFound } from 'next/navigation';
import {
  getDimensionAction,
  listDimensionValuesAction,
} from '@/server/domains/dimensions/actions';
import { AdminDimensionValuesClient } from '@/components/admin/settings/AdminDimensionValuesClient';

export default async function AdminDimensionValuesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const dimension = await getDimensionAction(id);
  if (!dimension) notFound();

  const parentValuesPromise = dimension.parentId
    ? listDimensionValuesAction(dimension.parentId)
    : Promise.resolve([]);

  return (
    <AdminDimensionValuesClient
      dimensionPromise={Promise.resolve(dimension)}
      valuesPromise={listDimensionValuesAction(id)}
      parentValuesPromise={parentValuesPromise}
    />
  );
}
