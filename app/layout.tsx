import type { Metadata } from 'next';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { CompanyUiConfigProvider } from '@/components/company/CompanyUiConfigProvider';
import { companyHtmlStyle } from '@/components/company/companyHtmlStyle';
import { resolveCompanyUiConfig } from '@/config/company-ui';
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

export default async function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  let themeStyle = companyHtmlStyle('#111827', '#4F46E5');
  let uiConfig = resolveCompanyUiConfig(null);

  try {
    const company = await getCompanySettingsAction();
    themeStyle = companyHtmlStyle(company.primaryColor, company.accentColor);
    uiConfig = resolveCompanyUiConfig(company.uiConfig);
  } catch {
    // Fault-tolerant: missing DB / seed failure must not blank the app.
  }

  return (
    <html lang="en" style={themeStyle}>
      <body className="min-h-screen bg-black font-sans text-zinc-300 antialiased">
        <CompanyUiConfigProvider value={uiConfig}>
          {children}
          {modal}
        </CompanyUiConfigProvider>
      </body>
    </html>
  );
}
