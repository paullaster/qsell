import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  BookOpen,
  Download,
  Clock,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  FileText,
  CheckCircle2,
} from 'lucide-react';
import { getAllChapters, getChapterBySlug, getVersionManifest } from '@/generated/docs';
import { DocsToc } from '@/components/admin/docs/DocsToc';

interface ChapterPageProps {
  readonly params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getAllChapters().map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: ChapterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const chapter = getChapterBySlug(slug);

  if (!chapter) {
    return { title: 'Chapter Not Found | OmniCommerce Documentation' };
  }

  const prefix = chapter.chapterNumber !== null ? `Ch. ${chapter.chapterNumber}: ` : '';
  return {
    title: `${prefix}${chapter.title} | Implementor Guide | OmniCommerce`,
    description: chapter.summary,
  };
}

export default async function ChapterPage({ params }: ChapterPageProps) {
  const { slug } = await params;
  const chapter = getChapterBySlug(slug);

  if (!chapter) {
    notFound();
  }

  const chapters = getAllChapters();
  const version = getVersionManifest();

  // Find previous and next chapters for pagination
  const currentIndex = chapters.findIndex((c) => c.slug === slug);
  const prevChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;
  const nextChapter = currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null;

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Link
            href="/admin/docs"
            className="inline-flex items-center gap-1 font-medium text-fg-muted transition-colors hover:text-indigo-600"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Manuals
          </Link>
          <span className="text-fg-faint">/</span>
          <span className="text-fg-subtle">{chapter.category}</span>
          <span className="text-fg-faint">/</span>
          <span className="truncate font-semibold text-fg-strong">
            {chapter.chapterNumber !== null ? `Ch. ${chapter.chapterNumber}` : 'Roadmap'}
          </span>
        </div>

        {/* Version Badge & Download Link */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-sunken px-2 py-0.5 font-mono text-[11px] text-fg-subtle">
            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
            {version.versionTag}
          </span>

          <a
            href={version.pdfUrl}
            download={version.pdfFilename}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong"
            title="Download immutable PDF manual"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Download Master PDF</span>
          </a>
        </div>
      </div>

      {/* Main 3-Column Layout: Left Nav, Center Document, Right TOC */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left Navigation: Chapter List (Desktop) */}
        <aside className="hidden lg:col-span-3 lg:block" aria-label="Chapters navigation">
          <div className="sticky top-24 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-fg-subtle uppercase">
              <BookOpen className="h-4 w-4" />
              <span>All {chapters.length} Chapters</span>
            </div>

            <nav className="max-h-[calc(100vh-12rem)] space-y-1 overflow-y-auto pr-2 text-xs">
              {chapters.map((c) => {
                const isCurrent = c.slug === slug;
                return (
                  <Link
                    key={c.slug}
                    href={`/admin/docs/${c.slug}`}
                    className={`flex items-start gap-2.5 rounded-lg p-2 transition-colors ${
                      isCurrent
                        ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
                        : 'text-fg-muted hover:bg-hover hover:text-fg-strong'
                    }`}
                  >
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        isCurrent
                          ? 'bg-indigo-600 text-white'
                          : 'border border-line bg-surface-sunken text-fg-subtle'
                      }`}
                    >
                      {c.chapterNumber !== null
                        ? c.chapterNumber.toString().padStart(2, '0')
                        : '00'}
                    </span>
                    <span className="truncate">{c.title}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Center: Pre-Rendered Document Content */}
        <main className="min-w-0 space-y-6 lg:col-span-7" id="main-doc-content">
          <header className="space-y-3 border-b border-line pb-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 dark:border-indigo-900/40 dark:bg-indigo-950/60 dark:text-indigo-300">
                {chapter.category}
              </span>
              <span className="flex items-center gap-1 text-xs text-fg-subtle">
                <Clock className="h-3.5 w-3.5" />~{chapter.readingTimeMinutes} min read (
                {chapter.wordCount.toLocaleString()} words)
              </span>
            </div>

            <h1 className="text-2xl font-extrabold tracking-tight text-fg-strong sm:text-3xl">
              {chapter.title}
            </h1>

            <p className="text-sm leading-relaxed text-fg-muted italic">{chapter.summary}</p>
          </header>

          {/* Pre-Rendered HTML content directly streamed without runtime parsing */}
          <article
            className="doc-content leading-relaxed text-fg"
            dangerouslySetInnerHTML={{ __html: chapter.htmlContent }}
          />

          {/* Pagination: Previous & Next Chapter */}
          <footer className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-line pt-6 sm:flex-row">
            {prevChapter ? (
              <Link
                href={`/admin/docs/${prevChapter.slug}`}
                className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface p-4 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong sm:w-auto"
              >
                <ChevronLeft className="h-4 w-4 shrink-0" />
                <div>
                  <div className="text-[10px] text-fg-subtle uppercase">Previous Chapter</div>
                  <div className="max-w-[200px] truncate font-semibold text-fg-strong">
                    {prevChapter.title}
                  </div>
                </div>
              </Link>
            ) : (
              <div />
            )}

            {nextChapter ? (
              <Link
                href={`/admin/docs/${nextChapter.slug}`}
                className="ml-auto flex w-full items-center justify-end gap-2 rounded-xl border border-line bg-surface p-4 text-right text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong sm:w-auto"
              >
                <div>
                  <div className="text-[10px] text-fg-subtle uppercase">Next Chapter</div>
                  <div className="max-w-[200px] truncate font-semibold text-fg-strong">
                    {nextChapter.title}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0" />
              </Link>
            ) : (
              <div />
            )}
          </footer>
        </main>

        {/* Right Sidebar: Table of Contents (Desktop) */}
        <aside className="hidden lg:col-span-2 lg:block" aria-label="Page outline">
          <div className="sticky top-24 space-y-4">
            <DocsToc items={chapter.toc} />

            <div className="space-y-2 rounded-xl border border-line bg-surface p-3 text-xs shadow-2xs">
              <div className="flex items-center gap-1.5 font-semibold text-fg-strong">
                <FileText className="h-3.5 w-3.5 text-indigo-600" />
                Offline Field Sales
              </div>
              <p className="text-[11px] leading-relaxed text-fg-muted">
                Download the complete master PDF stamped with version{' '}
                <span className="font-mono">{version.versionTag}</span> for offline sales pitches.
              </p>
              <a
                href={version.pdfUrl}
                download={version.pdfFilename}
                className="block rounded-lg bg-indigo-600 px-2 py-1.5 text-center text-[11px] font-semibold text-white transition-colors hover:bg-indigo-700"
              >
                Download PDF
              </a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
