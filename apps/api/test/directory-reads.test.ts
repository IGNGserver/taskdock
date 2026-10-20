import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  decodeDirectoryCursor,
  encodeDirectoryCursor,
  paginateDirectory,
  type TreeItemDto,
} from '@devtodo/contracts';
import { DirectoryReads } from '../src/directory-reads.js';
import { MemoryTreeStore } from '../src/tree-store.js';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';

describe('directory keyset reads', () => {
  it('keeps bigint precision and deterministic kind/id ties across page boundaries', () => {
    const owner = randomUUID();
    const tree = new MemoryTreeStore();
    const folder = tree.createFolder(owner, { title: 'folder', parentFolderId: null });
    const task = tree.createTask(owner, { title: 'task', parentFolderId: null }).task;
    const items: TreeItemDto[] = [
      { kind: 'TASK', task: { ...task, rank: '9007199254740993' } },
      {
        kind: 'FOLDER',
        folder: { ...folder, rank: '9007199254740993' },
        aggregate: {
          status: 'TODO',
          todoCount: 0,
          doneCount: 0,
          inProgressCount: 0,
          totalCount: 0,
        },
      },
      { kind: 'TASK', task: { ...task, id: randomUUID(), rank: '9007199254740992' } },
    ];
    const scope = { owner, parent: null, revision: '1' };
    const first = paginateDirectory(items, scope, 1);
    const second = paginateDirectory(items, scope, 1, first.nextCursor!);
    const third = paginateDirectory(items, scope, 1, second.nextCursor!);
    expect(first.items[0]).toEqual(items[2]);
    expect(second.items[0]?.kind).toBe('FOLDER');
    expect(third.items[0]).toEqual(items[0]);
    expect(third.nextCursor).toBeNull();
  });
  it('walks status groups, mixed kinds, equal ranks and large integer ranks without gaps', async () => {
    const owner = randomUUID();
    const tree = new MemoryTreeStore();
    const folder = tree.createFolder(owner, { title: 'empty', parentFolderId: null });
    const a = tree.createTask(owner, { title: 'todo', parentFolderId: null }).task;
    const b = tree.createTask(owner, { title: 'progress', parentFolderId: null }).task;
    const c = tree.createTask(owner, { title: 'done', parentFolderId: null }).task;
    tree.updateTask(owner, b.id, { status: 'IN_PROGRESS' }, b.version);
    tree.updateTask(owner, c.id, { status: 'DONE' }, c.version);
    const reads = new DirectoryReads(tree);
    const all = await reads.children(owner, null);
    expect(
      all.items.map((item) => (item.kind === 'FOLDER' ? item.folder.id : item.task.id)),
    ).toEqual([b.id, folder.id, a.id, c.id]);
    const rows = [];
    let token: string | undefined;
    do {
      const page = await reads.children(owner, null, 1, token);
      rows.push(...page.items);
      token = page.nextCursor ?? undefined;
    } while (token);
    expect(rows).toEqual(all.items);
    expect((await reads.children(randomUUID(), null, 1)).items).toEqual([]);
  });

  it('rejects malformed, cross-owner, cross-directory and changed-revision cursors', async () => {
    const owner = randomUUID();
    const tree = new MemoryTreeStore();
    tree.createTask(owner, { title: 'a', parentFolderId: null });
    tree.createTask(owner, { title: 'b', parentFolderId: null });
    const reads = new DirectoryReads(tree);
    const first = await reads.children(owner, null, 1);
    await expect(reads.children(owner, null, 1, 'broken')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(reads.children(randomUUID(), null, 1, first.nextCursor!)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(reads.children(owner, randomUUID(), 1, first.nextCursor!)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    tree.createTask(owner, { title: 'new', parentFolderId: null });
    await expect(reads.children(owner, null, 1, first.nextCursor!)).rejects.toMatchObject({
      code: 'SYNC_CURSOR_EXPIRED',
    });
    const invalid = encodeDirectoryCursor({
      owner,
      parent: null,
      revision: '0',
      group: 1,
      rank: '99999999999999999999',
      kind: 'TASK',
      id: randomUUID(),
    });
    expect(() => decodeDirectoryCursor(invalid, { owner, parent: null, revision: '0' })).toThrow(
      '游标无效',
    );
  });

  it('validates HTTP page budgets and retains the unpaged compatibility response', async () => {
    const token = randomUUID();
    const password = randomUUID();
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { bootstrapToken: token, logLevel: 'silent' },
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/v1/bootstrap',
        payload: { token, username: 'directory-owner', password },
      });
      const login = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'directory-owner', password },
        })
      ).json();
      const headers = { authorization: `Bearer ${login.accessToken}` };
      for (const query of [
        'limit=0',
        'limit=201',
        'limit=1.5',
        'cursor=bad',
        'limit=2&cursor=bad',
      ]) {
        expect(
          (await app.inject({ url: `/api/v2/tree/children?${query}`, headers })).statusCode,
        ).toBe(400);
      }
      const response = await app.inject({ url: '/api/v2/tree/children', headers });
      expect(response.json()).toEqual({ items: [], parentFolderId: null, nextCursor: null });
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally {
      await app.close();
    }
  });
});
