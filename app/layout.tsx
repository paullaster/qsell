import type { Metadata } from 'next';
import { siteVerification, storefrontSeo } from '@/server/domains/storefront/seo';
import { countryCode } from '@/lib/seo/jsonld';
import { homeDescription, homeKeywords, homeTitle } from '@/lib/seo/text';
import { shareImageUrl } from '@/lib/seo/share';
import { getThemeModeAction } from '@/server/domains/theme/actions';
import { CompanyUiConfigProvider } from '@/components/company/CompanyUiConfigProvider';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { companyHtmlStyle } from '@/components/company/companyHtmlStyle';
import { resolveCompanyUiConfig } from '@/config/company-ui';
import { resolveThemeForServer, themeBootstrapScript, type ThemeMode } from '@/config/theme';
import { resolveCompanyLogoUrl } from '@/lib/companyLogo';
import './globals.css';

// Company settings, user theme, catalog, and admin data are read from the live
// database. Render routes at request time so Docker/CI image builds do not need
// production database access or capture database-backed output in the image.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  try {
    const { company, ui, base } = await storefrontSeo();
    const title = homeTitle(company);
    const description = homeDescription(company, { guarantee: ui.support.guarantees[0]?.text });
    const logoUrl = resolveCompanyLogoUrl(company.logoUrl);
    const logoCard = logoUrl === null ? null : shareImageUrl(base, logoUrl);
    return {
      metadataBase: new URL(base),
      title: { default: title, template: `%s | ${company.tradingName}` },
      description,
      applicationName: company.tradingName,
      keywords: homeKeywords(company),
      authors: [{ name: company.legalName }],
      creator: company.legalName,
      publisher: company.legalName,
      icons: logoUrl === null ? undefined : [{ url: logoUrl }],
      openGraph: {
        type: 'website',
        siteName: company.tradingName,
        locale: 'en_KE',
        title,
        description,
        url: base,
        ...(logoCard === null ? {} : { images: [{ url: logoCard, alt: `${company.tradingName} logo` }] }),
      },
      twitter: { card: logoCard === null ? 'summary' : 'summary_large_image', title, description, ...(logoCard === null ? {} : { images: [logoCard] }) },
      robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 } },
      verification: siteVerification(),
      other: { 'geo.region': countryCode(company.country), 'geo.placename': company.city },
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
  let themeMode: ThemeMode = 'light';

  try {
    const { company, ui } = await storefrontSeo();
    themeStyle = companyHtmlStyle(company.primaryColor, company.accentColor);
    uiConfig = ui;
  } catch {
    // Fault-tolerant: missing DB / seed failure must not blank the app.
  }

  try {
    themeMode = await getThemeModeAction();
  } catch {
    themeMode = 'light';
  }

  // Best server-side guess only: an explicit "dark" cookie is honoured, but
  // "system" is unknowable without the client media query and falls back to
  // light. The bootstrap script below corrects it before the first paint.
  const serverTheme = resolveThemeForServer(themeMode);

  return (
    <html lang="en-KE" style={themeStyle} data-theme={serverTheme} data-theme-mode={themeMode}>
      <body className="min-h-screen bg-canvas font-sans text-fg antialiased">
        {/*
          First node in <body> on purpose: the parser runs it before any visible
          content is rendered, so a "system" choice is applied without a flash,
          without a manual <head> tag and without a blocking network request.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
        <ThemeProvider initialMode={themeMode}>
          <CompanyUiConfigProvider value={uiConfig}>
            {children}
            {modal}
          </CompanyUiConfigProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
