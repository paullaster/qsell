import { getMyAccessAction, listRolesAction } from '@/server/domains/access-control/actions';
import {
  AdminRolesClient,
  type RolesSetup,
} from '@/components/admin/users/AdminRolesClient';

export const metadata = {
  title: 'Roles & Permissions',
};

export default function Page() {
  const setupPromise: Promise<RolesSetup> = Promise.all([
    listRolesAction(),
    getMyAccessAction(),
  ]).then(([roles, access]) => ({ roles, access }));

  return <AdminRolesClient setupPromise={setupPromise} />;
}