import { afterEach, expect, it, vi } from 'vitest';
import { installMobileViewport } from '../src/mobile-viewport.js';

afterEach(() => vi.unstubAllGlobals());

it('follows the software keyboard, preserves pinch zoom, and removes listeners on cleanup', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const documentMock = Object.assign(new EventTarget(), {
    activeElement: { matches: () => true },
    documentElement: {
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
      },
      classList: {
        toggle: (key: string, active: boolean) => (active ? classes.add(key) : classes.delete(key)),
        remove: (key: string) => classes.delete(key),
      },
    },
  });
  vi.stubGlobal('window', { visualViewport: viewport, innerHeight: 844 });
  vi.stubGlobal('document', documentMock);
  const dispose = installMobileViewport();
  expect(properties.get('--dt-viewport-height')).toBe('844px');
  viewport.height = 420;
  viewport.offsetTop = 24;
  viewport.dispatchEvent(new Event('resize'));
  expect(properties.get('--dt-viewport-height')).toBe('420px');
  expect(properties.get('--dt-viewport-top')).toBe('24px');
  expect(classes.has('keyboard-visible')).toBe(true);
  viewport.scale = 2;
  viewport.height = 210;
  viewport.dispatchEvent(new Event('resize'));
  expect(properties.get('--dt-viewport-height')).toBe('420px');
  viewport.scale = 1;
  viewport.height = 844;
  viewport.dispatchEvent(new Event('resize'));
  expect(classes.has('keyboard-visible')).toBe(false);
  dispose();
  viewport.dispatchEvent(new Event('resize'));
  documentMock.dispatchEvent(new Event('focusin'));
  expect(properties.size).toBe(0);
  expect(classes.size).toBe(0);
});

it('leaves CSS viewport sizing in charge when the browser has no VisualViewport API', () => {
  vi.stubGlobal('window', {});
  expect(() => installMobileViewport()()).not.toThrow();
});
