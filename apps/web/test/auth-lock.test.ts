import { afterEach, describe, expect, it } from 'vitest';

import { ApiError, isSessionRevocationError } from '../src/api.js';
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

  it('names only a revoked session as a reason to drop the stored credential', () => {
    expect(isSessionRevocationError(new ApiError('AUTH_SESSION_REVOKED', 'x', null, 401))).toBe(
      true,
    );
    // A rejected native challenge or a rate limit says nothing about the token.
    expect(isSessionRevocationError(new ApiError('AUTH_CHALLENGE_INVALID', 'x', null, 403))).toBe(
      false,
    );
    expect(isSessionRevocationError(new ApiError('AUTH_REQUIRED', 'x', null, 401))).toBe(false);
    expect(isSessionRevocationError(new ApiError('RATE_LIMITED', 'x', null, 429))).toBe(false);
    expect(isSessionRevocationError(new Error('offline'))).toBe(false);
  });
});
