import { getSessionAction } from '@/server/domains/auth/actions';
import { StorefrontProfileClient } from '@/components/store/StorefrontProfileClient';

export default async function StorefrontProfilePage() {
  const sessionPromise = getSessionAction();
  
  return <StorefrontProfileClient sessionPromise={sessionPromise as any} />;
}
