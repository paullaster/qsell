'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from 'react';
import { ArrowLeft, ArrowRight, Images, Link2, Loader2, Star, Trash2, UploadCloud, X } from 'lucide-react';
import { ACCEPTED_IMAGE_ACCEPT, DEFAULT_MAX_IMAGE_BYTES, MAX_PRODUCT_MEDIA } from '@/lib/media';
import { checkImageFile, uploadImage } from '@/lib/mediaUpload';
import { discardMediaUploadsAction, registerExternalMediaAction } from '@/server/domains/media/actions';
import { MediaLibraryDialog } from '@/components/admin/MediaLibraryDialog';
import { MediaThumb } from '@/components/admin/MediaThumb';
import type { MediaAssetView, ProductMediaItem } from '@/types/index';

const UPLOAD_CONCURRENCY = 3;

interface UploadEntry {
  id: number;
  name: string;
  progress: number;
  error: string | null;
  done: boolean;
}

export function assetToGalleryItem(asset: MediaAssetView): ProductMediaItem {
  return {
    assetId: asset.id,
    url: asset.url,
    thumbUrl: asset.thumbUrl,
    altText: asset.altText,
    originalName: asset.originalName,
    provider: asset.provider,
    width: asset.width,
    height: asset.height,
    isPrimary: false,
    pending: asset.status === 'pending',
  };
}

/** The first slot is always the primary image. */
function withPrimary(items: ProductMediaItem[]): ProductMediaItem[] {
  return items.map((item, index) => ({ ...item, isPrimary: index === 0 }));
}

function labelFor(item: ProductMediaItem, index: number): string {
  if (item.originalName !== '') return item.originalName;
  try {
    const url = new URL(item.url, 'http://local');
    const name = url.pathname.split('/').filter(Boolean).pop();
    if (name !== undefined && name !== '') return decodeURIComponent(name);
  } catch {
    // fall through to the positional label
  }
  return `Image ${index + 1}`;
}

const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none';
const secondaryButton =
  'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border whitespace-nowrap border-line bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10';
const iconButton =
  'inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg bg-surface-sunken text-fg transition-colors hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40';

interface ProductMediaManagerProps {
  value: ProductMediaItem[];
  onChange: Dispatch<SetStateAction<ProductMediaItem[]>>;
  /** True while an upload or link lookup is running, so the form can hold its Save button. */
  onBusyChange?: (busy: boolean) => void;
}

