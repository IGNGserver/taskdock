import { describe, expect, it } from 'vitest';
import { determineFormFactor, detectIPad } from '../src/device.js';

describe('device identity and adaptive window sizes', () => {
  it('keeps wide iPads and Android tablets as tablets', () => {
    expect(determineFormFactor('large', true, true, 'Macintosh', 1024, false)).toBe('tablet');
    expect(determineFormFactor('xlarge', true, false, 'Android Tablet', 1200, true)).toBe('tablet');
    expect(determineFormFactor('compact', true, true, 'Macintosh', 1024, false)).toBe('tablet');
  });
  it('keeps a phone navigation model after rotation', () => {
    expect(determineFormFactor('expanded', true, false, 'iPhone', 390, true)).toBe('phone');
    expect(determineFormFactor('medium', true, false, 'Android Mobile', 430, true)).toBe('phone');
  });
  it('uses compact fallback on an unknown device', () => {
    expect(determineFormFactor('compact', false, false, '', 0, false)).toBe('phone');
  });
  it('does not treat a large touch-enabled laptop as a tablet', () => {
    expect(determineFormFactor('large', true, false, 'Windows NT', 1080, false)).toBe('desktop');
    expect(determineFormFactor('large', false, false, 'Windows NT', 1080, false)).toBe('desktop');
  });
  it('uses touch and available space as the fallback for smaller windows', () => {
    expect(determineFormFactor('medium', true, false, '', 800, true)).toBe('tablet');
    expect(determineFormFactor('expanded', false, false, '', 800, false)).toBe('desktop');
  });
  it('can inspect a non-browser runtime', () => expect(typeof detectIPad()).toBe('boolean'));
});
