import { describe, expect, it } from 'vitest';

import { AuthService, type AuthConfig } from '../src/auth.js';
import { MemoryStore } from '../src/store.js';

const DAY = 86_400_000;

function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    bootstrapToken: 'test-bootstrap-token-that-is-long-enough-1234567890',
    accessTokenSecret: 'test-access-secret-that-is-long-enough-1234567890',
    refreshTokenPepper: 'test-refresh-pepper-that-is-long-enough-1234567890',
    accessTokenTtlSeconds: 900,
    refreshTokenIdleTtlDays: 365,
    ...overrides,
  };
}

describe('AuthService refresh session retention', () => {
  it('slides the inactivity window and rejects a session dormant for more than a year', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new MemoryStore({ clock: () => new Date(now) });
    const config = authConfig();
    const auth = new AuthService(store, config, () => now);
    await auth.bootstrap(config.bootstrapToken, 'owner', 'correct horse battery staple');

    const login = await auth.login({
      username: 'owner',
      password: 'correct horse battery staple',
      deviceName: 'test browser',
      platform: 'web',
    });
    const initial = [...store.state.sessions.values()][0]!;
    expect(Date.parse(initial.expiresAt) - now).toBe(365 * DAY);

    now += 100 * DAY;
    const rotated = await auth.refresh(login.refreshToken);
    const latest = [...store.state.sessions.values()].find((session) => session.id !== initial.id)!;
    expect(Date.parse(latest.expiresAt) - now).toBe(365 * DAY);

    now += 365 * DAY + 1;
    await expect(auth.refresh(rotated.refreshToken)).rejects.toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
    });
    expect([...store.state.sessions.values()].every((session) => session.revokedAt !== null)).toBe(
      true,
    );
  });

  it('keeps sessions without a time limit when the inactivity window is disabled', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new MemoryStore({ clock: () => new Date(now) });
    const config = authConfig({ refreshTokenIdleTtlDays: 0 });
    const auth = new AuthService(store, config, () => now);
    await auth.bootstrap(config.bootstrapToken, 'owner', 'correct horse battery staple');

    const login = await auth.login({
      username: 'owner',
      password: 'correct horse battery staple',
      deviceName: 'test browser',
      platform: 'web',
    });
    const initial = [...store.state.sessions.values()][0]!;
    expect(Date.parse(initial.expiresAt) - now).toBeGreaterThan(99 * 365 * DAY);

    now += 10 * 365 * DAY;
    await expect(auth.refresh(login.refreshToken)).resolves.toMatchObject({
      refreshToken: expect.any(String),
    });
  });
});
