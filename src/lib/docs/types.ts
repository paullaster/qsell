/**
 * Core type definitions for the build-time pre-rendered documentation engine.
 *
 * This contract defines the schema for pre-compiled manuals, tables of contents,
 * search indices, and immutable version metadata. It ensures that the runtime Next.js
 * App Router server components only deal with pre-validated, statically baked data.
 */

export interface DocTocItem {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

export interface DocSearchEntry {
  readonly slug: string;
  readonly chapterNumber: number | null;
  readonly title: string;
  readonly category: string;
  readonly sectionHeading: string;
  readonly sectionId: string;
  readonly snippet: string;
}

export interface DocChapter {
  readonly slug: string;
  readonly filename: string;
  readonly chapterNumber: number | null; // null for README/Index
  readonly title: string;
  readonly category: string;
  readonly summary: string;
  readonly readingTimeMinutes: number;
  readonly wordCount: number;
  readonly toc: readonly DocTocItem[];
  readonly htmlContent: string;
}

export interface DocVersionManifest {
  readonly version: string;
  readonly gitSha: string;
  readonly versionTag: string;
  readonly buildDate: string;
  readonly sourceChecksum: string;
  readonly pdfFilename: string;
  readonly pdfUrl: string;
  readonly pdfSizeBytes: number;
  readonly pdfSha256: string;
  readonly pdfPageCount: number;
  readonly chaptersCount: number;
}

export interface DocsManifest {
  readonly versionManifest: DocVersionManifest;
  readonly chapters: readonly DocChapter[];
  readonly searchIndex: readonly DocSearchEntry[];
}
