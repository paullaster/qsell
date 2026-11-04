/** Browser helpers for the door forms: shrinking a photo before it goes over mobile data, finding where the phone is, and uploading. */

const MAX_SIDE = 1600;

/** A photo no larger than 1600 px a side, as a JPEG, so it is quick to send; the original if the browser cannot do it. */
export async function shrinkPhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (context === null) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    return blob === null || blob.size >= file.size ? file : new File([blob], 'door.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Where the phone is, if it will say within a few seconds; never a reason to hold the rider up. */
export function whereAmI(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60_000 },
    );
  });
}

/** A key for one try at a door: made when the form opens, sent with every retry of it, so a repeat is the same try. */
export const newTryKey = (): string => crypto.randomUUID().replace(/-/g, '');

export type PhotoUpload = { ok: true; photoId: string } | { ok: false; error: string };

export async function uploadProofPhoto(file: File): Promise<PhotoUpload> {
  try {
    const body = new FormData();
    body.set('file', await shrinkPhoto(file));
    const response = await fetch('/api/rider/proof-photo', { method: 'POST', body });
    const json = (await response.json()) as { ok?: boolean; error?: string; data?: { photoId?: string } };
    if (json.ok === true && typeof json.data?.photoId === 'string') return { ok: true, photoId: json.data.photoId };
    return { ok: false, error: json.error ?? 'The photo could not be saved. Try again.' };
  } catch {
    return { ok: false, error: 'The photo could not be sent. Check your connection and try again.' };
  }
}
