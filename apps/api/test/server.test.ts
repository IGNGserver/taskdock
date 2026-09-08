import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@devtodo/contracts';

import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';

describe('Fastify API', () => {
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
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json() as { id: string };
    const taskResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: {
        projectId: project.id,
        category: 'FEATURE',
        title: '修复移动端连接',
        priority: 'NONE',
      },
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json() as { id: string; referenceId: string; version: number };
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
    expect(completed.statusCode).toBe(200);
    const placements = await app.inject({
      method: 'GET',
      url: `/api/v1/time-points/${eventId}/placements`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(
      (placements.json() as { items: Array<{ task: { status: string } }> }).items[0]?.task.status,
    ).toBe('DONE');
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
    expect(sameOriginChallenge.statusCode).toBe(401);
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
    expect(replayedChallengeLogin.statusCode).toBe(401);
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
    const { accessToken } = login.json() as { accessToken: string };
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
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name: 'Retry-safe', taskPrefix: 'RETRY' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(store.state.projects.size).toBe(1);

    const task = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { ...headers, 'idempotency-key': uuidv7() },
      payload: {
        projectId: (first.json() as { id: string }).id,
        category: 'FEATURE',
        title: 'rollover retry',
        priority: 'NONE',
      },
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
        taskId: (task.json() as { id: string }).id,
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
    const { accessToken } = login.json() as { accessToken: string };
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
      expect(response.statusCode).toBe(201);
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
