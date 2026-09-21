import {
  listDimensionsAction,
  listDimensionOptionStringsAction,
} from '@/server/domains/dimensions/actions';
import { AdminDimensionsClient } from '@/components/admin/settings/AdminDimensionsClient';

export default function AdminDimensionsPage() {
  return (
    <AdminDimensionsClient
      dimensionsPromise={listDimensionsAction()}
      optionsPromise={listDimensionOptionStringsAction()}
    />
  );
}
