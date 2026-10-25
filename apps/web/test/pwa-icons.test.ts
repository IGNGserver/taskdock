import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const webRoot = new URL('../', import.meta.url);
const publicRoot = new URL('public/', webRoot);
const revision = createHash('sha256')
  .update('taskdock-pwa-v2')
  .update(readFileSync(new URL('../../assets/branding/taskdock-icon.png', webRoot)))
  .digest('hex')
  .slice(0, 16);
const html = readFileSync(new URL('index.html', webRoot), 'utf8').replaceAll(
  '%TASKDOCK_ICON_REVISION%',
  revision,
);

interface IconLink {
  href: string;
  rel: 'icon' | 'apple-touch-icon';
  sizes?: string;
}

function iconLinks(source: string): IconLink[] {
  return [...source.matchAll(/<link\b[^>]*>/g)].flatMap(([tag]) => {
    const rel = /\brel="(icon|apple-touch-icon)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (!rel || !href) return [];
    const sizes = /\bsizes="(\d+)x(\d+)"/.exec(tag);
    return [
      {
        href,
        rel: rel as IconLink['rel'],
        sizes: sizes ? `${sizes[1]}x${sizes[2]}` : undefined,
      },
    ];
  });
}

function pngDimensions(bytes: Buffer): { height: number; width: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const links = iconLinks(html);

describe('PWA icon links', () => {
  it('point at root-absolute PNG files whose dimensions match sizes', () => {
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const link of links) {
      expect(link.href.startsWith('/')).toBe(true);
      const bytes = readFileSync(new URL(`.${link.href}`, publicRoot));
      const { width, height } = pngDimensions(bytes);
      if (link.sizes) expect(`${width}x${height}`).toBe(link.sizes);
    }
  });

  it('provide high-resolution Safari and iOS sources', () => {
    expect(links.some((link) => link.rel === 'icon' && link.sizes === '192x192')).toBe(true);
    expect(links.some((link) => link.rel === 'icon' && link.sizes === '512x512')).toBe(true);
    expect(links.some((link) => link.rel === 'apple-touch-icon' && link.sizes === '180x180')).toBe(
      true,
    );
    expect(
      links.some((link) => link.rel === 'apple-touch-icon' && link.href.startsWith('/icons/')),
    ).toBe(true);
  });

  it('keep a manifest with usable any-purpose icons', () => {
    const config = readFileSync(new URL('vite.config.ts', webRoot), 'utf8');
    expect(config).toContain("src: iconUrl('pwa-192.png')");
    expect(config).toContain("src: iconUrl('pwa-512.png')");
    expect(config).not.toContain("src: iconUrl('pwa-64.png')");
  });
  it('ships distinct high-resolution maskable files and opaque launcher PNGs', () => {
    for (const name of [
      'pwa-192.png',
      'pwa-512.png',
      'pwa-1024.png',
      'pwa-maskable-1024.png',
      'apple-touch-icon-180x180.png',
      'apple-touch-icon-167x167.png',
      'apple-touch-icon-152x152.png',
    ]) {
      const bytes = readFileSync(new URL(`public/icons/${revision}/${name}`, webRoot));
      const { width, height } = pngDimensions(bytes);
      expect(bytes[25]).toBe(6);
      const chunks: Buffer[] = [];
      for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT')
          chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      const pixels = inflateSync(Buffer.concat(chunks));
      for (let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1);
        expect(pixels[row]).toBe(0);
        for (let x = 0; x < width; x++)
          if (pixels[row + 1 + x * 4 + 3] !== 255)
            throw new Error(`${name} has transparency at ${x},${y}`);
      }
    }
    expect(
      readFileSync(new URL(`public/icons/${revision}/pwa-512.png`, webRoot)).equals(
        readFileSync(new URL(`public/icons/${revision}/pwa-maskable-512.png`, webRoot)),
      ),
    ).toBe(false);
  });
});
