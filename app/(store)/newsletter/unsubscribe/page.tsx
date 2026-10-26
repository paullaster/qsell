import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NewsletterConfirm } from '@/components/store/NewsletterConfirm';
import { isNewsletterToken } from '@/lib/newsletter';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  if (!isNewsletterToken(token)) notFound();
  return <NewsletterConfirm token={token} mode="unsubscribe" />;
}
