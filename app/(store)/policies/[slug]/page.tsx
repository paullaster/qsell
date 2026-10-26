import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCompanyUiConfigAction } from '@/server/domains/company/actions';
import { parsePolicyBody, policyAddress } from '@/config/company-ui';
import { metaDescription } from '@/lib/product-seo';

interface Props {
  params: Promise<{ slug: string }>;
}

async function policyFor(slug: string) {
  const { policies } = await getCompanyUiConfigAction();
  return { page: policies.find((item) => item.slug === slug) ?? null, policies };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { page } = await policyFor((await params).slug);
  if (page === null) return { title: 'Page not found', robots: { index: false } };
  const first = parsePolicyBody(page.body).find((block) => block.kind === 'paragraph');
  return { title: page.title, description: metaDescription(first?.kind === 'paragraph' ? first.text : page.title), alternates: { canonical: policyAddress(page) } };
}

/** A policy page the company wrote (privacy, delivery, returns...). Its text is drawn as text, never as markup. */
export default async function PolicyPage({ params }: Props) {
  const { page, policies } = await policyFor((await params).slug);
  if (page === null) notFound();
  const blocks = parsePolicyBody(page.body);
  return (
    <div className="mx-auto grid max-w-5xl gap-8 pb-16 md:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Policies" className="md:sticky md:top-24 md:self-start">
        <ul className="space-y-1">
          {policies.map((item) => (
            <li key={item.id}>
              <Link href={policyAddress(item)} aria-current={item.id === page.id ? 'page' : undefined} className={`flex min-h-11 items-center rounded-lg px-3 text-sm ${item.id === page.id ? 'bg-indigo-600 font-semibold text-white' : 'text-fg hover:bg-hover'}`}>
                {item.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight text-fg-strong">{page.title}</h1>
        {blocks.map((block, index) => {
          const key = `${block.kind}-${String(index)}`;
          if (block.kind === 'heading') return <h2 key={key} className="pt-2 text-xl font-bold text-fg-strong">{block.text}</h2>;
          if (block.kind === 'list') {
            return (
              <ul key={key} className="list-disc space-y-1 ps-6 text-base text-fg">
                {block.items.map((item, i) => <li key={`${key}-${String(i)}`}>{item}</li>)}
              </ul>
            );
          }
          return <p key={key} className="text-base leading-relaxed text-fg">{block.text}</p>;
        })}
      </article>
    </div>
  );
}
