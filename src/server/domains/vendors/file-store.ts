import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorEvents, vendorFiles } from '@/server/db/drizzle/schema';
import type { FinanceContext } from '@/server/domains/finance/errors';
import { sniffImage } from '@/server/domains/media/validation';

export class FileRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileRejected';
  }
}

export type DocumentMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

/** The largest file accepted: 10 MB unless `VENDOR_FILE_MAX_BYTES` says otherwise (never above 25 MB, the database's own limit). */
export function maxFileBytes(): number {
  const configured = Number(process.env.VENDOR_FILE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 25 * 1024 * 1024) : 10 * 1024 * 1024;
}

/** What a file really is, from its own first bytes (never from its name or the type the browser claims). */
export function sniffDocument(data: Buffer): DocumentMime | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  const image = sniffImage(data);
  if (image !== null && (image.mime === 'image/jpeg' || image.mime === 'image/png' || image.mime === 'image/webp')) return image.mime;
  return null;
}

const EXTENSION: Record<DocumentMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** A name safe to put in a header and on a disk: no path, no control characters, and an extension that matches the content. */
export function safeFileName(original: string, mime: DocumentMime): string {
  const base = original.split(/[\\/]/).pop() ?? 'file';
  const stem = base.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${stem === '' ? 'file' : stem}.${EXTENSION[mime]}`;
}

export interface StoredFile {
  id: string;
  fileName: string;
  mime: DocumentMime;
  sizeBytes: number;
}

/**
 * Vendor files (certificates, signed delivery notes, scanned invoices). They live in the database and are served only through
 * routes that check who is asking; there is no public link to one. Moving them to object storage later changes this class only.
 */
export class VendorFileStore {
  constructor(private readonly db: DrizzleDb) {}

  async put(input: { companyId: string; vendorId: string; originalName: string; data: Buffer; createdBy: string | null }): Promise<StoredFile> {
    if (input.data.length === 0) throw new FileRejected('That file is empty.');
    if (input.data.length > maxFileBytes()) throw new FileRejected(`That file is too large. The most we accept is ${String(Math.floor(maxFileBytes() / (1024 * 1024)))} MB.`);
    const mime = sniffDocument(input.data);
    if (mime === null) throw new FileRejected('We accept PDF files and JPEG, PNG or WebP pictures only.');
    const fileName = safeFileName(input.originalName, mime);
    const [row] = await this.db
      .insert(vendorFiles)
      .values({
        companyId: input.companyId,
        vendorId: input.vendorId,
        fileName,
        mime,
        sizeBytes: input.data.length,
        sha256: createHash('sha256').update(input.data).digest('hex'),
        data: input.data,
        createdBy: input.createdBy,
      })
      .returning({ id: vendorFiles.id });
    if (row === undefined) throw new FileRejected('The file could not be saved.');
    return { id: row.id, fileName, mime, sizeBytes: input.data.length };
  }

  /** The file, for a caller who has already been checked. `vendorId` null means any vendor (staff). */
  async read(companyId: string, fileId: string, vendorId: string | null): Promise<{ fileName: string; mime: DocumentMime; data: Buffer } | null> {
    const [row] = await this.db
      .select({ fileName: vendorFiles.fileName, mime: vendorFiles.mime, data: vendorFiles.data })
      .from(vendorFiles)
      .where(and(eq(vendorFiles.companyId, companyId), eq(vendorFiles.id, fileId), ...(vendorId === null ? [] : [eq(vendorFiles.vendorId, vendorId)])));
    return row === undefined ? null : { fileName: row.fileName, mime: row.mime as DocumentMime, data: row.data };
  }

  /** A staff member opens a file: it is read and the opening is written to the vendor's history, in one step. */
  async openForStaff(ctx: FinanceContext, fileId: string): Promise<{ fileName: string; mime: DocumentMime; data: Buffer } | null> {
    const [row] = await this.db
      .select({ vendorId: vendorFiles.vendorId, fileName: vendorFiles.fileName, mime: vendorFiles.mime, data: vendorFiles.data })
      .from(vendorFiles)
      .where(and(eq(vendorFiles.companyId, ctx.companyId), eq(vendorFiles.id, fileId)));
    if (row === undefined) return null;
    await this.db.insert(vendorEvents).values({ vendorId: row.vendorId, event: 'file_opened', data: { fileId, fileName: row.fileName }, actorType: ctx.actor.type, actorId: ctx.actor.id, origin: { ...ctx.origin } });
    return { fileName: row.fileName, mime: row.mime as DocumentMime, data: row.data };
  }
}
