import { describe, expect, it } from 'vitest';
import { calculateSwipeOffset } from '../src/components/m3e/swipe-action.js';

describe('calculateSwipeOffset', () => {
  it('returns 0 when delta is zero', () => {
    expect(calculateSwipeOffset(0, 72, 120)).toBe(0);
  });

  it('keeps linear offset before threshold', () => {
    expect(calculateSwipeOffset(40, 72, 120)).toBe(40);
    expect(calculateSwipeOffset(-40, 72, 120)).toBe(-40);
  });

  it('applies resistance damping past threshold', () => {
    const raw = 100; // 28px past threshold of 72
    const expected = 72 + 28 * 0.4; // 83.2
    expect(calculateSwipeOffset(raw, 72, 120)).toBeCloseTo(expected);
    expect(calculateSwipeOffset(-raw, 72, 120)).toBeCloseTo(-expected);
  });

  it('clamps to maxOffset', () => {
    expect(calculateSwipeOffset(300, 72, 120)).toBe(120);
    expect(calculateSwipeOffset(-300, 72, 120)).toBe(-120);
  });
});
