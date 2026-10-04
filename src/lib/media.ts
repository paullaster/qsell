/** Media limits shared by the browser (early feedback) and the server (the real check). */

export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PRODUCT_MEDIA = 12;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
export const ACCEPTED_IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',');
