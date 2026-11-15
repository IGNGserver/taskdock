import type { DatabaseDialectName } from '@devtodo/database';

/**
 * Statements whose shape genuinely differs between engines.
 *
 * Everything else lives in the store and is translated by the dialect layer.
 * MySQL has no RETURNING, no jsonb and no FILTER, and JSON_ARRAYAGG does not
 * preserve a derived table's ORDER BY, so these few queries keep two spellings
 * instead of being squeezed into a lowest common denominator.
 */
export const SYNC_PULL_QUERY: Record<DatabaseDialectName, string> = {
  postgres: `WITH owner AS (
     SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL
   ), oldest AS (
     SELECT seq FROM sync_changes WHERE protocol_version = 2 ORDER BY seq LIMIT 1
   ), page AS (
     SELECT seq, owner_id, entity_type, entity_id, entity_version, operation, snapshot, committed_at
     FROM sync_changes
     WHERE owner_id = $1 AND protocol_version = 2 AND seq > $2
     ORDER BY seq LIMIT $3
   )
   SELECT EXISTS(SELECT 1 FROM owner) AS owner_ok,
          (SELECT seq FROM oldest) AS oldest,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'seq', p.seq::text,
              'owner_id', p.owner_id,
              'entity_type', p.entity_type,
              'entity_id', p.entity_id,
              'entity_version', p.entity_version,
              'operation', p.operation,
              'snapshot', p.snapshot,
              'committed_at', p.committed_at
            ) ORDER BY p.seq)
            FROM page p
          ), '[]'::jsonb) AS changes,
          EXISTS(
            SELECT 1 FROM sync_changes
            WHERE owner_id = $1 AND protocol_version = 2
              AND seq > COALESCE((SELECT MAX(seq) FROM page), $2)
            LIMIT 1
          ) AS has_more`,
  mysql: `SELECT
     EXISTS(SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL) AS owner_ok,
     (SELECT seq FROM sync_changes WHERE protocol_version = 2 ORDER BY seq LIMIT 1) AS oldest,
     (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'seq', CAST(p.seq AS CHAR),
        'owner_id', p.owner_id,
        'entity_type', p.entity_type,
        'entity_id', p.entity_id,
        'entity_version', p.entity_version,
        'operation', p.operation,
        'snapshot', p.snapshot,
        'committed_at', DATE_FORMAT(p.committed_at, '%Y-%m-%dT%H:%i:%s.%fZ')
      ))
      FROM (
        SELECT seq, owner_id, entity_type, entity_id, entity_version, operation, snapshot, committed_at
        FROM sync_changes
        WHERE owner_id = $1 AND protocol_version = 2 AND seq > $2
        ORDER BY seq LIMIT $3
      ) AS p) AS changes`,
};

type SnapshotColumn = string | { name: string; asChar?: boolean; timestamp?: boolean };

interface SnapshotCollection {
  key: string;
  table: string;
  alias: string;
  columns: SnapshotColumn[];
}

const RESERVED = new Set(['rank', 'cursor']);

function ident(name: string): string {
  return RESERVED.has(name) ? `\`${name}\`` : name;
}

function columnExpression(alias: string, column: SnapshotColumn): string {
  const spec = typeof column === 'string' ? { name: column } : column;
  const reference = `${alias}.${ident(spec.name)}`;
  if (spec.timestamp) return `DATE_FORMAT(${reference}, '%Y-%m-%dT%H:%i:%s.%fZ')`;
  if (spec.asChar) return `CAST(${reference} AS CHAR)`;
  return reference;
}

/**
 * Column lists for the MySQL owner snapshot. PostgreSQL can turn a row into
 * JSON with `to_jsonb`, MySQL needs every column spelled out; keep this list in
 * step with the migrations (a schema drift test compares it with
 * information_schema).
 */
