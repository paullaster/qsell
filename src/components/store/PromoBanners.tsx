import { storefrontSeo } from '@/server/domains/storefront/seo';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { activeBanners } from '@/config/company-ui';
import { BannerView } from './BannerView';

/** The notices the company switched on for today, across the top of the front page. Nothing at all when there are none. */
export async function PromoBanners() {
  const { ui } = await storefrontSeo();
  const { banners } = ui;
  const shown = activeBanners(banners, businessDate());
  if (shown.length === 0) return null;
  return (
    <section aria-label="Notices" className="mb-4 space-y-2">
      {shown.map((banner) => (
        <BannerView key={banner.id} banner={banner} />
      ))}
    </section>
  );
}
