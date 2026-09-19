import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const tokensPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/ui/src/tokens.css',
);

const css = readFileSync(tokensPath, 'utf8');

/** Read a custom property's value from the `:root` block. */
function rootToken(name: string): string {
  const root = css.slice(css.indexOf(':root {'), css.indexOf("[data-theme='dark']"));
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
  if (!match) throw new Error(`token ${name} not found in tokens.css`);
  return match[1]!.replace(/\s+/g, ' ').trim();
}

/** Largest stop value in a `linear()` ramp. Values above 1 mean overshoot. */
function peak(easing: string): number {
  const stops = Array.from(easing.matchAll(/([0-9.]+)\s+[0-9.]+%/g), (match) => Number(match[1]));
  if (stops.length === 0) throw new Error(`no linear() stops in "${easing}"`);
  return Math.max(...stops);
}

/**
 * Settle time in milliseconds. Each spring's `-duration` token is the sampled
 * settle time, so it — not the ramp's last percentage stop (always 100%) — is
 * what orders a family from fast to slow.
 */
function settlesAt(token: string): number {
  const value = rootToken(`${token}-duration`);
  const match = /^([0-9.]+)ms$/.exec(value);
  if (!match) throw new Error(`unexpected duration token value "${value}"`);
  return Number(match[1]);
}

describe('M3E motion tokens', () => {
  /*
   * These assertions read the token file itself. The browser serialisation of
   * a long `linear()` stream is truncated, so the exact physics can only be
   * verified at the source.
   */
  it('never lets effects springs overshoot', () => {
    for (const token of [
      '--m3-spring-effects-fast',
      '--m3-spring-effects',
      '--m3-spring-effects-slow',
    ])
      expect(peak(rootToken(token)), token).toBeLessThanOrEqual(1);
  });

  it('gives only the expressive scheme a visible overshoot', () => {
    const standard = peak(rootToken('--m3-spring-spatial'));
    const expressive = peak(rootToken('--m3-spring-expressive-spatial'));

    // Standard spatial springs may overshoot very slightly, but must stay
    // imperceptible; the expressive scheme must be clearly visible.
    expect(standard).toBeLessThan(1.01);
    expect(expressive).toBeGreaterThan(1.08);
    expect(expressive).toBeGreaterThan(standard);
  });

  it('orders every family from fast to slow', () => {
    expect(settlesAt('--m3-spring-spatial-fast')).toBeLessThan(settlesAt('--m3-spring-spatial'));
    expect(settlesAt('--m3-spring-spatial')).toBeLessThan(settlesAt('--m3-spring-spatial-slow'));
    expect(settlesAt('--m3-spring-effects-fast')).toBeLessThan(settlesAt('--m3-spring-effects'));
    expect(settlesAt('--m3-spring-effects')).toBeLessThan(settlesAt('--m3-spring-effects-slow'));
  });

  it('emits a duration token for every spring', () => {
    for (const token of [
      '--m3-spring-spatial-fast',
      '--m3-spring-spatial',
      '--m3-spring-spatial-slow',
      '--m3-spring-effects-fast',
      '--m3-spring-effects',
      '--m3-spring-effects-slow',
      '--m3-spring-expressive-spatial-fast',
      '--m3-spring-expressive-spatial',
      '--m3-spring-expressive-spatial-slow',
    ]) {
      expect(rootToken(`${token}-duration`), `${token}-duration`).toMatch(/^[0-9]+ms$/);
    }
  });

  it('pins the last stop to exactly 1 so nothing rests off-target', () => {
    for (const token of ['--m3-spring-spatial', '--m3-spring-expressive-spatial']) {
      const easing = rootToken(token);
      expect(easing, token).toMatch(/1 100%\s*\)$/);
    }
  });
});

describe('M3E token surface', () => {
  it('defines the full corner radius scale', () => {
    for (const token of [
      '--m3-shape-none',
      '--m3-shape-xs',
      '--m3-shape-sm',
      '--m3-shape-md',
      '--m3-shape-lg',
      '--m3-shape-lg-increased',
      '--m3-shape-xl',
      '--m3-shape-xl-increased',
      '--m3-shape-xxl',
      '--m3-shape-full',
    ])
      expect(rootToken(token), token).toMatch(/^[0-9]+px$|^999px$/);
  });

  it('defines every type role and the emphasized weights', () => {
    for (const role of ['display', 'headline', 'title', 'body', 'label'])
      for (const size of ['large', 'medium', 'small']) {
        for (const property of ['size', 'line', 'weight', 'tracking'])
          expect(
            rootToken(`--m3-type-${role}-${size}-${property}`),
            `${role}-${size}-${property}`,
          ).toBeTruthy();
      }
    expect(rootToken('--m3-type-emphasized-weight')).toMatch(/^[0-9]+$/);
  });

  it('defines the elevation ladder', () => {
    for (const level of [1, 2, 3, 4, 5]) expect(rootToken(`--m3-elevation-${level}`)).toBeTruthy();
  });

  it('gives light and dark their own canvas role', () => {
    const dark = css.slice(css.indexOf("[data-theme='dark']"));
    expect(rootToken('--m3-canvas')).toMatch(/^var\(--m3-surface-container-low\)$/);
    expect(/--m3-canvas:\s*var\(--m3-surface-container-lowest\)/.test(dark)).toBe(true);
  });
});
