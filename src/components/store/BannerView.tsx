import Link from 'next/link';
import { Megaphone } from 'lucide-react';
import type { PromoBanner } from '@/config/company-ui/types';
import { bannerLook } from '@/lib/banner-look';
import { BannerMarquee } from './BannerMarquee';

const defaultButton = 'bg-indigo-600 text-white hover:bg-indigo-500';
const buttonBase = 'inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-5 text-sm font-semibold hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current';

/** The banner's button: a link within the shop, or out to another site (opened in a new tab). Nothing when there is nowhere to go. */
function BannerButton({ href, label, custom, style }: { href: string; label: string; custom: boolean; style: React.CSSProperties }) {
  if (href === '') return null;
  const className = `${buttonBase} ${custom ? '' : defaultButton}`;
  if (href.startsWith('/')) return <Link href={href} className={className} style={style}>{label}</Link>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className} style={style}>{label}</a>;
}

/** The words of one banner (picture, headline, line under it), the same whether still or scrolling. */
function Words({ banner, large }: { banner: PromoBanner; large: boolean }) {
  return (
    <>
      {banner.imageUrl === '' ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- the company's own picture, any size or host it chose
        <img src={banner.imageUrl} alt="" className={`${large ? 'h-16 sm:h-20' : 'h-10 sm:h-12'} w-auto max-w-[40%] shrink-0 rounded-md object-contain`} />
      )}
      <span className="min-w-0">
        <span className={`block font-semibold ${large ? 'text-xl sm:text-3xl' : 'text-base'} ${banner.background === '' ? 'text-fg-strong' : ''}`}>{banner.title}</span>
        {banner.text === '' ? null : <span className={`block ${large ? 'text-base sm:text-lg' : 'text-sm'}`}>{banner.text}</span>}
      </span>
    </>
  );
}

/** One banner as the shop shows it: the shop's own look unless the company chose colours, still, scrolling or pulsing. */
export function BannerView({ banner }: { banner: PromoBanner }) {
  const look = bannerLook(banner);
  const large = banner.size === 'large';
  const frame = look.custom
    ? 'border border-transparent'
    : 'border border-indigo-500/30 bg-indigo-500/10 text-fg';
  return (
    <div
      className={`rounded-xl ${large ? 'p-5 sm:p-7' : 'p-4'} ${frame} ${banner.motion === 'pulse' ? 'banner-pulse' : ''}`}
      style={look.style}
    >
      {banner.motion === 'marquee' ? <p className="sr-only">{banner.text === '' ? banner.title : `${banner.title}. ${banner.text}`}</p> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {banner.motion === 'marquee' ? (
          <BannerMarquee seconds={look.seconds}>
            <Words banner={banner} large={large} />
          </BannerMarquee>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            {banner.imageUrl === '' ? <Megaphone className={`${large ? 'h-7 w-7' : 'h-5 w-5'} shrink-0 ${look.custom ? '' : 'text-indigo-500'}`} aria-hidden="true" /> : null}
            <Words banner={banner} large={large} />
          </div>
        )}
        <BannerButton href={banner.href} label={banner.cta} custom={look.custom} style={look.buttonStyle} />
      </div>
    </div>
  );
}
