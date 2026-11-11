import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { RiderSignIn } from '@/components/rider/RiderSignIn';

export const metadata: Metadata = { title: 'Sign in' };

export default async function RiderSignInPage() {
  // Someone already signed in goes on to their runs (or to choosing their PIN); only the session can say, so this one wait is needed.
  const session = await auth();
  if (session?.user !== undefined) redirect(session.user.mustChangePin ? '/rider/pin' : '/rider');
  return <RiderSignIn />;
}
