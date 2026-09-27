import { describe, expect, it } from 'vitest';
import { determineFormFactor } from '../src/device.js';

describe('determineFormFactor', () => {
  it('identifies compact size as phone regardless of touch', () => {
    expect(determineFormFactor('compact', false)).toBe('phone');
    expect(determineFormFactor('compact', true)).toBe('phone');
  });

  it('identifies medium and expanded touch devices as tablet', () => {
    expect(determineFormFactor('medium', true)).toBe('tablet');
    expect(determineFormFactor('expanded', true)).toBe('tablet');
  });

  it('identifies medium and expanded non-touch devices as desktop by default', () => {
    expect(determineFormFactor('medium', false)).toBe('desktop');
    expect(determineFormFactor('expanded', false)).toBe('desktop');
  });

  it('identifies large and xlarge screens as desktop even with touch', () => {
    expect(determineFormFactor('large', true)).toBe('desktop');
    expect(determineFormFactor('xlarge', true)).toBe('desktop');
    expect(determineFormFactor('large', false)).toBe('desktop');
  });
});
