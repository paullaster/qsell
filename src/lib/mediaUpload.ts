import { ACCEPTED_IMAGE_TYPES, DEFAULT_MAX_IMAGE_BYTES } from '@/lib/media';
import type { MediaAssetView } from '@/types/index';

export interface UploadedImage {
  asset: MediaAssetView;
  /** True when identical bytes were already in the library and were reused. */
  deduplicated: boolean;
}

/** Quick checks for instant feedback. The server re-validates from the file's real bytes. */
export function checkImageFile(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return `${file.name}: only JPEG, PNG, WebP, GIF or AVIF images can be uploaded.`;
  }
  if (file.size > DEFAULT_MAX_IMAGE_BYTES) {
    return `${file.name}: images must be ${Math.round(DEFAULT_MAX_IMAGE_BYTES / (1024 * 1024))} MB or smaller.`;
  }
  if (file.size === 0) return `${file.name}: the file is empty.`;
  return null;
}

/**
 * Uploads one image to the media service. XHR rather than fetch: it is the only
 * browser API that reports upload progress. Rejects with a message safe to show.
 */
export function uploadImage(
  file: File,
  options: { purpose?: string; onProgress?: (percent: number) => void } = {},
): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', options.purpose ?? 'product');

    const request = new XMLHttpRequest();
    request.open('POST', '/api/media/upload');
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error(`${file.name}: network error. Check your connection and try again.`));
    request.onload = () => {
      const body = request.response as (Partial<UploadedImage> & { error?: string }) | null;
      if (request.status >= 200 && request.status < 300 && body?.asset) {
        resolve({ asset: body.asset, deduplicated: body.deduplicated === true });
        return;
      }
      reject(new Error(`${file.name}: ${body?.error ?? `upload failed (${request.status}).`}`));
    };
    request.send(form);
  });
}
