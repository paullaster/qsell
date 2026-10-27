import { PLATFORM_MODULES, PLATFORM_NAME, platformKeywords, type PlatformModuleSeo } from '@/config/seo/platform-modules';
import { has } from '@/lib/values';
import { clip, placeOf, type SeoCompany } from './text';

export interface PlatformView {
  title: string;
  description: string;
  heading: string;
  intro: string;
  keywords: string[];
  modules: readonly PlatformModuleSeo[];
}

/** The public page about the software behind the shop, made from the module registry and the shop's own name and town. */
export function platformView(company: SeoCompany): PlatformView {
  return {
    title: `${PLATFORM_NAME}: ecommerce, point of sale, inventory and accounting software`,
    description: clip(`${PLATFORM_NAME} is business management software for Kenya: online shop, point of sale, stock control, suppliers, invoicing and M-Pesa payments in one system.`, 160),
    heading: `${PLATFORM_NAME}: one system to sell, stock, buy and account`,
    intro: `${company.tradingName}${has(placeOf(company)) ? ` in ${placeOf(company)}` : ''} runs on ${PLATFORM_NAME}, business management software that joins the online shop, the point of sale, stock control, suppliers, invoicing and payments, so every sale and every shilling is recorded once.`,
    keywords: platformKeywords(),
    modules: PLATFORM_MODULES,
  };
}

export function softwareJsonLd(view: PlatformView, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: PLATFORM_NAME,
    url,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: view.description,
    inLanguage: 'en-KE',
    keywords: view.keywords.join(', '),
    featureList: view.modules.flatMap((module) => module.features),
  };
}
