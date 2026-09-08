import { afterEach, describe, expect, it } from 'vitest';

import { isAuthLocallyLocked, lockAuthLocally, unlockAuthLocally } from '../src/auth-lock.js';

const previousStorage = globalThis.localStorage;

afterEach(() => {
  if (previousStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
  else globalThis.localStorage = previousStorage;
});

function installStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
}

describe('local auth lock', () => {
  it('keeps an explicit logout lock until a successful login unlocks it', () => {
    installStorage();
    unlockAuthLocally();
    expect(isAuthLocallyLocked()).toBe(false);

    lockAuthLocally();
    expect(isAuthLocallyLocked()).toBe(true);

    unlockAuthLocally();
    expect(isAuthLocallyLocked()).toBe(false);
  });
});
