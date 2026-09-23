import { getMyAccessAction, listPoliciesAction } from '@/server/domains/access-control/actions';
import {
  AdminPoliciesClient,
  type PoliciesSetup,
} from '@/components/admin/users/AdminPoliciesClient';

export const metadata = {
  title: 'Access Policies',
};

export default function Page() {
  const setupPromise: Promise<PoliciesSetup> = Promise.all([
    listPoliciesAction(),
    getMyAccessAction(),
  ]).then(([policies, access]) => ({ policies, access }));

  return <AdminPoliciesClient setupPromise={setupPromise} />;
}