import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevTodoDatabase } from '@devtodo/sync-client';
import {
  uuidv7,
  type PlacementDto,
  type TimePointDto,
  type TreeTaskDto,
  type WorkflowDto,
} from '@devtodo/contracts';
import { activateLocalCache, deactivateLocalCache, readCachedV2 } from '../src/local.js';

const now = '2026-10-20T00:00:00.000Z';
const metadata = { version: 1, createdAt: now, updatedAt: now };
let db: DevTodoDatabase;

function task(rank: string): TreeTaskDto {
  return {
    ...metadata,
    id: uuidv7(),
    referenceId: 'T-1',
    parentFolderId: null,
    title: 'cached task',
    status: 'TODO',
    rank,
    completedAt: null,
  };
}

function point(): TimePointDto {
  return {
    ...metadata,
    id: uuidv7(),
    type: 'DATE',
    localDate: '2026-10-20',
    title: null,
    rank: '1',
    reachedAt: null,
  };
}

function placement(timePointId: string, taskId: string, rank: string): PlacementDto {
  return { ...metadata, id: uuidv7(), timePointId, taskId, rank };
}

// Match insertion order to IndexedDB's primary-key order for stable equal-rank fixtures.
function orderedId(index: number): string {
  return `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
}

beforeEach(async () => {
  db = new DevTodoDatabase('https://hub.test', uuidv7());
  activateLocalCache(db, uuidv7());
  await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
});

afterEach(async () => {
  deactivateLocalCache(db);
  await db.delete();
});

describe('ranked local cache projections', () => {
  it('sorts placements numerically, preserving equal ranks and full integer precision', async () => {
    const date = point();
    const ranks = ['10', '2', '-2', '-10', '9007199254740993', '9007199254740992', '2'];
    const tasks = ranks.map((_, index) => task(String(100 - index)));
    const placements = ranks.map((rank, index) => ({
      ...placement(date.id, tasks[index]!.id, rank),
      id: orderedId(index),
    }));
    await db.timePoints.put(date);
    await db.tasks.bulkPut(tasks);
    await db.placements.bulkPut(placements);
    const expectedIds = [3, 2, 1, 6, 0, 5, 4].map((index) => placements[index]!.id);

    for (const path of [
      `/time-points/${date.id}/placements`,
      `/today?localDate=${date.localDate}`,
    ]) {
      const result = (await readCachedV2(path)) as { items: PlacementDto[] };
      expect(result.items.map((item) => item.id)).toEqual(expectedIds);
    }
    db.close();
    await db.open();
    const reopened = (await readCachedV2(`/time-points/${date.id}/placements`)) as {
      items: PlacementDto[];
    };
    expect(reopened.items.map((item) => item.id)).toEqual(expectedIds);
  });

  it('excludes deleted placements and deleted or missing tasks from lists and counts', async () => {
    const date = point();
    const open = task('1');
    const done = { ...task('2'), status: 'DONE' as const };
    const deleted = { ...task('3'), deletedAt: now };
    const openPlacement = placement(date.id, open.id, '2');
    const donePlacement = placement(date.id, done.id, '10');
    await db.timePoints.put(date);
    await db.tasks.bulkPut([open, done, deleted]);
    await db.placements.bulkPut([
      openPlacement,
      donePlacement,
      { ...placement(date.id, open.id, '-10'), deletedAt: now },
      placement(date.id, deleted.id, '-2'),
      placement(date.id, uuidv7(), '1'),
      placement(uuidv7(), open.id, '1'),
    ]);

    for (const path of [
      `/time-points/${date.id}/placements`,
      `/today?localDate=${date.localDate}`,
    ]) {
      const result = (await readCachedV2(path)) as { items: PlacementDto[] };
      expect(result.items.map((item) => item.id)).toEqual([openPlacement.id, donePlacement.id]);
    }
    expect(await readCachedV2('/time-points/placement-counts?type=DATE')).toEqual({
      items: [
        {
          timePointId: date.id,
          localDate: date.localDate,
          totalCount: 2,
          openCount: 1,
          doneCount: 1,
        },
      ],
    });
    await db.placements.update(openPlacement.id, { deletedAt: now });
    await db.tasks.update(done.id, { deletedAt: now });
    expect(await readCachedV2(`/time-points/${date.id}/placements`)).toEqual({ items: [] });
    expect(await readCachedV2('/time-points/placement-counts?type=DATE')).toEqual({
      items: [
        {
          timePointId: date.id,
          localDate: date.localDate,
          totalCount: 0,
          openCount: 0,
          doneCount: 0,
        },
      ],
    });
  });

  it('orders workflow tasks by membership rank and retains hidden memberships with a count', async () => {
    const workflow = { ...metadata, id: uuidv7(), name: 'Workflow', rank: '1' };
    const stage = { ...metadata, id: uuidv7(), workflowId: workflow.id, name: 'Stage', rank: '1' };
    const otherStage = { ...stage, id: uuidv7(), name: 'Empty stage', rank: '2' };
    const ranks = ['10', '2', '-2', '9007199254740993', '9007199254740992', '2'];
    const tasks = ranks.map((_, index) => task(String(100 - index)));
    const deleted = { ...task('0'), deletedAt: now };
    const membership = (taskId: string, rank: string) => ({
      ...metadata,
      id: uuidv7(),
      workflowId: workflow.id,
      stageId: stage.id,
      taskId,
      rank,
    });
    const memberships = ranks.map((rank, index) => ({
      ...membership(tasks[index]!.id, rank),
      id: orderedId(index),
    }));
    const hidden = [membership(deleted.id, '-10'), membership(uuidv7(), '-20')];
    await db.workflows.put(workflow);
    await db.workflowStages.bulkPut([stage, otherStage]);
    await db.tasks.bulkPut([...tasks, deleted]);
    await db.workflowTaskMemberships.bulkPut([
      ...memberships,
      ...hidden,
      { ...membership(tasks[0]!.id, '-100'), deletedAt: now },
    ]);

    const result = (await readCachedV2('/workflows')) as { items: WorkflowDto[] };
    const stages = result.items[0]!.stages!;
    const order = [2, 1, 5, 0, 4, 3];
    expect(stages[0]!.tasks.map((item) => item.id)).toEqual(order.map((index) => tasks[index]!.id));
    expect(stages[0]!.memberships?.map((item) => item.id)).toEqual([
      hidden[1]!.id,
      hidden[0]!.id,
      ...order.map((index) => memberships[index]!.id),
    ]);
    expect(stages[0]!.hiddenTaskCount).toBe(2);
    expect(stages[1]).toMatchObject({ tasks: [], memberships: [], hiddenTaskCount: 0 });
  });
});
