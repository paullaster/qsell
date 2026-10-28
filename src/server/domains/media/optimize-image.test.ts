import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { optimizeUploadedImage } from './optimize-image';

describe('optimizeUploadedImage', () => {
  it('normalizes uploads to correctly dimensioned AVIF without enlarging small images', async () => {
    const source = await sharp({
      create: { width: 96, height: 48, channels: 3, background: '#e43' },
    })
      .png()
      .toBuffer();

    const result = await optimizeUploadedImage(source);
    const metadata = await sharp(result.data).metadata();

    expect(result.mime).toBe('image/avif');
    expect(metadata.format).toBe('heif');
    expect([result.width, result.height]).toEqual([96, 48]);
  });

  it('caps very large image dimensions while preserving the aspect ratio', async () => {
    const source = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: '#e43' },
    })
      .png()
      .toBuffer();

    const result = await optimizeUploadedImage(source);

    expect([result.width, result.height]).toEqual([2560, 1280]);
  });
});
