export type NetworkMode = 'auto' | 'standard' | 'low-data';
const storageKey = 'taskdock.network-mode';
let slowSamples = 0;

export function getNetworkMode(): NetworkMode {
  try {
    const mode = localStorage.getItem(storageKey);
    return mode === 'standard' || mode === 'low-data' ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

export function setNetworkMode(mode: NetworkMode): void {
  try {
    localStorage.setItem(storageKey, mode);
  } catch {
    /* Private storage is optional. */
  }
}

export function recordNetworkSample(milliseconds: number): void {
  slowSamples = milliseconds > 1500 ? Math.min(3, slowSamples + 1) : Math.max(0, slowSamples - 1);
}

export function isLowDataMode(): boolean {
  const mode = getNetworkMode();
  if (mode !== 'auto') return mode === 'low-data';
  const connection =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
          .connection;
  return Boolean(
    connection?.saveData ||
    /^(?:slow-)?2g$/.test(connection?.effectiveType ?? '') ||
    slowSamples >= 2,
  );
}

export function verificationInterval(): number {
  return isLowDataMode() ? 90_000 : 30_000;
}
