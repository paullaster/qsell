'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, BookOpen, ChevronRight, X } from 'lucide-react';
import type { DocSearchEntry, DocChapter } from '@/lib/docs/types';

interface DocsSearchProps {
  readonly searchIndex: readonly DocSearchEntry[];
  readonly chapters: readonly DocChapter[];
}

export function DocsSearch({ searchIndex, chapters }: DocsSearchProps) {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of chapters) {
      if (c.category !== '') set.add(c.category);
    }
    return ['all', ...Array.from(set)];
  }, [chapters]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === '' && selectedCategory === 'all') return [];

    let filtered = searchIndex;
    if (selectedCategory !== 'all') {
      filtered = filtered.filter((item) => item.category === selectedCategory);
    }

    if (trimmed === '') {
      // Just category filtering
      return filtered.slice(0, 12);
    }

    const matches: { item: DocSearchEntry; score: number }[] = [];

    for (const item of filtered) {
      const headingMatch = item.sectionHeading.toLowerCase().includes(trimmed);
      const titleMatch = item.title.toLowerCase().includes(trimmed);
      const snippetMatch = item.snippet.toLowerCase().includes(trimmed);

      if (headingMatch || titleMatch || snippetMatch) {
        let score = 0;
        if (headingMatch) score += 10;
        if (titleMatch) score += 5;
        if (snippetMatch) score += 2;
        matches.push({ item, score });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 15).map((m) => m.item);
  }, [query, selectedCategory, searchIndex]);

  return (
    <div className="w-full space-y-4">
      {/* Search Input & Category Filters */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-fg-muted">
          <Search className="h-4 w-4" />
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search all ${chapters.length} manuals by keyword (e.g. 'eTIMS', 'wholesale tier', 'cash reconciliation', 'commission')...`}
          className="w-full rounded-xl border border-line bg-surface py-2.5 pr-10 pl-10 text-sm text-fg shadow-xs placeholder:text-fg-faint focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
        />
        {query !== '' && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-fg-muted hover:text-fg-strong"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Category Filter Pills */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 font-medium text-fg-subtle">Filter Domain:</span>
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`rounded-lg px-2.5 py-1 capitalize transition-colors ${
              selectedCategory === cat
                ? 'bg-indigo-600 font-semibold text-white'
                : 'border border-line bg-surface text-fg-muted hover:bg-hover hover:text-fg-strong'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Search Results Dropdown/Box */}
      {query.trim() !== '' && (
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-md">
          <div className="border-b border-line bg-surface-raised px-4 py-2 text-xs font-semibold tracking-wider text-fg-subtle uppercase">
            Search Results ({results.length})
          </div>

          {results.length === 0 ? (
            <div className="p-8 text-center text-sm text-fg-muted">
              No documentation matches found for &quot;{query}&quot;. Try searching for general
              terms like &quot;pricing&quot;, &quot;logistics&quot;, or &quot;etims&quot;.
            </div>
          ) : (
            <div className="max-h-96 divide-y divide-line overflow-y-auto">
              {results.map((res) => (
                <Link
                  key={`${res.slug}#${res.sectionId}`}
                  href={`/admin/docs/${res.slug}#${res.sectionId}`}
                  className="flex items-start gap-3 p-3.5 transition-colors hover:bg-hover"
                >
                  <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                        {res.chapterNumber !== null ? `Ch. ${res.chapterNumber}` : 'Roadmap'}:{' '}
                        {res.title}
                      </span>
                      <span className="text-xs text-fg-faint">•</span>
                      <span className="text-xs text-fg-subtle">{res.category}</span>
                    </div>
                    <h4 className="mt-0.5 text-sm font-medium text-fg-strong">
                      {res.sectionHeading}
                    </h4>
                    <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{res.snippet}</p>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-fg-faint" />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
