import { useEffect, useState } from 'react';
import { useWindowSizeClass, type WindowSizeClass } from './components/m3e/behavior.js';

export type DeviceFormFactor = 'phone' | 'tablet' | 'desktop';

export interface DeviceInfo {
  /** 'phone' for compact touch screens, 'tablet' for medium/expanded touch screens, 'desktop' for others */
  formFactor: DeviceFormFactor;
  /** True when primary pointer is coarse or touch events are supported */
  isTouch: boolean;
  /** True when device is a phone (< 600px width or phone UA) */
  isPhone: boolean;
  /** True when device is a tablet (touch screen with medium or expanded width) */
  isTablet: boolean;
  /** True when standalone PWA mode */
  isStandalone: boolean;
  /** Current window size class */
  sizeClass: WindowSizeClass;
}

/** Check if current runtime environment has touch capability */
export function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** Check if the display mode is standalone (installed PWA) */
export function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari standalone
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Determine device form factor based on window size class and touch features */
export function determineFormFactor(
  sizeClass: WindowSizeClass,
  isTouch: boolean,
): DeviceFormFactor {
  // Compact is always phone layout
  if (sizeClass === 'compact') {
    return 'phone';
  }

  // If touch is enabled and viewport is medium or expanded (up to 1200px), treat as tablet
  if (isTouch && (sizeClass === 'medium' || sizeClass === 'expanded')) {
    return 'tablet';
  }

  // Medium screens without touch could be a narrow desktop window, but let's check UA for iPad/Android tablets
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    const isTabletUA = /ipad|tablet|(android(?!.*mobile))/.test(ua);
    if (isTabletUA && (sizeClass === 'medium' || sizeClass === 'expanded')) {
      return 'tablet';
    }
  }

  // Large or wide non-touch screens are desktop
  return 'desktop';
}

/**
 * Hook providing comprehensive device form factor and touch context.
 * Enables specialized phone and tablet UI experiences.
 */
export function useDevice(): DeviceInfo {
  const sizeClass = useWindowSizeClass();
  const [isTouch, setIsTouch] = useState(detectTouch);
  const [isStandalone, setIsStandalone] = useState(detectStandalone);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQueryTouch = window.matchMedia('(pointer: coarse)');
    const mediaQueryStandalone = window.matchMedia('(display-mode: standalone)');

    const updateTouch = () => setIsTouch(detectTouch());
    const updateStandalone = () => setIsStandalone(detectStandalone());

    mediaQueryTouch.addEventListener('change', updateTouch);
    mediaQueryStandalone.addEventListener('change', updateStandalone);

    return () => {
      mediaQueryTouch.removeEventListener('change', updateTouch);
      mediaQueryStandalone.removeEventListener('change', updateStandalone);
    };
  }, []);

  const formFactor = determineFormFactor(sizeClass, isTouch);

  return {
    formFactor,
    isTouch,
    isPhone: formFactor === 'phone',
    isTablet: formFactor === 'tablet',
    isStandalone,
    sizeClass,
  };
}
