import type { Metadata } from 'next';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  try {
    const company = await getCompanySettingsAction();
    const title = company.tagline
      ? `${company.tradingName} — ${company.tagline}`
      : company.tradingName;
    return {
      title,
      description: `${company.legalName} storefront and commerce console`,
      icons: company.logoUrl ? [{ url: company.logoUrl }] : undefined,
    };
  } catch {
    return {
      title: 'Storefront',
      description: 'Commerce storefront',
    };
  }
}

export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-black font-sans text-zinc-300 antialiased">
        {children}
        {modal}
      </body>
    </html>
  );
}
