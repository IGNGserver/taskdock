import { useRef, useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { haptic } from './behavior.js';

export interface SwipeActionConfig {
  /** Triggered when swiped right beyond threshold (e.g. mark done / toggle status) */
  onSwipeRight?: () => void | Promise<void>;
  /** Triggered when swiped left beyond threshold (e.g. quick menu / delete) */
  onSwipeLeft?: () => void | Promise<void>;
  /** Swipe threshold in pixels to activate action. Defaults to 72 */
  threshold?: number;
  /** Maximum drag distance allowed in pixels. Defaults to 120 */
  maxOffset?: number;
  /** Whether swipe is currently disabled */
  disabled?: boolean;
}

export interface SwipeActionResult {
  offset: number;
  isSwiping: boolean;
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  reset: () => void;
}

/**
 * Pure function to calculate damped swipe offset for fluid touch feedback.
 */
export function calculateSwipeOffset(
  deltaX: number,
  threshold: number = 72,
  maxOffset: number = 120,
): number {
  if (deltaX === 0) return 0;
  const sign = Math.sign(deltaX);
  const absDelta = Math.abs(deltaX);
  const clamped = absDelta <= threshold ? absDelta : threshold + (absDelta - threshold) * 0.4;
  return sign * Math.min(clamped, maxOffset);
}

/**
 * Lightweight touch/pointer hook for smooth, damped horizontal swipe gestures.
 * Provides real-time feedback with resistance and haptic pulse on threshold crossing.
 */
export function useSwipeAction({
  onSwipeRight,
  onSwipeLeft,
  threshold = 72,
  maxOffset = 120,
  disabled = false,
}: SwipeActionConfig): SwipeActionResult {
  const [offset, setOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const isHorizontal = useRef<boolean | null>(null);
  const thresholdReached = useRef<boolean>(false);

  const reset = useCallback(() => {
    setOffset(0);
    setIsSwiping(false);
    startX.current = null;
    startY.current = null;
    isHorizontal.current = null;
    thresholdReached.current = false;
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (disabled) return;
      // Ignore right clicks or secondary buttons
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Ignore taps on interactive elements like buttons, inputs, links
      if (
        e.target instanceof HTMLElement &&
        e.target.closest('button, a, input, select, textarea, [role="button"]')
      ) {
        return;
      }

      startX.current = e.clientX;
      startY.current = e.clientY;
      isHorizontal.current = null;
      thresholdReached.current = false;
      setIsSwiping(false);
    },
    [disabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (disabled || startX.current === null || startY.current === null) return;

      const deltaX = e.clientX - startX.current;
      const deltaY = e.clientY - startY.current;

      // Determine intent on first significant movement (> 8px)
      if (isHorizontal.current === null) {
        if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) {
          isHorizontal.current = Math.abs(deltaX) > Math.abs(deltaY);
          if (isHorizontal.current) {
            setIsSwiping(true);
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Ignore if pointer capture isn't supported
            }
          } else {
            // It's vertical scroll, bail out
            startX.current = null;
            startY.current = null;
            return;
          }
        } else {
          return;
        }
      }

      if (!isHorizontal.current) return;

      // Only allow swipe in supported directions
      if (deltaX > 0 && !onSwipeRight) return;
      if (deltaX < 0 && !onSwipeLeft) return;

      // Damped movement curve beyond threshold
      const finalOffset = calculateSwipeOffset(deltaX, threshold, maxOffset);

      if (Math.abs(finalOffset) >= threshold && !thresholdReached.current) {
        thresholdReached.current = true;
        haptic(10);
      } else if (Math.abs(finalOffset) < threshold && thresholdReached.current) {
        thresholdReached.current = false;
      }

      setOffset(finalOffset);
    },
    [disabled, maxOffset, onSwipeLeft, onSwipeRight, threshold],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (startX.current === null) return;
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }

      if (Math.abs(offset) >= threshold) {
        if (offset > 0 && onSwipeRight) {
          void onSwipeRight();
        } else if (offset < 0 && onSwipeLeft) {
          void onSwipeLeft();
        }
      }

      reset();
    },
    [offset, onSwipeLeft, onSwipeRight, reset, threshold],
  );

  return {
    offset,
    isSwiping,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: reset,
    },
    reset,
  };
}
