import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const webRoot = new URL('../', import.meta.url);
const publicRoot = new URL('public/', webRoot);
const html = readFileSync(new URL('index.html', webRoot), 'utf8');

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
    expect(config).toContain("src: '/pwa-192.png'");
    expect(config).toContain("src: '/pwa-512.png'");
    expect(config).not.toContain("src: '/pwa-64.png'");
  });
});
