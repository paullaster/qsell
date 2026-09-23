import {
  getMyAccessAction,
  listAccessBranchesAction,
  listRolesAction,
} from '@/server/domains/access-control/actions';
import { listUsersAction } from '@/server/domains/users/actions';
import {
  AdminUsersClient,
  type UsersSetup,
} from '@/components/admin/users/AdminUsersClient';

export const metadata = {
  title: 'Users & Access',
};

export default function Page() {
  const setupPromise: Promise<UsersSetup> = Promise.all([
    listUsersAction(),
    getMyAccessAction(),
    listRolesAction(),
    listAccessBranchesAction(),
  ]).then(([initial, access, roles, branches]) => ({
    initial,
    access,
    roles: roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      priority: role.priority,
      isSystem: role.isSystem,
      isActive: role.isActive,
    })),
    branches,
  }));

  return <AdminUsersClient setupPromise={setupPromise} />;
}