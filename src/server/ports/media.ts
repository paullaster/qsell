/**
 * Media storage port (DI).
 *
 * The media domain service depends on this interface only. Each storage provider
 * (local disk, Cloudinary, S3-compatible …) is an adapter under
 * `server/adapters/media`; the composition root picks one with `MEDIA_DRIVER`.
 */

/** Providers that hold bytes. 'external' (a pasted link) has no adapter — nothing is stored. */
export type StoredMediaProvider = 'local' | 'cloudinary';

export type MediaVisibility = 'public' | 'private';

/** Named sizes, so callers ask for intent and each provider decides how to produce it. */
export type MediaVariant = 'original' | 'thumb' | 'card' | 'detail';

/** The provider's handle for one stored object. */
export interface MediaObjectRef {
  storageKey: string;
  visibility: MediaVisibility;
  /** The stored file's MIME type. Providers that build private download links need the format. */
  mime?: string;
}

export interface PutMediaInput {
  data: Buffer;
  /** Validated by the domain from the file's own bytes, never trusted from the client. */
  mime: string;
  /** Logical folder, e.g. `product`. Adapters prefix their own root. */
  folder: string;
  visibility: MediaVisibility;
}

export interface PutMediaResult {
  storageKey: string;
  bytes: number;
  /** Only when the provider reports them; the domain falls back to its own header parse. */
  width?: number;
  height?: number;
}

export interface MediaUrlOptions {
  variant?: MediaVariant;
  /**
   * How long a private URL stays valid, in seconds. Providers that can enforce
   * expiry do; ignored for public objects. Providers that cannot must say so in
   * their own documentation.
   */
  expiresInSeconds?: number;
}

export interface MediaStoragePort {
  readonly provider: StoredMediaProvider;
  put(input: PutMediaInput): Promise<PutMediaResult>;
  /** Idempotent: deleting something already gone is not an error. */
  delete(ref: MediaObjectRef): Promise<void>;
  /**
   * URL for an object. Public objects get a plain delivery URL. Private objects
   * get a signed, time-limited URL (variants may be unavailable: private files
   * are served as the original). Hand one out only after an access check.
   */
  urlFor(ref: MediaObjectRef, options?: MediaUrlOptions): string;
}