const SNAPSHOT_COLLECTIONS: SnapshotCollection[] = [
  {
    key: 'folders',
    table: 'folders',
    alias: 'f',
    columns: [
      'id',
      'owner_id',
      'parent_folder_id',
      'title',
      'status',
      { name: 'rank', asChar: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'tasks',
    table: 'tasks',
    alias: 't',
    columns: [
      'id',
      'owner_id',
      'project_id',
      'category',
      'reference_id',
      'title',
      'status',
      'priority',
      { name: 'rank', asChar: true },
      { name: 'completed_at', timestamp: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
      'parent_folder_id',
    ],
  },
  {
    key: 'notes',
    table: 'notes',
    alias: 'n',
    columns: [
      'id',
      'owner_id',
      'task_id',
      'content_markdown',
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'steps',
    table: 'task_steps',
    alias: 'st',
    columns: [
      'id',
      'owner_id',
      'task_id',
      'title',
      'note_markdown',
      'status',
      { name: 'rank', asChar: true },
      { name: 'completed_at', timestamp: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'workflows',
    table: 'workflows',
    alias: 'w',
    columns: [
      'id',
      'owner_id',
      'name',
      { name: 'rank', asChar: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'stages',
    table: 'workflow_stages',
    alias: 'ws',
    columns: [
      'id',
      'owner_id',
      'workflow_id',
      'name',
      { name: 'rank', asChar: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'memberships',
    table: 'workflow_task_memberships',
    alias: 'm',
    columns: [
      'id',
      'owner_id',
      'workflow_id',
      'stage_id',
      'task_id',
      { name: 'rank', asChar: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'time_points',
    table: 'time_points',
    alias: 'p',
    columns: [
      'id',
      'owner_id',
      'type',
      'local_date',
      'title',
      { name: 'rank', asChar: true },
      'version',
      { name: 'reached_at', timestamp: true },
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
  {
    key: 'placements',
    table: 'placements',
    alias: 'pl',
    columns: [
      'id',
      'owner_id',
      'task_id',
      'time_point_id',
      { name: 'rank', asChar: true },
      'version',
      { name: 'created_at', timestamp: true },
      { name: 'updated_at', timestamp: true },
      { name: 'deleted_at', timestamp: true },
    ],
  },
];

const SETTINGS_COLUMNS: SnapshotColumn[] = [
  'owner_id',
  'timezone',
  'week_starts_on',
  'default_capture_target',
  'version',
  { name: 'created_at', timestamp: true },
  { name: 'updated_at', timestamp: true },
  { name: 'deleted_at', timestamp: true },
];

const TASK_COLLECTION = SNAPSHOT_COLLECTIONS.find((collection) => collection.key === 'tasks')!;
const FOLDER_COLLECTION = SNAPSHOT_COLLECTIONS.find((collection) => collection.key === 'folders')!;

/** JSON_OBJECT expression for one folder row. */
export function folderRowJson(alias: string): string {
  return jsonObjectFor(FOLDER_COLLECTION, alias);
}

function jsonObjectFor(collection: SnapshotCollection, alias: string): string {
  return `JSON_OBJECT(${collection.columns
    .map((column) => {
      const name = typeof column === 'string' ? column : column.name;
      return `'${name}', ${columnExpression(alias, column)}`;
    })
    .join(', ')})`;
}

/** JSON_OBJECT expression for one task row, reused by the bootstrap join. */
export function taskRowJson(alias: string): string {
  return jsonObjectFor(TASK_COLLECTION, alias);
}

function mysqlCollectionAggregate(collection: SnapshotCollection): string {
  const pairs = collection.columns
    .map((column) => {
      const name = typeof column === 'string' ? column : column.name;
      return `'${name}', ${columnExpression(collection.alias, column)}`;
    })
    .join(', ');
  return `(SELECT JSON_ARRAYAGG(JSON_OBJECT(${pairs})) FROM ${collection.table} ${collection.alias} WHERE ${collection.alias}.owner_id = $1) AS ${collection.key}`;
}

function mysqlSettingsAggregate(): string {
  const pairs = SETTINGS_COLUMNS.map((column) => {
    const name = typeof column === 'string' ? column : column.name;
    return `'${name}', ${columnExpression('s', column)}`;
  }).join(', ');
  return `(SELECT JSON_OBJECT(${pairs}) FROM user_settings s WHERE s.owner_id = $1) AS settings`;
}

/**
 * One statement loads the whole owner projection. PostgreSQL aggregates with
 * jsonb_agg(to_jsonb(...)); MySQL spells out JSON_OBJECT because there is no
 * row-to-JSON cast. MySQL's JSON_ARRAYAGG does not preserve ORDER BY, so the
 * loader sorts each collection by id after parsing.
 */
export const OWNER_SNAPSHOT_QUERY: Record<DatabaseDialectName, string> = {
  postgres: `SELECT
     (SELECT u.next_task_number FROM users u
      WHERE u.id = $1 AND u.disabled_at IS NULL) AS next_task_number,
     (SELECT COALESCE(MAX(sc.seq), 0)::text FROM sync_changes sc
      WHERE sc.owner_id = $1) AS cursor,
     COALESCE((SELECT jsonb_agg(to_jsonb(f) || jsonb_build_object('rank', f.rank::text) ORDER BY f.id)
               FROM folders f WHERE f.owner_id = $1), '[]'::jsonb) AS folders,
     COALESCE((SELECT jsonb_agg(to_jsonb(t) || jsonb_build_object('rank', t.rank::text) ORDER BY t.id)
               FROM tasks t WHERE t.owner_id = $1), '[]'::jsonb) AS tasks,
     COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id)
               FROM notes n WHERE n.owner_id = $1), '[]'::jsonb) AS notes,
     COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('rank', s.rank::text) ORDER BY s.id)
               FROM task_steps s WHERE s.owner_id = $1), '[]'::jsonb) AS steps,
     COALESCE((SELECT jsonb_agg(to_jsonb(w) || jsonb_build_object('rank', w.rank::text) ORDER BY w.id)
               FROM workflows w WHERE w.owner_id = $1), '[]'::jsonb) AS workflows,
     COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('rank', s.rank::text) ORDER BY s.id)
               FROM workflow_stages s WHERE s.owner_id = $1), '[]'::jsonb) AS stages,
     COALESCE((SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object('rank', m.rank::text) ORDER BY m.id)
               FROM workflow_task_memberships m WHERE m.owner_id = $1), '[]'::jsonb) AS memberships,
     COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('rank', p.rank::text) ORDER BY p.id)
               FROM time_points p WHERE p.owner_id = $1), '[]'::jsonb) AS time_points,
     COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('rank', p.rank::text) ORDER BY p.id)
               FROM placements p WHERE p.owner_id = $1), '[]'::jsonb) AS placements,
     (SELECT to_jsonb(s) FROM user_settings s WHERE s.owner_id = $1) AS settings`,
  mysql: `SELECT
     (SELECT u.next_task_number FROM users u
      WHERE u.id = $1 AND u.disabled_at IS NULL) AS next_task_number,
     (SELECT CAST(COALESCE(MAX(sc.seq), 0) AS CHAR) FROM sync_changes sc
      WHERE sc.owner_id = $1) AS cursor,
     ${SNAPSHOT_COLLECTIONS.map(mysqlCollectionAggregate).join(',\n     ')},
     ${mysqlSettingsAggregate()}`,
};

export interface DirectoryQueryParts {
  parentWhere: string;
  seek: string;
  take: string;
}

/**
 * Bounded directory page. Both engines walk the folder subtree, aggregate the
 * three task counters and materialise one page; only the JSON construction and
 * the FILTER aggregates differ.
 */
export function directoryChildrenQuery(
  dialect: DatabaseDialectName,
  parts: DirectoryQueryParts,
): string {
  const { parentWhere, seek, take } = parts;
  if (dialect === 'mysql')
    return `WITH RECURSIVE branch(root,id) AS (
  SELECT id,id FROM folders WHERE owner_id=$1 AND deleted_at IS NULL AND ${parentWhere}
  UNION
  SELECT b.root,f.id FROM folders f JOIN branch b ON f.parent_folder_id=b.id
  WHERE f.owner_id=$1 AND f.deleted_at IS NULL
), counts AS (
  SELECT b.root, COUNT(t.id) AS total,
    SUM(CASE WHEN t.status='TODO' THEN 1 ELSE 0 END) AS todo,
    SUM(CASE WHEN t.status='IN_PROGRESS' THEN 1 ELSE 0 END) AS progress,
    SUM(CASE WHEN t.status='DONE' THEN 1 ELSE 0 END) AS done
  FROM branch b LEFT JOIN tasks t ON t.owner_id=$1 AND t.parent_folder_id=b.id AND t.deleted_at IS NULL
  GROUP BY b.root
), rows AS (
  SELECT f.id,f.\`rank\` AS r,0 AS k,
    CASE f.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END AS g,
    JSON_OBJECT('status',f.status,
        'todoCount',c.todo,'inProgressCount',c.progress,'doneCount',c.done,'totalCount',c.total) AS aggregate
  FROM folders f JOIN counts c ON c.root=f.id WHERE f.owner_id=$1 AND f.deleted_at IS NULL AND ${parentWhere}
  UNION ALL
  SELECT t.id,t.\`rank\`,1,CASE t.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END,
    NULL
  FROM tasks t WHERE t.owner_id=$1 AND t.deleted_at IS NULL AND ${parentWhere}
), page AS (
  SELECT * FROM rows ${seek} ORDER BY g,r,k,id ${take}
) SELECT CASE p.k WHEN 0 THEN
  JSON_OBJECT('kind','FOLDER','folder',${folderRowJson('f')},'aggregate',p.aggregate)
  ELSE JSON_OBJECT('kind','TASK','task',${taskRowJson('t')}) END AS item
FROM page p
LEFT JOIN folders f ON p.k=0 AND f.owner_id=$1 AND f.id=p.id
LEFT JOIN tasks t ON p.k=1 AND t.owner_id=$1 AND t.id=p.id
ORDER BY p.g,p.r,p.k,p.id`;
  return `WITH RECURSIVE branch(root,id) AS (
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
    CASE f.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END AS g,
    jsonb_build_object('status',f.status,
        'todoCount',c.todo,'inProgressCount',c.progress,'doneCount',c.done,'totalCount',c.total) AS aggregate
  FROM folders f JOIN counts c ON c.root=f.id WHERE f.owner_id=$1 AND f.deleted_at IS NULL AND ${parentWhere}
  UNION ALL
  SELECT t.id,t.rank,1,CASE t.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END,
    NULL::jsonb
  FROM tasks t WHERE t.owner_id=$1 AND t.deleted_at IS NULL AND ${parentWhere}
), page AS MATERIALIZED (
  SELECT * FROM rows ${seek} ORDER BY g,r,k,id ${take}
) SELECT CASE p.k WHEN 0 THEN
  jsonb_build_object('kind','FOLDER','folder',to_jsonb(f) || jsonb_build_object('rank',f.rank::text),'aggregate',p.aggregate)
  ELSE jsonb_build_object('kind','TASK','task',to_jsonb(t) || jsonb_build_object('rank',t.rank::text)) END AS item
FROM page p
LEFT JOIN folders f ON p.k=0 AND f.owner_id=$1 AND f.id=p.id
LEFT JOIN tasks t ON p.k=1 AND t.owner_id=$1 AND t.id=p.id
ORDER BY p.g,p.r,p.k,p.id`;
}

/** Folder ancestry, used to guard moves and to render breadcrumbs. */
export const FOLDER_PATH_QUERY: Record<DatabaseDialectName, string> = {
  postgres: `WITH RECURSIVE parents AS (
    SELECT id,title,parent_folder_id,ARRAY[id] AS visited,0 AS depth FROM folders WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
    UNION ALL SELECT f.id,f.title,f.parent_folder_id,p.visited || f.id,p.depth+1 FROM folders f JOIN parents p ON f.id=p.parent_folder_id
    WHERE f.owner_id=$1 AND f.deleted_at IS NULL AND NOT f.id=ANY(p.visited)
  ) SELECT * FROM parents ORDER BY depth DESC`,
  mysql: `WITH RECURSIVE parents AS (
    SELECT id,title,parent_folder_id,0 AS depth FROM folders WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
    UNION ALL SELECT f.id,f.title,f.parent_folder_id,p.depth+1 FROM folders f JOIN parents p ON f.id=p.parent_folder_id
    WHERE f.owner_id=$1 AND f.deleted_at IS NULL AND p.depth < 100
  ) SELECT * FROM parents ORDER BY depth DESC`,
};
