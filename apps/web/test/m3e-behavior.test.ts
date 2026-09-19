import { describe, expect, it } from 'vitest';

import {
  SPRING_DURATION,
  isCompactShell,
  windowSizeClass,
  type WindowSizeClass,
} from '../src/components/m3e/behavior.js';

describe('M3E window size classes', () => {
  /*
   * The breakpoints must match `apps/web/src/styles/responsive.css`. If they
   * drift, the shell renders one navigation form while the CSS lays out
   * another, which is exactly the mobile bottom-bar bug this replaced.
   */
  it.each([
    [320, 'compact'],
    [599, 'compact'],
    [600, 'medium'],
    [839, 'medium'],
    [840, 'expanded'],
    [1199, 'expanded'],
    [1200, 'large'],
    [1599, 'large'],
    [1600, 'xlarge'],
    [2560, 'xlarge'],
  ])('maps %ipx to %s', (width, expected) => {
    expect(windowSizeClass(width)).toBe(expected);
  });

  it('treats compact and medium as the touch-first shell', () => {
    const touchFirst: WindowSizeClass[] = ['compact', 'medium'];
    const pointerFirst: WindowSizeClass[] = ['expanded', 'large', 'xlarge'];
    for (const sizeClass of touchFirst) expect(isCompactShell(sizeClass)).toBe(true);
    for (const sizeClass of pointerFirst) expect(isCompactShell(sizeClass)).toBe(false);
  });
});

describe('M3E spring durations', () => {
  it('exposes every spring speed the tokens define', () => {
    expect(Object.keys(SPRING_DURATION).sort()).toEqual(
      [
        'effects',
        'effects-fast',
        'effects-slow',
        'expressive-spatial',
        'expressive-spatial-fast',
        'expressive-spatial-slow',
        'spatial',
        'spatial-fast',
        'spatial-slow',
      ].sort(),
    );
  });

  it('never bounces faster than it fades', () => {
    // Effects tokens are critically damped, so a fade must not outlast the
    // spatial move it accompanies; otherwise the overlay lingers after the
    // surface has settled.
    expect(SPRING_DURATION.effects).toBeLessThan(SPRING_DURATION.spatial);
    expect(SPRING_DURATION['effects-slow']).toBeLessThan(SPRING_DURATION['spatial-slow']);
  });

  it('orders each family from fast to slow', () => {
    expect(SPRING_DURATION['spatial-fast']).toBeLessThan(SPRING_DURATION.spatial);
    expect(SPRING_DURATION.spatial).toBeLessThan(SPRING_DURATION['spatial-slow']);
    expect(SPRING_DURATION['effects-fast']).toBeLessThan(SPRING_DURATION.effects);
    expect(SPRING_DURATION.effects).toBeLessThan(SPRING_DURATION['effects-slow']);
  });
});
