import sharp from 'sharp';

/**
 * Normalize uploaded photos once, before they enter object storage. The original
 * upload limit is still enforced by the caller; this bounds decoded dimensions
 * and creates a cacheable, browser-friendly master for every provider.
 */
export async function optimizeUploadedImage(data: Buffer): Promise<{
  data: Buffer;
  mime: 'image/avif';
  width: number;
  height: number;
}> {
  const pipeline = sharp(data, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().resize({
    width: 2560,
    height: 2560,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const { data: optimized, info } = await pipeline
    .avif({ quality: 72, effort: 4, chromaSubsampling: '4:2:0' })
    .toBuffer({ resolveWithObject: true });

  return { data: optimized, mime: 'image/avif', width: info.width, height: info.height };
}
