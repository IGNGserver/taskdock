import {
  decodeDirectoryCursor,
  DirectoryCursorError,
  directoryKey,
  encodeDirectoryCursor,
  paginateDirectory,
  type FolderDto,
  type TreeItemDto,
  type DirectoryPage,
  type TreeTaskDto,
} from '@devtodo/contracts';
import { DomainError } from '@devtodo/domain';
import { PostgresTreeStore } from './postgres-tree-store.js';
import type { V2TreeStore } from './tree-store.js';
import { v2SqlDto as dto } from './v2-sql-dto.js';

function directoryDto(row: Record<string, unknown>, kind: 'FOLDER' | 'TASK') {
  const keys = [
    'id',
    'parent_folder_id',
    'title',
    'rank',
    'version',
    'created_at',
    'updated_at',
    'deleted_at',
    ...(kind === 'TASK' ? ['reference_id', 'status', 'completed_at'] : []),
  ];
  return dto(Object.fromEntries(keys.map((key) => [key, row[key]])));
}

/** All reads here stay owner-scoped and never load notes, steps or relations. */
export class DirectoryReads {
  constructor(private readonly tree: V2TreeStore) {}

  async children(
    owner: string,
    parent: string | null,
    limit?: number,
    token?: string,
  ): Promise<DirectoryPage> {
    try {
      if (!(this.tree instanceof PostgresTreeStore)) {
        await this.tree.prepare?.(owner);
        const items = this.tree.listTreeChildren(owner, parent);
        const revision = (await this.tree.status(owner)).cursor;
        return paginateDirectory(
          items,
          { owner, parent, revision },
          limit ?? Math.max(1, items.length),
          token,
        );
      }
      const pg = this.tree.postgres;
      return await pg.v2ReadSnapshot(async () => {
        // Include legacy writes in invalidation, since they can edit tree rows.
        const version = await pg.v2Query(
          'SELECT COALESCE(MAX(seq), 0)::text AS revision FROM sync_changes WHERE owner_id=$1',
          [owner],
        );
        const scope = { owner, parent, revision: String(version.rows[0]?.revision ?? '0') };
        const after = decodeDirectoryCursor(token, scope);
        const values: unknown[] = parent ? [owner, parent] : [owner];
        const parentWhere = parent ? 'parent_folder_id=$2::uuid' : 'parent_folder_id IS NULL';
        const afterParams = after
          ? [after.group, after.rank, after.kind === 'FOLDER' ? 0 : 1, after.id]
          : [];
        const start = values.length + 1;
        values.push(...afterParams);
        const seek = after
          ? `WHERE (g, r, k, id) > ($${start}::int, $${start + 1}::bigint, $${start + 2}::int, $${start + 3}::uuid)`
          : '';
        const take = limit === undefined ? '' : `LIMIT $${values.push(limit + 1)}::int`;
        const result = await pg.v2Query(
          `WITH RECURSIVE branch(root,id) AS (
          SELECT id,id FROM folders WHERE owner_id=$1 AND deleted_at IS NULL AND ${parentWhere}
          UNION
          SELECT b.root,f.id FROM folders f JOIN branch b ON f.parent_folder_id=b.id
          WHERE f.owner_id=$1 AND f.deleted_at IS NULL
        ), counts AS (
          SELECT b.root, COUNT(t.id)::int AS total,
            COUNT(t.id) FILTER (WHERE t.status='TODO')::int AS todo,
            COUNT(t.id) FILTER (WHERE t.status='IN_PROGRESS')::int AS progress,
            COUNT(t.id) FILTER (WHERE t.status='DONE')::int AS done
          FROM branch b LEFT JOIN tasks t ON t.owner_id=$1 AND t.parent_folder_id=b.id AND t.deleted_at IS NULL
          GROUP BY b.root
        ), rows AS (
          SELECT f.id,f.rank AS r,0 AS k,
            CASE WHEN c.total=0 OR c.todo=c.total THEN 1 WHEN c.done=c.total THEN 2 ELSE 0 END AS g,
            jsonb_build_object('kind','FOLDER','folder',to_jsonb(f) || jsonb_build_object('rank',f.rank::text),
              'aggregate',jsonb_build_object('status',CASE WHEN c.total=0 OR c.todo=c.total THEN 'TODO' WHEN c.done=c.total THEN 'DONE' ELSE 'IN_PROGRESS' END,
                'todoCount',c.todo,'inProgressCount',c.progress,'doneCount',c.done,'totalCount',c.total)) AS item
          FROM folders f JOIN counts c ON c.root=f.id WHERE f.owner_id=$1 AND f.deleted_at IS NULL AND ${parentWhere}
          UNION ALL
          SELECT t.id,t.rank,1,CASE t.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END,
            jsonb_build_object('kind','TASK','task',to_jsonb(t) || jsonb_build_object('rank',t.rank::text))
          FROM tasks t WHERE t.owner_id=$1 AND t.deleted_at IS NULL AND ${parentWhere}
        ) SELECT item FROM rows ${seek} ORDER BY g,r,k,id ${take}`,
          values,
        );
        const items = result.rows.map((row) => {
          const item = row['item'] as Record<string, unknown>;
          return item['kind'] === 'FOLDER'
            ? { ...item, folder: directoryDto(item['folder'] as Record<string, unknown>, 'FOLDER') }
            : { ...item, task: directoryDto(item['task'] as Record<string, unknown>, 'TASK') };
        }) as unknown as TreeItemDto[];
        const page = limit === undefined ? items : items.slice(0, limit);
        return {
          items: page,
          parentFolderId: parent,
          nextCursor:
            limit !== undefined && items.length > limit
              ? encodeDirectoryCursor({ ...scope, ...directoryKey(page.at(-1)!) })
              : null,
        };
      });
    } catch (error) {
      if (error instanceof DirectoryCursorError)
        throw new DomainError(
          error.kind === 'expired' ? 'SYNC_CURSOR_EXPIRED' : 'VALIDATION_FAILED',
          error.message,
          { scope: 'directory' },
        );
      throw error;
    }
  }