export function ProductMediaManager({ value, onChange, onBusyChange }: ProductMediaManagerProps) {
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const libraryOpener = useRef<HTMLButtonElement>(null);
  const nextUploadId = useRef(1);
  const valueCount = useRef(value.length);
  valueCount.current = value.length;

  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [linkValue, setLinkValue] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [limitError, setLimitError] = useState<string | null>(null);

  const uploading = uploads.some((entry) => !entry.done && entry.error === null);
  useEffect(() => {
    onBusyChange?.(uploading || linkBusy);
  }, [uploading, linkBusy, onBusyChange]);

  const remaining = MAX_PRODUCT_MEDIA - value.length;

  /** Adds assets (skipping ones already present, never exceeding the cap). */
  const addAssets = useCallback(
    (assets: MediaAssetView[]) => {
      onChange((prev) => {
        const have = new Set(prev.map((item) => item.assetId));
        const room = MAX_PRODUCT_MEDIA - prev.length;
        const fresh = assets.filter((asset) => !have.has(asset.id)).slice(0, Math.max(0, room));
        return fresh.length === 0 ? prev : withPrimary([...prev, ...fresh.map(assetToGalleryItem)]);
      });
    },
    [onChange],
  );

  const patchUpload = (id: number, patch: Partial<UploadEntry>) =>
    setUploads((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  const runUploads = async (queue: { id: number; file: File }[]) => {
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const { asset, deduplicated } = await uploadImage(job.file, {
            onProgress: (progress) => patchUpload(job.id, { progress }),
          });
          addAssets([asset]);
          patchUpload(job.id, { progress: 100, done: true });
          setNotice(deduplicated ? `${job.file.name} was already in the library and was reused.` : `${job.file.name} uploaded.`);
          // Finished uploads clear themselves; failures stay until dismissed.
          window.setTimeout(() => setUploads((prev) => prev.filter((entry) => entry.id !== job.id)), 2500);
        } catch (error) {
          patchUpload(job.id, { error: error instanceof Error ? error.message : 'Upload failed.' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
  };

  const addFiles = (files: File[]) => {
    setLimitError(null);
    const inFlight = uploads.filter((entry) => !entry.done && entry.error === null).length;
    const room = Math.max(0, MAX_PRODUCT_MEDIA - valueCount.current - inFlight);
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      setLimitError(`A product can have at most ${MAX_PRODUCT_MEDIA} images. ${files.length - accepted.length} file(s) were not added.`);
    }

    const entries: UploadEntry[] = [];
    const queue: { id: number; file: File }[] = [];
    for (const file of accepted) {
      const id = nextUploadId.current++;
      const problem = checkImageFile(file);
      entries.push({ id, name: file.name, progress: 0, error: problem, done: false });
      if (problem === null) queue.push({ id, file });
    }
    setUploads((prev) => [...prev, ...entries]);
    if (queue.length > 0) void runUploads(queue);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles([...event.dataTransfer.files]);
  };

  const addLink = async () => {
    if (linkValue.trim() === '') return;
    if (remaining <= 0) {
      setLinkError(`A product can have at most ${MAX_PRODUCT_MEDIA} images.`);
      return;
    }
    setLinkBusy(true);
    setLinkError(null);
    try {
      const result = await registerExternalMediaAction({ url: linkValue });
      if (!result.ok) {
        setLinkError(result.error);
        return;
      }
      addAssets([result.data.asset]);
      setLinkValue('');
      setNotice('Image link added.');
    } catch {
      setLinkError('Could not add that link. Please try again.');
    } finally {
      setLinkBusy(false);
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const name = labelFor(value[from], from);
    onChange((prev) => {
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return withPrimary(next);
    });
    setNotice(`${name} moved to position ${to + 1} of ${value.length}${to === 0 ? ', now the main image' : ''}.`);
  };

  const remove = (index: number) => {
    const item = value.at(index);
    if (item === undefined) return;
    onChange((prev) => withPrimary(prev.filter((_, i) => i !== index)));
    setNotice(`${labelFor(item, index)} removed.`);
    // An image uploaded in this form and never saved has no other home: delete its file now
    // instead of leaving it for the nightly sweep. The server ignores anything else.
    if (item.pending === true) void discardMediaUploadsAction([item.assetId]);
  };

  const setAlt = (index: number, altText: string) =>
    onChange((prev) => prev.map((item, i) => (i === index ? { ...item, altText } : item)));

  return (
    <section aria-labelledby={`${uid}-heading`} className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 id={`${uid}-heading`} className="text-xs font-bold text-fg-strong">
          Product images
        </h4>
        <span className="text-[11px] text-fg-muted" aria-label={`${value.length} of ${MAX_PRODUCT_MEDIA} images`}>
          {value.length}/{MAX_PRODUCT_MEDIA}
        </span>
      </div>
      <p className="text-[11px] text-fg-muted">
        The first image is the main one shown in the store. Use the arrows to reorder.
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
          dragging ? 'border-indigo-500 bg-indigo-500/10' : 'border-line bg-surface'
        }`}
      >
        <UploadCloud className="h-6 w-6 text-fg-subtle" aria-hidden="true" />
        <p className="text-xs text-fg-muted">
          Drag images here, or use the buttons below.
          <br />
          JPEG, PNG, WebP, GIF or AVIF, up to {Math.round(DEFAULT_MAX_IMAGE_BYTES / (1024 * 1024))} MB each.
        </p>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <button
            type="button"
            className={secondaryButton}
            disabled={remaining <= 0}
            onClick={() => fileInput.current?.click()}
          >
            <UploadCloud className="h-4 w-4" aria-hidden="true" />
            Upload images
          </button>
          <button
            ref={libraryOpener}
            type="button"
            className={secondaryButton}
            disabled={remaining <= 0}
            onClick={() => setLibraryOpen(true)}
          >
            <Images className="h-4 w-4" aria-hidden="true" />
            Choose from library
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            // Clear so choosing the same file again still fires onChange.
            if (fileInput.current) fileInput.current.value = '';
          }}
        />
      </div>

      <div>
        <label htmlFor={`${uid}-link`} className="mb-1 block text-[11px] font-semibold text-fg-muted">
          Or add an image link
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`${uid}-link`}
            type="url"
            inputMode="url"
            value={linkValue}
            onChange={(event) => {
              setLinkValue(event.target.value);
              setLinkError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void addLink();
              }
            }}
            placeholder="https://example.com/photo.jpg"
            aria-describedby={linkError !== null ? `${uid}-link-error` : undefined}
            aria-invalid={linkError !== null ? true : undefined}
            className={`${inputClass} min-h-11 font-mono sm:min-h-10`}
          />
          <button
            type="button"
            className={`${secondaryButton} sm:w-auto`}
            disabled={linkBusy || linkValue.trim() === ''}
            onClick={() => void addLink()}
          >
            {linkBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
            Add link
          </button>
        </div>
        {linkError !== null ? (
          <p id={`${uid}-link-error`} role="alert" className="mt-1 text-[11px] text-red-700">
            {linkError}
          </p>
        ) : null}
      </div>

      {limitError !== null ? (
        <p role="alert" className="text-[11px] text-red-700">
          {limitError}
        </p>
      ) : null}

      {uploads.length > 0 ? (
        <ul className="space-y-2" aria-label="Uploads">
          {uploads.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-line bg-surface p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-fg">{entry.name}</span>
                {entry.error !== null ? (
                  <button
                    type="button"
                    aria-label={`Dismiss error for ${entry.name}`}
                    className={iconButton}
                    onClick={() => setUploads((prev) => prev.filter((e) => e.id !== entry.id))}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="shrink-0 tabular-nums text-fg-muted">{entry.done ? 'Done' : `${entry.progress}%`}</span>
                )}
              </div>
              {entry.error !== null ? (
                <p role="alert" className="mt-1 text-red-700">
                  {entry.error}
                </p>
              ) : (
                <div
                  role="progressbar"
                  aria-label={`Uploading ${entry.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={entry.progress}
                  className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                >
                  <div className="h-full rounded-full bg-indigo-600 transition-[width]" style={{ width: `${entry.progress}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {value.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-3 text-center text-xs text-fg-muted">
          No images yet. Products without an image show a placeholder in the store.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Product image gallery">
          {value.map((item, index) => {
            const name = labelFor(item, index);
            return (
              <li key={item.assetId} className="rounded-xl border border-line bg-surface p-2">
                <div className="relative aspect-square overflow-hidden rounded-lg bg-surface-sunken">
                  <MediaThumb src={item.thumbUrl} alt={item.altText !== '' ? item.altText : name} sizes="(min-width: 1024px) 180px, (min-width: 640px) 28vw, 44vw" />
                  {index === 0 ? (
                    <span className="absolute top-1 left-1 inline-flex items-center gap-1 rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      <Star className="h-3 w-3" aria-hidden="true" />
                      Main
                    </span>
                  ) : null}
                </div>
                <label htmlFor={`${uid}-alt-${item.assetId}`} className="sr-only">
                  Alt text for {name}
                </label>
                <input
                  id={`${uid}-alt-${item.assetId}`}
                  type="text"
                  value={item.altText}
                  maxLength={300}
                  onChange={(event) => setAlt(index, event.target.value)}
                  placeholder="Describe this image"
                  className={`${inputClass} mt-2 min-h-10 text-xs`}
                />
                <p className="mt-1 truncate text-[10px] text-fg-subtle" title={name}>
                  {name}
                </p>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move ${name} earlier`}
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move ${name} later`}
                      disabled={index === value.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="flex gap-1">
                    {index !== 0 ? (
                      <button
                        type="button"
                        className={iconButton}
                        aria-label={`Make ${name} the main image`}
                        title="Make main image"
                        onClick={() => move(index, 0)}
                      >
                        <Star className="h-4 w-4" aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`${iconButton} hover:bg-red-100 hover:text-red-700`}
                      aria-label={`Remove ${name}`}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sr-only" role="status" aria-live="polite">
        {notice}
      </div>

      <MediaLibraryDialog
        open={libraryOpen}
        onClose={() => {
          setLibraryOpen(false);
          libraryOpener.current?.focus();
        }}
        excludeIds={new Set(value.map((item) => item.assetId))}
        remaining={remaining}
        onAdd={(assets) => {
          addAssets(assets);
          setNotice(`${assets.length} image${assets.length === 1 ? '' : 's'} added from the library.`);
        }}
      />
    </section>
  );
}
