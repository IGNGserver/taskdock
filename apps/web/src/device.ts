import { useEffect, useState } from 'react';
import { useWindowSizeClass, type WindowSizeClass } from './components/m3e/behavior.js';

export type DeviceFormFactor = 'phone' | 'tablet' | 'desktop';
export interface DeviceInfo {
  formFactor: DeviceFormFactor;
  isTouch: boolean;
  isPhone: boolean;
  isTablet: boolean;
  isStandalone: boolean;
  sizeClass: WindowSizeClass;
}

export function detectTouch(): boolean {
  return (
    typeof window !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches)
  );
}

export function detectIPad(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /ipad/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function detectStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

/** Device identity survives rotation; the window size class still controls pane count. */
export function determineFormFactor(
  sizeClass: WindowSizeClass,
  isTouch: boolean,
  isIPadDevice = false,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  screenShortSide = typeof screen === 'undefined' ? 0 : Math.min(screen.width, screen.height),
  coarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
): DeviceFormFactor {
  if (/iphone|ipod|android.*mobile|windows phone/i.test(userAgent)) return 'phone';
  if (isIPadDevice || /ipad|tablet|android(?!.*mobile)/i.test(userAgent)) return 'tablet';
  if (sizeClass === 'compact') return 'phone';
  // A large touch-enabled laptop keeps its desktop navigation. Real tablets
  // without an identifying UA can still use their physical short side.
  if (
    isTouch &&
    ((coarsePointer && screenShortSide >= 600) ||
      sizeClass === 'medium' ||
      sizeClass === 'expanded')
  ) {
    return 'tablet';
  }
  return 'desktop';
}

export function useDevice(): DeviceInfo {
  const sizeClass = useWindowSizeClass();
  const [isTouch, setIsTouch] = useState(detectTouch);
  const [isStandalone, setIsStandalone] = useState(detectStandalone);
  useEffect(() => {
    const touch = window.matchMedia('(pointer: coarse)');
    const standalone = window.matchMedia('(display-mode: standalone)');
    const updateTouch = () => setIsTouch(detectTouch());
    const updateStandalone = () => setIsStandalone(detectStandalone());
    touch.addEventListener('change', updateTouch);
    standalone.addEventListener('change', updateStandalone);
    return () => {
      touch.removeEventListener('change', updateTouch);
      standalone.removeEventListener('change', updateStandalone);
    };
  }, []);
  const formFactor = determineFormFactor(sizeClass, isTouch, detectIPad());
  return {
    formFactor,
    isTouch,
    isPhone: formFactor === 'phone',
    isTablet: formFactor === 'tablet',
    isStandalone,
    sizeClass,
  };
}
