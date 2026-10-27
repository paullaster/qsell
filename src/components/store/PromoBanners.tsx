import Link from 'next/link';
import { Megaphone } from 'lucide-react';
import { storefrontSeo } from '@/server/domains/storefront/seo';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { activeBanners } from '@/config/company-ui';

const buttonClass = 'inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500';

/** The banner's button: a link within the shop, or out to another site (opened in a new tab). Nothing when there is nowhere to go. */
function BannerButton({ href, label }: { href: string; label: string }) {
  if (href === '') return null;
  if (href.startsWith('/')) return <Link href={href} className={buttonClass}>{label}</Link>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClass}>{label}</a>;
}

/** The notices the company switched on for today, across the top of the front page. Nothing at all when there are none. */
export async function PromoBanners() {
  const { ui } = await storefrontSeo();
  const { banners } = ui;
  const shown = activeBanners(banners, businessDate());
  if (shown.length === 0) return null;
  return (
    <section aria-label="Notices" className="mb-4 space-y-2">
      {shown.map((banner) => (
        <div key={banner.id} className="flex flex-col gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-indigo-500" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-base font-semibold text-fg-strong">{banner.title}</p>
              {banner.text === '' ? null : <p className="text-sm text-fg">{banner.text}</p>}
            </div>
          </div>
          <BannerButton href={banner.href} label={banner.cta} />
        </div>
      ))}
    </section>
  );
}