  async folders(owner: string): Promise<FolderDto[]> {
    if (!(this.tree instanceof PostgresTreeStore)) {
      await this.tree.prepare?.(owner);
      return this.tree.listFolders(owner);
    }
    const result = await this.tree.postgres.v2Query(
      'SELECT *, rank::text AS rank FROM folders WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY folders.rank,id',
      [owner],
    );
    return result.rows.map((row) => directoryDto(row, 'FOLDER')) as unknown as FolderDto[];
  }

  async task(owner: string, id: string): Promise<{ task: TreeTaskDto }> {
    if (!(this.tree instanceof PostgresTreeStore)) {
      await this.tree.prepare?.(owner);
      return { task: this.tree.getTask(owner, id) };
    }
    const result = await this.tree.postgres.v2Query(
      'SELECT id, reference_id, parent_folder_id, title, status, rank::text, version, completed_at, created_at, updated_at, deleted_at FROM tasks WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL',
      [owner, id],
    );
    if (!result.rows[0]) throw new DomainError('ENTITY_NOT_FOUND', '任务不存在');
    return { task: directoryDto(result.rows[0], 'TASK') as unknown as TreeTaskDto };
  }

  async path(owner: string, id: string): Promise<Array<Pick<FolderDto, 'id' | 'title'>>> {
    if (!(this.tree instanceof PostgresTreeStore)) {
      await this.tree.prepare?.(owner);
      return this.tree.getFolderPath(owner, id);
    }
    return this.tree.postgres.v2ReadSnapshot(async () => {
      const result = await (this.tree as PostgresTreeStore).postgres.v2Query(
        `WITH RECURSIVE parents AS (
        SELECT id,title,parent_folder_id,ARRAY[id] AS visited,0 AS depth FROM folders WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
        UNION ALL SELECT f.id,f.title,f.parent_folder_id,p.visited || f.id,p.depth+1 FROM folders f JOIN parents p ON f.id=p.parent_folder_id
        WHERE f.owner_id=$1 AND f.deleted_at IS NULL AND NOT f.id=ANY(p.visited)
      ) SELECT * FROM parents ORDER BY depth DESC`,
        [owner, id],
      );
      if (!result.rows.length) throw new DomainError('ENTITY_NOT_FOUND', '文件夹不存在');
      if (result.rows[0]?.['parent_folder_id'] !== null)
        throw new DomainError('TREE_CYCLE', '目录路径存在循环或无效父级');
      return result.rows.map((row) => ({ id: String(row['id']), title: String(row['title']) }));
    });
  }
}
