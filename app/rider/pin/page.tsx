import type { Metadata } from 'next';
import { auth } from '@/auth';
import { RiderPinScreen } from '@/components/rider/RiderPinScreen';

export const metadata: Metadata = { title: 'Choose your PIN' };

export default async function RiderPinPage() {
  // Whether this is the first PIN (the office gave a temporary one) changes the words, so the session is read here.
  const session = await auth();
  return <RiderPinScreen first={session?.user.mustChangePin === true} />;
}
