import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTheme, readSystemTheme, resolveTheme } from '../src/theme.js';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', { value: originalWindow });
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', { value: originalDocument });
  else Reflect.deleteProperty(globalThis, 'document');
});

describe('theme resolution', () => {
  it('maps the system media query to a theme name', () => {
    expect(resolveTheme(true)).toBe('dark');
    expect(resolveTheme(false)).toBe('light');
  });

  it('falls back to light outside a browser environment', () => {
    expect(readSystemTheme()).toBe('light');
  });

  it('applies the initial theme and responds to system changes', () => {
    let mediaListener: ((event: MediaQueryListEvent) => void) | undefined;
    const mediaQuery = {
      matches: true,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListener = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: '' } } as HTMLElement;
    const meta = { content: '' } as HTMLMetaElement;
    const documentStub = {
      documentElement: root,
      querySelector: vi.fn(() => meta),
    } as unknown as Document;
    const windowStub = {
      matchMedia: vi.fn(() => mediaQuery),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });

    const dispose = installTheme();
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(meta.content).toBe('#0d0e13');

    mediaListener?.({ matches: false } as MediaQueryListEvent);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(meta.content).toBe('#f5f2f9');

    dispose();
    expect(mediaQuery.removeEventListener).toHaveBeenCalledOnce();
    expect(windowStub.removeEventListener).toHaveBeenCalledOnce();
  });

  it('accepts native Android theme events', () => {
    let nativeListener: ((event: Event) => void) | undefined;
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: '' } } as HTMLElement;
    const meta = { content: '' } as HTMLMetaElement;
    const documentStub = {
      documentElement: root,
      querySelector: vi.fn(() => meta),
    } as unknown as Document;
    const windowStub = {
      matchMedia: vi.fn(() => mediaQuery),
      addEventListener: vi.fn((_type: string, listener: (event: Event) => void) => {
        nativeListener = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });

    const dispose = installTheme();
    expect(root.dataset.theme).toBe('light');

    nativeListener?.(
      new CustomEvent('devtodo:native-theme-changed', { detail: { theme: 'dark' } }),
    );
    expect(root.dataset.theme).toBe('dark');
    expect(meta.content).toBe('#0d0e13');

    dispose();
    expect(windowStub.removeEventListener).toHaveBeenCalledOnce();
  });
});
