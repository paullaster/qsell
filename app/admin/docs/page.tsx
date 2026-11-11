import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  BookOpen,
  Download,
  Calendar,
  GitCommit,
  CheckCircle2,
  Clock,
  Layers,
  ShieldCheck,
  Building2,
  TrendingUp,
  Truck,
  ArrowRight,
} from 'lucide-react';
import { getVersionManifest, getAllChapters, getSearchIndex } from '@/generated/docs';
import { DocsSearch } from '@/components/admin/docs/DocsSearch';

export const metadata: Metadata = {
  title: 'Documentation | Qsell',
  description:
    'Comprehensive playbook for Qsell.',
};

const CATEGORY_GROUPS = [
  {
    title: 'Foundations & Commercial Roadmap',
    description:
      'System setup, master identity, sales onboarding curriculum, and the 7-stage rollout roadmap.',
    icon: Building2,
    categories: ['Foundations & Roadmap', 'Identity & Branding', 'Executive & Analytics'],
  },
  {
    title: 'Commercial Operations & Revenue Engines',
    description:
      'Quotes, order dispatching, wholesale margin protection, pricing matrices, and job costing.',
    icon: TrendingUp,
    categories: ['Commercial Operations'],
  },
  {
    title: 'Supply Chain, Logistics & Field Operations',
    description:
      'Multi-branch inventory control, catalog variants, route dispatch, proof of delivery, and procurement.',
    icon: Truck,
    categories: ['Supply Chain & Inventory', 'Supply Chain & Field', 'Supply Chain & Procurement'],
  },
  {
    title: 'Fiscal Compliance, Finance & Governance',
    description:
      'KRA eTIMS fiscalization, general ledger double-entry, role-based governance, and fraud prevention.',
    icon: ShieldCheck,
    categories: ['Governance & Security', 'Finance & Accounting', 'Fiscal & Administration'],
  },
  {
    title: 'External Ecosystem & Self-Service Portals',
    description:
      'Consumer storefront experience, field rider PWA dispatch, and vendor dropship consoles.',
    icon: Layers,
    categories: ['External Ecosystem'],
  },
];

export default function DocsIndexPage() {
  const version = getVersionManifest();
  const chapters = getAllChapters();
  const searchIndex = getSearchIndex();

  const formattedDate = new Date(version.buildDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const pdfSizeKb = Math.round(version.pdfSizeBytes / 1024);

  return (
    <div className="space-y-8">
      {/* Hero & Version Stamp Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-surface to-surface-raised p-6 shadow-xs sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl space-y-3">

            <h1 className="text-2xl font-extrabold tracking-tight text-fg-strong sm:text-3xl">
              QSell Manual
            </h1>

            <p className="text-sm leading-relaxed text-fg-muted sm:text-base">
              The go to Qsell documentation
            </p>

            {/* Immutability & Version Badges */}
            <div className="flex flex-wrap items-center gap-3 pt-2 text-xs text-fg-subtle">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2.5 py-1 font-mono font-medium text-fg-strong">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                {version.versionTag}
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2.5 py-1">
                <Calendar className="h-3.5 w-3.5 text-fg-muted" />
                Built {formattedDate}
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2.5 py-1 font-mono">
                <GitCommit className="h-3.5 w-3.5 text-fg-muted" />
                SHA: {version.gitSha}
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2.5 py-1">
                <BookOpen className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                {version.chaptersCount} Modules
              </span>
            </div>
          </div>

          {/* Action: Version-Tagged PDF Download Button */}
          <div className="flex shrink-0 flex-col items-stretch gap-3 sm:flex-row lg:flex-col">
            <a
              href={version.pdfUrl}
              download={version.pdfFilename}
              className="inline-flex items-center justify-center gap-2.5 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-none"
            >
              <Download className="h-4 w-4" />
              Download Master PDF Pack
              <span className="ml-1 rounded-md bg-indigo-500/50 px-2 py-0.5 font-mono text-xs font-medium">
                {pdfSizeKb} KB
              </span>
            </a>
          </div>
        </div>
      </div>

      {/* Instant Search Bar Island */}
      <section className="space-y-3" aria-labelledby="search-heading">
        <h2 id="search-heading" className="sr-only">
          Search Documentation
        </h2>
        <DocsSearch searchIndex={searchIndex} chapters={chapters} />
      </section>

      {/* Grouped Modules Grid */}
      <div className="space-y-10">
        {CATEGORY_GROUPS.map((group) => {
          const groupChapters = chapters.filter((c) => group.categories.includes(c.category));
          if (groupChapters.length === 0) return null;
          const GroupIcon = group.icon;

          return (
            <section key={group.title} className="space-y-4">
              <div className="flex items-start gap-3 border-b border-line pb-3">
                <div className="rounded-xl border border-line bg-surface-raised p-2 text-indigo-600 dark:text-indigo-400">
                  <GroupIcon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-fg-strong">{group.title}</h2>
                  <p className="text-xs text-fg-muted">{group.description}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {groupChapters.map((chapter) => (
                  <Link
                    key={chapter.slug}
                    href={`/admin/docs/${chapter.slug}`}
                    className="group flex flex-col justify-between rounded-xl border border-line bg-surface p-5 shadow-2xs transition hover:border-indigo-500/50 hover:bg-surface-raised hover:shadow-xs"
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center rounded-md border border-line bg-surface-sunken px-2 py-0.5 font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                          {chapter.chapterNumber !== null
                            ? `Chapter ${chapter.chapterNumber.toString().padStart(2, '0')}`
                            : 'Blueprint'}
                        </span>
                        <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
                          <Clock className="h-3 w-3" />~{chapter.readingTimeMinutes} min
                        </span>
                      </div>

                      <h3 className="text-base font-semibold text-fg-strong transition-colors group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                        {chapter.title}
                      </h3>

                      <p className="line-clamp-2 text-xs leading-relaxed text-fg-muted">
                        {chapter.summary}
                      </p>
                    </div>

                    <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                      <span>{chapter.toc.length} sections</span>
                      <span className="inline-flex items-center gap-1 transition-transform group-hover:translate-x-0.5">
                        Read Manual <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
