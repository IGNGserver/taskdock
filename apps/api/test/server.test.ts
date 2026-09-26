import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@devtodo/contracts';

import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';

describe('Fastify API', () => {
  it('accepts a six-digit numeric owner password and allows an HTTP production origin', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-six-digit';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: {
        nodeEnv: 'production',
        webRoot: '/tmp/devtodo-no-web',
        bootstrapToken: token,
        accessTokenSecret: 'test-access-secret-that-is-long-enough-1234567890',
        refreshTokenPepper: 'test-refresh-pepper-that-is-long-enough-1234567890',
        databaseUrl: 'postgres://devtodo:password@localhost:5432/devtodo',
        appOrigin: 'http://tasks.example.com',
        corsAllowedOrigins: ['http://tasks.example.com'],
        nativeAllowedOrigins: ['devtodo://app', 'capacitor://localhost', 'https://localhost'],
        devMemoryStore: false,
      },
    });
    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'numeric-owner', password: '100728' },
    });
    expect(bootstrap.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'numeric-owner', password: '100728' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const refreshCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(refreshCookie).toContain('devtodo_refresh=');
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).not.toContain('Secure');
    const httpShellHeaders = await app.inject({ method: 'GET', url: '/health/live' });
    expect(httpShellHeaders.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(httpShellHeaders.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  it('answers 429 once AUTH_LOGIN_RATE_LIMIT is exhausted for that address and username', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-rate-limit';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: {
        nodeEnv: 'test',
        webRoot: '/tmp/devtodo-no-web',
        bootstrapToken: token,
        accessTokenSecret: 'test-access-secret-that-is-long-enough-1234567890',
        refreshTokenPepper: 'test-refresh-pepper-that-is-long-enough-1234567890',
        authLoginRateLimit: 2,
      },
    });
    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'rate-limited-owner', password: 'rate-limit-password' },
    });
    expect(bootstrap.statusCode).toBe(201);
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'rate-limited-owner', password: 'rate-limit-password' },
      });
    expect((await attempt()).statusCode).toBe(200);
    expect((await attempt()).statusCode).toBe(200);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(limited.json().details.retryAfterSeconds).toBeGreaterThan(0);
    await app.close();
  });

  it('refuses an AUTH_LOGIN_RATE_LIMIT that would disable brute-force protection in production', async () => {
    await expect(
      buildServer({
        store: new MemoryStore(),
        config: {
          nodeEnv: 'production',
          webRoot: '/tmp/devtodo-no-web',
          bootstrapToken: 'test-bootstrap-token-that-is-long-enough-rate-cap',
          accessTokenSecret: 'test-access-secret-that-is-long-enough-1234567890',
          refreshTokenPepper: 'test-refresh-pepper-that-is-long-enough-1234567890',
          databaseUrl: 'postgres://devtodo:password@localhost:5432/devtodo',
          devMemoryStore: false,
          authLoginRateLimit: 100_000,
        },
      }),
    ).rejects.toThrow('AUTH_LOGIN_RATE_LIMIT must stay at or below 1000 in production');
  });

  it('allows the Android HTTP WebView origin for bootstrap status', async () => {
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: {
        nodeEnv: 'production',
        webRoot: '/tmp/devtodo-no-web',
        bootstrapToken: 'test-bootstrap-token-that-is-long-enough-http-origin',
        accessTokenSecret: 'test-access-secret-that-is-long-enough-1234567890',
        refreshTokenPepper: 'test-refresh-pepper-that-is-long-enough-1234567890',
        databaseUrl: 'postgres://devtodo:password@localhost:5432/devtodo',
        appOrigin: 'http://tasks.example.com',
        corsAllowedOrigins: ['http://tasks.example.com'],
        nativeAllowedOrigins: ['devtodo://app', 'capacitor://localhost', 'https://localhost'],
        devMemoryStore: false,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap/status',
      headers: { origin: 'http://localhost' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost');
    expect(response.json()).toEqual({ initialized: false });
    await app.close();
  });

  it('marks the web refresh cookie as Secure when the app origin is HTTPS', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-https-cookie';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: {
        nodeEnv: 'production',
        webRoot: '/tmp/devtodo-no-web',
        bootstrapToken: token,
        accessTokenSecret: 'test-access-secret-that-is-long-enough-1234567890',
        refreshTokenPepper: 'test-refresh-pepper-that-is-long-enough-1234567890',
        databaseUrl: 'postgres://devtodo:password@localhost:5432/devtodo',
        appOrigin: 'https://tasks.example.com',
        corsAllowedOrigins: ['https://tasks.example.com'],
        nativeAllowedOrigins: ['devtodo://app', 'capacitor://localhost', 'https://localhost'],
        devMemoryStore: false,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'https-owner', password: '100728' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'https-owner', password: '100728' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const refreshCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(refreshCookie).toContain('devtodo_refresh=');
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('Secure');
    const httpsShellHeaders = await app.inject({ method: 'GET', url: '/health/live' });
    expect(httpsShellHeaders.headers['content-security-policy']).toContain(
      'upgrade-insecure-requests',
    );
    expect(httpsShellHeaders.headers['strict-transport-security']).toContain('max-age=');
    await app.close();
  });

  it('bootstraps, authenticates, and applies shared task state to all placements', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-123';
    const { app, store } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'tester', password: 'correct horse battery staple' },
    });
    expect(bootstrap.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'tester',
        password: 'correct horse battery staple',
        deviceName: 'test',
        platform: 'web',
      },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken, user } = login.json() as { accessToken: string; user: { id: string } };
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(),
      payload: { name: 'DSH Desktop', taskPrefix: 'DSH' },
    });
    expect(projectResponse.statusCode).toBe(409);
    expect(projectResponse.json().code).toBe('CLIENT_UPGRADE_REQUIRED');

    // Bootstrap an entity directly via store for remaining read-path compatibility tests
    const project = store.createProject(user.id, 'DSH Desktop', 'DSH');
    const task = store.createTask(user.id, {
      projectId: project.id,
      category: 'FEATURE',
      title: '修复移动端连接',
      priority: 'NONE',
    });
    expect(task.referenceId).toBe('DSH-1');
    const date = await app.inject({
      method: 'POST',
      url: '/api/v1/time-points/date',
      headers: headers(),
      payload: { localDate: '2026-09-04' },
    });
    const event = await app.inject({
      method: 'POST',
      url: '/api/v1/time-points/events',
      headers: headers(),
      payload: { title: '额度重置后' },
    });
    const dateId = (date.json() as { id: string }).id;
    const eventId = (event.json() as { id: string }).id;
    for (const timePointId of [dateId, eventId]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/placements',
        headers: headers(),
        payload: { taskId: task.id, timePointId },
      });
      expect(response.statusCode).toBe(201);
    }
    const completed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      headers: headers(),
      payload: { status: 'DONE', baseVersion: task.version },
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json().code).toBe('CLIENT_UPGRADE_REQUIRED');

    // Update the task directly in store for verifying v1 placement read aggregation
    store.updateTask(user.id, task.id, { status: 'DONE' }, task.version);
    const placements = await app.inject({
      method: 'GET',
      url: `/api/v1/time-points/${eventId}/placements`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(
      (placements.json() as { items: Array<{ task: { status: string } }> }).items[0]?.task.status,
    ).toBe('DONE');
    const projectCounts = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/task-counts',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(projectCounts.statusCode).toBe(200);
    expect(projectCounts.json()).toEqual({
      items: [{ projectId: project.id, openCount: 0, doneCount: 1 }],
    });
    const dateCounts = await app.inject({
      method: 'GET',
      url: '/api/v1/time-points/placement-counts?type=DATE&from=2026-09-04&to=2026-09-04',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(dateCounts.statusCode).toBe(200);
    expect(
      (dateCounts.json() as { items: Array<{ totalCount: number; doneCount: number }> }).items,
    ).toEqual([
      { timePointId: dateId, localDate: '2026-09-04', totalCount: 1, openCount: 0, doneCount: 1 },
    ]);
    const eventCounts = await app.inject({
      method: 'GET',
      url: `/api/v1/time-points/placement-counts?type=EVENT&archived=false`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(eventCounts.statusCode).toBe(200);
    expect(
      (eventCounts.json() as { items: Array<{ timePointId: string; openCount: number }> }).items,
    ).toEqual([
      { timePointId: eventId, localDate: null, totalCount: 1, openCount: 0, doneCount: 1 },
    ]);
    expect(store.listTasks(user.id)).toHaveLength(1);
    await app.close();
  });

  it('serializes refresh rotation and revokes the chain on token replay', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-456';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'refresh-user', password: 'correct horse battery staple' },
    });
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/native/challenge',
      headers: { origin: 'https://localhost' },
    });
    expect(challenge.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://localhost' },
      payload: {
        username: 'refresh-user',
        password: 'correct horse battery staple',
        nativeChallenge: (challenge.json() as { challenge: string }).challenge,
      },
    });
    expect(login.statusCode).toBe(200);
    const refreshToken = (login.json() as { refreshToken: string }).refreshToken;
    const refresh = async () => {
      const nextChallenge = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/native/challenge',
        headers: { origin: 'https://localhost' },
      });
      return app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { origin: 'https://localhost' },
        payload: {
          refreshToken,
          nativeChallenge: (nextChallenge.json() as { challenge: string }).challenge,
        },
      });
    };
    const [first, second] = await Promise.all([refresh(), refresh()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 401]);
    const rotated = first.statusCode === 200 ? first : second;
    const nextToken = (rotated.json() as { refreshToken: string }).refreshToken;
    const afterReplayChallenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/native/challenge',
      headers: { origin: 'https://localhost' },
    });
    const afterReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: 'https://localhost' },
      payload: {
        refreshToken: nextToken,
        nativeChallenge: (afterReplayChallenge.json() as { challenge: string }).challenge,
      },
    });
    expect(afterReplay.statusCode).toBe(401);
    await app.close();
  });

  it('resumes a rotation whose response the native client never received', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-resume';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    const challenge = async (): Promise<{ nativeChallenge: string }> => ({
      nativeChallenge: (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/native/challenge',
          headers: { origin: 'https://localhost' },
        })
      ).json().challenge as string,
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'resume-user', password: 'correct horse battery staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://localhost' },
      payload: {
        username: 'resume-user',
        password: 'correct horse battery staple',
        ...(await challenge()),
      },
    });
    expect(login.statusCode).toBe(200);
    const spentToken = (login.json() as { refreshToken: string }).refreshToken;
    const successor = randomBytes(48).toString('base64url');
    const refresh = async (presented: string, candidate: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { origin: 'https://localhost' },
        payload: {
          refreshToken: presented,
          nextRefreshToken: candidate,
          ...(await challenge()),
        },
      });

    const first = await refresh(spentToken, successor);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { refreshToken: string }).refreshToken).toBe(successor);

    // The client persisted `successor` but the reply was lost: retrying with the
    // same pair must resume instead of tripping the replay revocation.
    const retry = await refresh(spentToken, successor);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { refreshToken: string }).refreshToken).toBe(successor);

    const advanced = await refresh(successor, randomBytes(48).toString('base64url'));
    expect(advanced.statusCode).toBe(200);
    await app.close();
  });

  it('revokes the chain when a spent token is replayed with an unknown successor', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-thief';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    const challenge = async (): Promise<{ nativeChallenge: string }> => ({
      nativeChallenge: (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/native/challenge',
          headers: { origin: 'https://localhost' },
        })
      ).json().challenge as string,
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'thief-user', password: 'correct horse battery staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://localhost' },
      payload: {
        username: 'thief-user',
        password: 'correct horse battery staple',
        ...(await challenge()),
      },
    });
    const spentToken = (login.json() as { refreshToken: string }).refreshToken;
    const legitimate = randomBytes(48).toString('base64url');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: { origin: 'https://localhost' },
          payload: {
            refreshToken: spentToken,
            nextRefreshToken: legitimate,
            ...(await challenge()),
          },
        })
      ).statusCode,
    ).toBe(200);

    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: 'https://localhost' },
      payload: {
        refreshToken: spentToken,
        nextRefreshToken: randomBytes(48).toString('base64url'),
        ...(await challenge()),
      },
    });
    expect(stolen.statusCode).toBe(401);
    expect((stolen.json() as { code: string }).code).toBe('AUTH_SESSION_REVOKED');

    const victim = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: 'https://localhost' },
      payload: {
        refreshToken: legitimate,
        nextRefreshToken: randomBytes(48).toString('base64url'),
        ...(await challenge()),
      },
    });
    expect(victim.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an expired native challenge without pretending the session died', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-challenge';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: 'https://localhost' },
      payload: { refreshToken: 'anything', nativeChallenge: uuidv7() },
    });
    expect(rejected.statusCode).toBe(403);
    expect((rejected.json() as { code: string }).code).toBe('AUTH_CHALLENGE_INVALID');
    await app.close();
  });

  it('never exposes private user fields or trusts a forged native header', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-public-dto';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'public-user', password: 'correct horse battery staple' },
    });
    const browserLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-client-platform': 'electron' },
      payload: { username: 'public-user', password: 'correct horse battery staple' },
    });
    expect(browserLogin.statusCode).toBe(200);
    expect(browserLogin.json()).not.toHaveProperty('refreshToken');
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/native/challenge',
      headers: { origin: 'https://localhost' },
    });
    const sameOriginChallenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/native/challenge',
      headers: { origin: 'https://localhost', 'sec-fetch-site': 'same-origin' },
    });
    // A browser forging the native header is refused at the exchange step (403),
    // which is deliberately not a session revocation (401) so clients keep their
    // stored credential.
    expect(sameOriginChallenge.statusCode).toBe(403);
    expect((sameOriginChallenge.json() as { code: string }).code).toBe('AUTH_CHALLENGE_INVALID');
    const nativeLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://localhost' },
      payload: {
        username: 'public-user',
        password: 'correct horse battery staple',
        nativeChallenge: (challenge.json() as { challenge: string }).challenge,
      },
    });
    const nativeBody = nativeLogin.json() as { accessToken: string; refreshToken: string };
    expect(nativeBody.refreshToken).toEqual(expect.any(String));
    const replayedChallengeLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://localhost' },
      payload: {
        username: 'public-user',
        password: 'correct horse battery staple',
        nativeChallenge: (challenge.json() as { challenge: string }).challenge,
      },
    });
    // The consumed challenge cannot be replayed for a second session, and the
    // answer is an exchange failure rather than a revoked session.
    expect(replayedChallengeLogin.statusCode).toBe(403);
    expect((replayedChallengeLogin.json() as { code: string }).code).toBe('AUTH_CHALLENGE_INVALID');
    expect(replayedChallengeLogin.json()).not.toHaveProperty('refreshToken');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${nativeBody.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const serialized = JSON.stringify(me.json());
    for (const secret of [
      'passwordHash',
      'password_hash',
      'nextMiscTaskNumber',
      'next_misc_task_number',
      'tokenHash',
      'token_hash',
      'replacedById',
      'replaced_by_id',
    ])
      expect(serialized).not.toContain(secret);
    const removedTicketEndpoint = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/ws-ticket',
      headers: { authorization: `Bearer ${nativeBody.accessToken}` },
      payload: {},
    });
    expect(removedTicketEndpoint.statusCode).toBe(404);
    await app.close();
  });

  it('authenticates WebSocket connections with the first message only', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-websocket';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'ws-user', password: 'correct horse battery staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ws-user', password: 'correct horse battery staple' },
    });
    const { accessToken } = login.json() as { accessToken: string };
    await app.ready();

    const queryOnly = await app.injectWS(
      `/api/v1/ws?accessToken=${encodeURIComponent(accessToken)}`,
    );
    const queryClose = new Promise<number>((resolve) =>
      queryOnly.once('close', (code) => resolve(code)),
    );
    queryOnly.send(JSON.stringify({ type: 'ping' }));
    expect(await queryClose).toBe(1008);

    const authenticated = await app.injectWS('/api/v1/ws');
    const ready = new Promise<string>((resolve) =>
      authenticated.once('message', (message) => resolve(message.toString())),
    );
    authenticated.send(JSON.stringify({ type: 'auth', accessToken }));
    expect(JSON.parse(await ready)).toEqual({ type: 'ready', protocolVersion: 1 });
    authenticated.terminate();
    await app.close();
  });

  it('authenticates v2 WebSocket connections with the first message only', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-v2-websocket';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'v2-ws-user', password: 'correct horse battery staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'v2-ws-user', password: 'correct horse battery staple' },
    });
    const { accessToken } = login.json() as { accessToken: string };
    await app.ready();

    const queryOnly = await app.injectWS(
      `/api/v2/ws?accessToken=${encodeURIComponent(accessToken)}`,
    );
    const queryClose = new Promise<number>((resolve) =>
      queryOnly.once('close', (code) => resolve(code)),
    );
    queryOnly.send(JSON.stringify({ type: 'ping' }));
    expect(await queryClose).toBe(1008);

    const authenticated = await app.injectWS('/api/v2/ws');
    const ready = new Promise<string>((resolve) =>
      authenticated.once('message', (message) => resolve(message.toString())),
    );
    authenticated.send(JSON.stringify({ type: 'auth', accessToken }));
    expect(JSON.parse(await ready)).toEqual({ type: 'ready', protocolVersion: 2 });
    authenticated.terminate();
    await app.close();
  });

  it('replays HTTP creates with the same idempotency key without new entities', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-idempotency';
    const { app, store } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'idempotency-user', password: 'correct horse battery staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'idempotency-user', password: 'correct horse battery staple' },
    });
    const { accessToken, user } = login.json() as { accessToken: string; user: { id: string } };
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name: 'Retry-safe', taskPrefix: 'RETRY' },
    });
    expect(first.statusCode).toBe(409);
    expect(first.json().code).toBe('CLIENT_UPGRADE_REQUIRED');

    const project = store.createProject(user.id, 'Retry-safe', 'RETRY');
    const task = store.createTask(user.id, {
      projectId: project.id,
      category: 'FEATURE',
      title: 'rollover retry',
      priority: 'NONE',
    });
    const date = await app.inject({
      method: 'POST',
      url: '/api/v1/time-points/date',
      headers: { ...headers, 'idempotency-key': uuidv7() },
      payload: { localDate: '2026-09-04' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/placements',
      headers: { ...headers, 'idempotency-key': uuidv7() },
      payload: {
        taskId: task.id,
        timePointId: (date.json() as { id: string }).id,
      },
    });
    const rolloverHeaders = { ...headers, 'idempotency-key': uuidv7() };
    const rolloverPayload = {
      method: 'POST' as const,
      url: '/api/v1/dates/2026-09-04/rollover',
      headers: rolloverHeaders,
      payload: {},
    };
    const firstRollover = await app.inject(rolloverPayload);
    const secondRollover = await app.inject(rolloverPayload);
    expect(firstRollover.statusCode).toBe(200);
    expect(secondRollover.statusCode).toBe(200);
    expect(secondRollover.json()).toEqual(firstRollover.json());
    expect(store.state.rollovers.size).toBe(1);
    expect(store.state.placements.size).toBe(2);
    await app.close();
  });

  it('limits repeated login attempts without disclosing account state', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-789';
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'rate-user', password: 'correct horse battery staple' },
    });
    const responses = await Promise.all(
      Array.from({ length: 11 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'rate-user', password: 'wrong password' },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(10);
    await app.close();
  });

  it('returns stable keyset pages for owner-scoped lists', async () => {
    const token = 'test-bootstrap-token-that-is-long-enough-pagination';
    const { app, store } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/bootstrap',
      payload: { token, username: 'pagination-user', password: 'correct horse battery staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'pagination-user', password: 'correct horse battery staple' },
    });
    const { accessToken, user } = login.json() as { accessToken: string; user: { id: string } };
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    for (const name of ['Page A', 'Page B', 'Page C']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: headers(),
        payload: { name, taskPrefix: name.replace('Page ', 'PG') },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('CLIENT_UPGRADE_REQUIRED');
      store.createProject(user.id, name, name.replace('Page ', 'PG'));
    }
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=2',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const firstBody = first.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(first.statusCode).toBe(200);
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/projects?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const secondBody = second.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(second.statusCode).toBe(200);
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
    expect(new Set([...firstBody.items, ...secondBody.items])).toHaveProperty('size', 3);
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?cursor=not-a-cursor',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(store.state.projects.size).toBe(3);
    await app.close();
  });
});
