import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@devtodo/contracts';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';

async function boot() {
  const token = `v2-bootstrap-${uuidv7()}`;
  const { app, store } = await buildServer({
    store: new MemoryStore(),
    config: { webRoot: '/tmp/devtodo-no-web', bootstrapToken: token },
  });
  await app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap',
    payload: { token, username: 'v2-owner', password: 'correct horse battery staple' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'v2-owner', password: 'correct horse battery staple' },
  });
  return {
    app,
    store,
    accessToken: (login.json() as { accessToken: string }).accessToken,
  };
}

describe('TaskDock v2 API and sync protocol', () => {
  it('searches task notes and returns readable placement context in task details', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const taskId = uuidv7();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: taskId, title: '发布版本' },
    });
    expect(created.statusCode).toBe(201);
    const note = created.json().note as { id: string; version: number };
    const updatedNote = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${taskId}/note`,
      headers: headers(),
      payload: {
        contentMarkdown: '上线前检查数据库迁移',
        baseVersion: note.version,
      },
    });
    expect(updatedNote.statusCode).toBe(200);

    const search = await app.inject({
      method: 'GET',
      url: '/api/v2/tasks?q=数据库迁移',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items.map((task: { id: string }) => task.id)).toContain(taskId);

    const date = await app.inject({
      method: 'POST',
      url: '/api/v2/time-points/date',
      headers: headers(),
      payload: { localDate: '2026-09-21' },
    });
    const placement = await app.inject({
      method: 'POST',
      url: '/api/v2/placements',
      headers: headers(),
      payload: { taskId, timePointId: date.json().id },
    });
    expect(placement.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${taskId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().placements[0]).toMatchObject({
      timePoint: { type: 'DATE', localDate: '2026-09-21' },
    });
  });

  it('covers the tree, archive boundary, workflows, steps, placements, deletion preview and protocol gate', async () => {
    const { app, store, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const f1 = uuidv7();
    const f2 = uuidv7();
    const t1 = uuidv7();
    const t2 = uuidv7();

    const rootFolder = await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: f1, title: '根目录' },
    });
    expect(rootFolder.statusCode).toBe(201);
    const childFolder = await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: f2, parentFolderId: f1, title: '子目录' },
    });
    expect(childFolder.statusCode).toBe(201);

    const firstTask = await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: t1, parentFolderId: f1, title: '待处理任务' },
    });
    const secondTask = await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: t2, parentFolderId: f2, title: '已完成任务' },
    });
    expect(firstTask.statusCode).toBe(201);
    expect(secondTask.statusCode).toBe(201);
    const createdTask = firstTask.json() as { task: { version: number; referenceId: string } };
    const createdSecondTask = secondTask.json() as { task: { version: number } };
    expect(createdTask.task.referenceId).toBe('TASK-1');

    const done = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${t2}`,
      headers: headers(),
      payload: { status: 'DONE', baseVersion: createdSecondTask.task.version },
    });
    expect(done.statusCode).toBe(200);

    const rootChildren = await app.inject({
      method: 'GET',
      url: '/api/v2/tree/children?parentFolderId=root',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(rootChildren.statusCode).toBe(200);
    expect(rootChildren.json().items).toHaveLength(1);
    expect(rootChildren.json().items[0].aggregate).toMatchObject({
      status: 'IN_PROGRESS',
      todoCount: 1,
      doneCount: 1,
      totalCount: 2,
    });

    const cycle = await app.inject({
      method: 'POST',
      url: '/api/v2/tree/items/move',
      headers: headers(),
      payload: {
        item: { kind: 'FOLDER', id: f1 },
        parentFolderId: f2,
        expectedStatus: 'IN_PROGRESS',
        baseVersion: 1,
      },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().code).toBe('TREE_CYCLE');

    const archive = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${f1}/archive-tree`,
      headers: headers(),
      payload: { baseVersion: 1 },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json()).toMatchObject({ folderCount: 2, taskCount: 2 });
    const operationId = archive.json().id as string;
    const archivedChildren = await app.inject({
      method: 'GET',
      url: '/api/v2/tree/children?parentFolderId=root',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(archivedChildren.json().items).toEqual([]);

    const restored = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${f1}/restore-tree`,
      headers: headers(),
      payload: { operationId },
    });
    expect(restored.statusCode).toBe(200);
    const restoredTask = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${t2}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(restoredTask.json().task.status).toBe('DONE');

    const step = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${t1}/steps`,
      headers: headers(),
      payload: { title: '独立步骤', noteMarkdown: 'step note' },
    });
    expect(step.statusCode).toBe(201);
    const stepBody = step.json() as { id: string; version: number };
    const stepDone = await app.inject({
      method: 'PATCH',
      url: `/api/v2/task-steps/${stepBody.id}`,
      headers: headers(),
      payload: { status: 'DONE', baseVersion: stepBody.version },
    });
    expect(stepDone.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${t1}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(detail.json().steps[0].status).toBe('DONE');
    expect(detail.json().task.status).toBe('TODO');

    const duplicateTaskId = uuidv7();
    const duplicateNoteId = uuidv7();
    const duplicateStepId = uuidv7();
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${t1}/duplicate`,
      headers: headers(),
      payload: { taskId: duplicateTaskId, noteId: duplicateNoteId, stepIds: [duplicateStepId] },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().task.id).toBe(duplicateTaskId);
    expect(duplicate.json().note.id).toBe(duplicateNoteId);
    expect(duplicate.json().steps[0]).toMatchObject({ id: duplicateStepId, status: 'TODO' });
    const duplicateDetail = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${duplicateTaskId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(duplicateDetail.json()).toMatchObject({ placements: [], workflowMemberships: [] });
    const deletedDuplicate = await app.inject({
      method: 'DELETE',
      url: `/api/v2/tasks/${duplicateTaskId}`,
      headers: headers(),
      payload: { baseVersion: 1 },
    });
    expect(deletedDuplicate.statusCode).toBe(200);
    expect(deletedDuplicate.json().deletedAt).toEqual(expect.any(String));

    const workflow = await app.inject({
      method: 'POST',
      url: '/api/v2/workflows',
      headers: headers(),
      payload: { name: '发布流程' },
    });
    const workflowBody = workflow.json() as { id: string; stages: Array<{ id: string }> };
    const stageId = workflowBody.stages[0]!.id;
    const secondStage = await app.inject({
      method: 'POST',
      url: `/api/v2/workflows/${workflowBody.id}/stages`,
      headers: headers(),
      payload: { name: '验证' },
    });
    expect(secondStage.statusCode).toBe(201);
    const secondStageIdInWorkflow = secondStage.json().id as string;
    const movedStage = await app.inject({
      method: 'POST',
      url: `/api/v2/workflow-stages/${secondStageIdInWorkflow}/move`,
      headers: headers(),
      payload: { beforeId: stageId, baseVersion: 1 },
    });
    expect(movedStage.statusCode).toBe(200);
    const workflowAfterStageMove = await app.inject({
      method: 'GET',
      url: `/api/v2/workflows/${workflowBody.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(workflowAfterStageMove.json().stages.map((stage: { id: string }) => stage.id)).toEqual([
      secondStageIdInWorkflow,
      stageId,
    ]);
    const secondWorkflow = await app.inject({
      method: 'POST',
      url: '/api/v2/workflows',
      headers: headers(),
      payload: { name: '另一个流程' },
    });
    const secondStageId = (secondWorkflow.json() as { stages: Array<{ id: string }> }).stages[0]!
      .id;
    const member = await app.inject({
      method: 'POST',
      url: `/api/v2/workflow-stages/${stageId}/tasks`,
      headers: headers(),
      payload: { taskId: t1 },
    });
    expect(member.statusCode).toBe(201);
    const duplicateMember = await app.inject({
      method: 'POST',
      url: `/api/v2/workflow-stages/${stageId}/tasks`,
      headers: headers(),
      payload: { taskId: t1 },
    });
    expect(duplicateMember.statusCode).toBe(409);
    expect(duplicateMember.json().code).toBe('WORKFLOW_TASK_ALREADY_EXISTS');
    const secondMember = await app.inject({
      method: 'POST',
      url: `/api/v2/workflow-stages/${secondStageId}/tasks`,
      headers: headers(),
      payload: { taskId: t1 },
    });
    expect(secondMember.statusCode).toBe(201);

    const date = await app.inject({
      method: 'POST',
      url: '/api/v2/time-points/date',
      headers: headers(),
      payload: { localDate: '2026-09-13' },
    });
    const event = await app.inject({
      method: 'POST',
      url: '/api/v2/time-points/events',
      headers: headers(),
      payload: { title: '演示事件' },
    });
    const dateId = (date.json() as { id: string }).id;
    const eventId = (event.json() as { id: string }).id;
    for (const timePointId of [dateId, eventId]) {
      const placement = await app.inject({
        method: 'POST',
        url: '/api/v2/placements',
        headers: headers(),
        payload: { taskId: t1, timePointId },
      });
      expect(placement.statusCode).toBe(201);
    }
    const taskPlacements = await app.inject({
      method: 'GET',
      url: `/api/v2/time-points/${eventId}/placements`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(taskPlacements.json().items).toHaveLength(1);

    const preview = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${f1}/delete-preview`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    const previewBody = preview.json() as { confirmationToken: string };
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${t1}`,
      headers: headers(),
      payload: { status: 'IN_PROGRESS', baseVersion: 3 },
    });
    expect(changed.statusCode).toBe(200);
    const staleDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v2/folders/${f1}/tree`,
      headers: headers(),
      payload: { confirmationToken: previewBody.confirmationToken },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json().code).toBe('SUBTREE_CHANGED');

    const protocolOne = await app.inject({
      method: 'POST',
      url: '/api/v2/sync/push',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { protocolVersion: 1, clientId: uuidv7(), mutations: [] },
    });
    expect(protocolOne.statusCode).toBe(400);
    expect(protocolOne.json().code).toBe('SYNC_PROTOCOL_UNSUPPORTED');
    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v2/sync/snapshot',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      folders: expect.any(Array),
      taskSteps: expect.any(Array),
      workflows: expect.any(Array),
      timePoints: expect.any(Array),
      placements: expect.any(Array),
    });
    expect(store.state.tasks.size).toBe(0);
    await app.close();
  });

  it('restores only the entities created by a folder archive operation', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const rootId = uuidv7();
    const childId = uuidv7();
    const taskId = uuidv7();
    const root = await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: rootId, title: '根' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: childId, parentFolderId: rootId, title: '子' },
    });
    const task = await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: taskId, parentFolderId: childId, title: '预先归档' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/archive`,
      headers: headers(),
      payload: { baseVersion: task.json().task.version },
    });
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${rootId}/archive-tree`,
      headers: headers(),
      payload: { baseVersion: root.json().version },
    });
    expect(archived.json()).toMatchObject({ folderCount: 2, taskCount: 0 });
    const restored = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${rootId}/restore-tree`,
      headers: headers(),
      payload: { operationId: archived.json().id },
    });
    expect(restored.statusCode).toBe(200);
    const restoredTask = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${taskId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(restoredTask.json().task.archivedAt).toEqual(expect.any(String));
    await app.close();
  });

  it('rejects moving archived folders or tasks with ENTITY_ARCHIVED', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const folderId = uuidv7();
    const targetFolderId = uuidv7();
    const taskId = uuidv7();

    await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: folderId, title: '待归档目录' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: targetFolderId, title: '目标目录' },
    });
    const taskRes = await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: taskId, parentFolderId: null, title: '待归档任务' },
    });

    // Archive folder and task
    await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${folderId}/archive-tree`,
      headers: headers(),
      payload: { baseVersion: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/archive`,
      headers: headers(),
      payload: { baseVersion: taskRes.json().task.version },
    });

    // Attempt to move archived folder
    const moveFolder = await app.inject({
      method: 'POST',
      url: '/api/v2/tree/items/move',
      headers: headers(),
      payload: {
        item: { kind: 'FOLDER', id: folderId },
        parentFolderId: targetFolderId,
        expectedStatus: 'TODO',
        baseVersion: 2,
      },
    });
    expect(moveFolder.statusCode).toBe(410);
    expect(moveFolder.json().code).toBe('ENTITY_ARCHIVED');

    // Attempt to move archived task
    const moveTask = await app.inject({
      method: 'POST',
      url: '/api/v2/tree/items/move',
      headers: headers(),
      payload: {
        item: { kind: 'TASK', id: taskId },
        parentFolderId: targetFolderId,
        expectedStatus: 'TODO',
        baseVersion: 2,
      },
    });
    expect(moveTask.statusCode).toBe(410);
    expect(moveTask.json().code).toBe('ENTITY_ARCHIVED');

    await app.close();
  });

  it('preserves client-provided defaultStageId on workflow.create', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const workflowId = uuidv7();
    const defaultStageId = uuidv7();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/workflows',
      headers: headers(),
      payload: {
        id: workflowId,
        name: '离线流程',
        defaultStageId,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { stages: Array<{ id: string }> };
    expect(body.stages[0]?.id).toBe(defaultStageId);

    await app.close();
  });

  it('exposes top-level archive operations with counts, nested folders and standalone tasks', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const rootId = uuidv7();
    const childId = uuidv7();
    const keptTaskId = uuidv7();
    const standaloneTaskId = uuidv7();

    const root = await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: rootId, title: '发布' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: childId, parentFolderId: rootId, title: '子目录' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: keptTaskId, parentFolderId: childId, title: '随目录归档' },
    });
    // A task archived before the cascade must stay archived after restore.
    const standalone = await app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: headers(),
      payload: { id: standaloneTaskId, parentFolderId: null, title: '独立归档任务' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${standaloneTaskId}/archive`,
      headers: headers(),
      payload: { baseVersion: standalone.json().task.version },
    });

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${rootId}/archive-tree`,
      headers: headers(),
      payload: { baseVersion: root.json().version },
    });
    expect(archived.json()).toMatchObject({ folderCount: 2, taskCount: 1 });
    const operationId = archived.json().id as string;

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v2/archive-operations',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: operationId,
      rootFolderId: rootId,
      rootFolderTitle: '发布',
      folderCount: 2,
      taskCount: 1,
      descendantFolderCount: 2,
      descendantTaskCount: 1,
    });
    expect((items[0]!.folders as Array<{ id: string }>).map((f) => f.id).sort()).toEqual(
      [childId, rootId].sort(),
    );

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v2/archive-operations/${operationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      tasks: Array<{ id: string }>;
      standaloneArchivedTasks: Array<{ id: string }>;
    };
    expect(body.tasks.map((task) => task.id)).toEqual([keptTaskId]);
    expect(body.standaloneArchivedTasks.map((task) => task.id)).toContain(standaloneTaskId);

    await app.close();
  });

  it('does not list a restored archive operation by default', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const rootId = uuidv7();
    const root = await app.inject({
      method: 'POST',
      url: '/api/v2/folders',
      headers: headers(),
      payload: { id: rootId, title: '可恢复' },
    });
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${rootId}/archive-tree`,
      headers: headers(),
      payload: { baseVersion: root.json().version },
    });
    const operationId = archived.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v2/folders/${rootId}/restore-tree`,
      headers: headers(),
      payload: { operationId },
    });

    const active = await app.inject({
      method: 'GET',
      url: '/api/v2/archive-operations',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(active.json().items).toHaveLength(0);
    const all = await app.inject({
      method: 'GET',
      url: '/api/v2/archive-operations?includeRestored=true',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(all.json().items).toHaveLength(1);
    expect(all.json().items[0].restoredAt).toEqual(expect.any(String));

    await app.close();
  });

  it('rolls an active date forward through v2 and undoes it', async () => {
    const { app, accessToken } = await boot();
    const headers = () => ({
      authorization: `Bearer ${accessToken}`,
      'x-client-id': uuidv7(),
      'idempotency-key': uuidv7(),
    });
    const openTaskId = uuidv7();
    const doneTaskId = uuidv7();

    const date = await app.inject({
      method: 'POST',
      url: '/api/v2/time-points/date',
      headers: headers(),
      payload: { localDate: '2026-09-20' },
    });
    const dateId = date.json().id as string;
    for (const taskId of [openTaskId, doneTaskId])
      await app.inject({
        method: 'POST',
        url: '/api/v2/tasks',
        headers: headers(),
        payload: { id: taskId, parentFolderId: null, title: `任务 ${taskId.slice(0, 4)}` },
      });
    await app.inject({
      method: 'POST',
      url: '/api/v2/placements',
      headers: headers(),
      payload: { taskId: openTaskId, timePointId: dateId },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v2/placements',
      headers: headers(),
      payload: { taskId: doneTaskId, timePointId: dateId },
    });
    const doneTask = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${doneTaskId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${doneTaskId}`,
      headers: headers(),
      payload: { status: 'DONE', baseVersion: doneTask.json().task.version },
    });

    const rolled = await app.inject({
      method: 'POST',
      url: '/api/v2/dates/2026-09-20/rollover',
      headers: headers(),
      payload: {},
    });
    expect(rolled.statusCode).toBe(200);
    const outcome = rolled.json() as {
      createdIds: string[];
      skippedTaskIds: string[];
      targetDate: string;
    };
    // Only the still-open task moves; the DONE task is skipped, never duplicated.
    expect(outcome.targetDate).toBe('2026-09-21');
    expect(outcome.createdIds).toHaveLength(1);
    expect(outcome.skippedTaskIds).toEqual([doneTaskId]);

    const undone = await app.inject({
      method: 'POST',
      url: '/api/v2/rollovers/undo',
      headers: headers(),
      payload: { placementIds: outcome.createdIds },
    });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().removedIds).toEqual(outcome.createdIds);

    await app.close();
  });
});
