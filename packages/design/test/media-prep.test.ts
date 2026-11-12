import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_EDGE, prepareImage } from '../src/media-prep.js';

const image = (width: number, height: number, alpha: boolean, as: 'png' | 'jpeg') =>
  sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 10, g: 80, b: 160, alpha: 0.5 } : { r: 10, g: 80, b: 160 } } })[as]().toBuffer();

describe('prepareImage', () => {
  it('scales a large export down and names it by its real format', async () => {
    const r = await prepareImage(await image(4096, 2730, false, 'jpeg'), 'hero.png', 'image/png');
    expect(r).toMatchObject({ filename: 'hero.jpg', contentType: 'image/jpeg', resized: { width: 4096, height: 2730 } });
    expect((await sharp(Buffer.from(r.data)).metadata()).width).toBe(MAX_EDGE);
  });

  it('keeps transparency as PNG', async () => {
    const r = await prepareImage(await image(3000, 1000, true, 'png'), 'logo.png', 'image/png');
    expect(r).toMatchObject({ filename: 'logo.png', contentType: 'image/png' });
    expect(r.resized).toBeDefined();
  });

  it('leaves small images and non-images alone', async () => {
    expect((await prepareImage(await image(800, 600, false, 'png'), 'card.png', 'image/png')).resized).toBeUndefined();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await prepareImage(Buffer.from('%PDF-1.4'), 'a.pdf', 'application/pdf')).toMatchObject({ filename: 'a.pdf', contentType: 'application/pdf' });
    expect((await prepareImage(svg, 'i.svg', 'image/svg+xml')).filename).toMatch(/^i\.svg$/);
  });
});
