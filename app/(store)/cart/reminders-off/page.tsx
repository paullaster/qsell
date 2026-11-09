import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CartRemindersOff } from '@/components/store/CartRemindersOff';
import { isReminderToken } from '@/lib/shop-cart';

export const metadata: Metadata = { title: 'Stop cart reminders', robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  if (!isReminderToken(token)) notFound();
  return <CartRemindersOff token={token} />;
}
