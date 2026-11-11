import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getDocsManifest,
  getVersionManifest,
  getAllChapters,
  getChapterBySlug,
  getSearchIndex,
} from '@/generated/docs';
import { resolveContextualDoc } from './contextual-map';

describe('Build-Time Documentation Engine & Version-Tagged PDF', () => {
  it('loads the pre-compiled documentation manifest without filesystem markdown reads', () => {
    const manifest = getDocsManifest();
    expect(manifest).toBeDefined();
    expect(manifest.chapters.length).toBe(15);
    expect(manifest.searchIndex.length).toBeGreaterThan(100);
  });

  it('validates immutable version manifest formatting and non-zero hash', () => {
    const versionManifest = getVersionManifest();
    expect(versionManifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(versionManifest.gitSha).toMatch(/^[a-z\d]{7,}$/i);
    expect(versionManifest.versionTag).toBe(
      `v${versionManifest.version}-${versionManifest.gitSha}`,
    );
    expect(versionManifest.sourceChecksum).toHaveLength(64); // SHA-256
    expect(versionManifest.chaptersCount).toBe(15);
    expect(versionManifest.pdfSizeBytes).toBeGreaterThan(50 * 1024); // spec: > 50KB
  });

  it('verifies all 15 chapters have titles, TOCs, HTML content, and reading metrics', () => {
    const chapters = getAllChapters();
    expect(chapters).toHaveLength(15);

    for (const chapter of chapters) {
      expect(chapter.slug).toBeTruthy();
      expect(chapter.title).toBeTruthy();
      expect(chapter.category).toBeTruthy();
      expect(chapter.summary.length).toBeGreaterThan(10);
      expect(chapter.readingTimeMinutes).toBeGreaterThanOrEqual(1);
      expect(chapter.wordCount).toBeGreaterThan(50);
      expect(chapter.htmlContent).toContain('<h');
      expect(chapter.toc.length).toBeGreaterThan(0);
    }
  });

  it('retrieves specific chapters by slug with complete integrity', () => {
    const pricingChapter = getChapterBySlug('04-pricing-engine-promotions-and-margins');
    expect(pricingChapter).toBeDefined();
    expect(pricingChapter?.chapterNumber).toBe(4);
    expect(pricingChapter?.title).toContain('Pricing Engine');
    expect(pricingChapter?.htmlContent).toContain('doc-table');

    const indexChapter = getChapterBySlug('index');
    expect(indexChapter).toBeDefined();
    expect(indexChapter?.chapterNumber).toBeNull();
    expect(indexChapter?.title).toContain('Implementor & Sales');
  });

  it('verifies search index contains section headings and snippets', () => {
    const searchIndex = getSearchIndex();
    expect(searchIndex.length).toBeGreaterThan(200);

    const etimsMatches = searchIndex.filter(
      (e) =>
        e.snippet.toLowerCase().includes('etims') ||
        e.sectionHeading.toLowerCase().includes('etims'),
    );
    expect(etimsMatches.length).toBeGreaterThan(0);
    expect(
      etimsMatches.some((e) => e.slug === '13-settings-branches-numbering-and-kra-etims'),
    ).toBe(true);
  });

  it('verifies physical version-tagged PDF asset exists and has valid PDF magic bytes', () => {
    const versionManifest = getVersionManifest();
    const pdfPath = path.join(process.cwd(), 'public', 'downloads', versionManifest.pdfFilename);

    expect(fs.existsSync(pdfPath)).toBe(true);
    const buffer = fs.readFileSync(pdfPath);
    expect(buffer.length).toBe(versionManifest.pdfSizeBytes);

    // PDF magic bytes header: %PDF-
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');

    // Cover + TOC + 15 chapters, one or more pages each
    expect(versionManifest.pdfPageCount).toBeGreaterThanOrEqual(17);

    // The manifest checksum is the exact sha256 of the served PDF bytes
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    expect(versionManifest.pdfSha256).toBe(sha256);
    expect(versionManifest.pdfSha256).toHaveLength(64);
  });

  it('resolves contextual admin routes to the exact corresponding manual chapters', () => {
    expect(resolveContextualDoc('/admin/pricing')).toEqual({
      slug: '04-pricing-engine-promotions-and-margins',
      chapterTitle: 'Pricing Engine, Promotions & Margins',
      href: '/admin/docs/04-pricing-engine-promotions-and-margins',
    });

    expect(resolveContextualDoc('/admin/delivery')).toEqual({
      slug: '06-delivery-logistics-and-field-dispatch',
      chapterTitle: 'Delivery Logistics & Field Dispatch',
      href: '/admin/docs/06-delivery-logistics-and-field-dispatch',
    });

    expect(resolveContextualDoc('/admin/settings')).toEqual({
      slug: '13-settings-branches-numbering-and-kra-etims',
      chapterTitle: 'Settings, Branches, Numbering & KRA eTIMS',
      href: '/admin/docs/13-settings-branches-numbering-and-kra-etims',
    });

    expect(resolveContextualDoc('/admin')).toEqual({
      slug: '01-business-overview-and-dashboard',
      chapterTitle: 'Business Overview & Executive Dashboard',
      href: '/admin/docs/01-business-overview-and-dashboard',
    });

    // Sub-routes under /admin that belong to no chapter fall back to the master curriculum.
    expect(resolveContextualDoc('/admin/unknown-page')).toEqual({
      slug: 'index',
      chapterTitle: 'Master Manual & 7-Stage Roadmap',
      href: '/admin/docs',
    });
  });
});
