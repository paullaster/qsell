import type { Metadata } from 'next';
import { storefrontSeo } from '@/server/domains/storefront/seo';
import { HelpPage } from '@/components/store/help/HelpPage';
import { pageSocial } from '@/lib/seo/social';
import { helpView } from '@/lib/seo/help';
import { faqJsonLd } from '@/lib/seo/jsonld';
import { absoluteUrl, breadcrumbJsonLd, jsonLdText } from '@/lib/product-seo';

export async function generateMetadata(): Promise<Metadata> {
  const { company, ui, base } = await storefrontSeo();
  const view = helpView(company, ui.support);
  return {
    title: view.title,
    description: view.description,
    alternates: { canonical: '/help' },
    ...pageSocial({ title: `${view.title} | ${company.tradingName}`, description: view.description, url: absoluteUrl(base, '/help'), siteName: company.tradingName }),
  };
}

export default async function Help() {
  const { company, ui, base } = await storefrontSeo();
  const view = helpView(company, ui.support);
  const faq = faqJsonLd(view.faqs);
  const page = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: view.title,
    url: absoluteUrl(base, '/help'),
    isPartOf: { '@id': `${base.replace(/\/+$/, '')}/#website` },
    about: { '@id': `${base.replace(/\/+$/, '')}/#organization` },
  };
  const trail = breadcrumbJsonLd([{ name: 'Shop', url: absoluteUrl(base, '/') }, { name: ui.support.name, url: absoluteUrl(base, '/help') }]);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(page) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(trail) }} />
      {faq === null ? null : <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(faq) }} />}
      <HelpPage view={view} />
    </>
  );
}
