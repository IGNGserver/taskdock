import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNetworkMode,
  isLowDataMode,
  recordNetworkSample,
  setNetworkMode,
  verificationInterval,
} from '../src/network-policy.js';

afterEach(() => {
  vi.unstubAllGlobals();
  for (let i = 0; i < 3; i++) recordNetworkSample(10);
});
describe('device-local weak-network policy', () => {
  it('combines save-data and observed latency without depending on Network Information API', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('navigator', {});
    recordNetworkSample(2000);
    expect(isLowDataMode()).toBe(false);
    recordNetworkSample(2000);
    expect(isLowDataMode()).toBe(true);
    expect(verificationInterval()).toBe(90_000);
    recordNetworkSample(10);
    expect(isLowDataMode()).toBe(false);
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    expect(isLowDataMode()).toBe(true);
  });
  it('honors the explicit override and tolerates inaccessible storage', () => {
    let value: string | null = null;
    vi.stubGlobal('localStorage', {
      getItem: () => value,
      setItem: (_key: string, mode: string) => {
        value = mode;
      },
    });
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    setNetworkMode('standard');
    expect(isLowDataMode()).toBe(false);
    setNetworkMode('low-data');
    expect(isLowDataMode()).toBe(true);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('private');
      },
    });
    expect(getNetworkMode()).toBe('auto');
  });
});
