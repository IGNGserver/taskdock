-- Lossless v1 -> v2 backfill. Project IDs and Task IDs are intentionally
-- reused so references, notes, placements and offline graphs stay valid.
-- Folders copy the legacy Project rank and Tasks keep their old rank; the
-- Folder-first sibling tiering happens afterwards in 0009_v2_folder_first_rank.
INSERT INTO folders (
  id, owner_id, parent_folder_id, title, rank, version, archived_at,
  created_at, updated_at, deleted_at
)
SELECT id, owner_id, NULL, name, rank, version, archived_at,
       created_at, updated_at, deleted_at
FROM projects
ON CONFLICT (id) DO NOTHING;

UPDATE tasks AS t
SET parent_folder_id = p.id
FROM projects AS p
WHERE t.owner_id = p.owner_id
  AND t.project_id = p.id
  AND t.parent_folder_id IS NULL;

-- A previously archived project becomes one precise archive operation. Tasks
-- that were already archived keep their old archive boundary; only active
-- descendants receive this operation id.
INSERT INTO archive_operations (
  id, owner_id, root_folder_id, root_base_version, folder_count, task_count, created_at
)
SELECT p.id, p.owner_id, p.id, p.version, 1,
       COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.archived_at IS NULL)::integer,
       COALESCE(p.archived_at, now())
FROM projects AS p
LEFT JOIN tasks AS t ON t.owner_id = p.owner_id AND t.project_id = p.id
WHERE p.archived_at IS NOT NULL
GROUP BY p.id, p.owner_id, p.version, p.archived_at
ON CONFLICT (id) DO NOTHING;

UPDATE folders AS f
SET archived_by_operation_id = f.id
WHERE f.archived_at IS NOT NULL
  AND f.archived_by_operation_id IS NULL;

UPDATE tasks AS t
SET archived_by_operation_id = p.id
FROM projects AS p
WHERE t.owner_id = p.owner_id
  AND t.project_id = p.id
  AND p.archived_at IS NOT NULL
  AND t.archived_at IS NULL
  AND t.archived_by_operation_id IS NULL;

UPDATE tasks AS t
SET archived_at = p.archived_at,
    updated_at = GREATEST(t.updated_at, p.archived_at)
FROM projects AS p
WHERE t.owner_id = p.owner_id
  AND t.project_id = p.id
  AND p.archived_at IS NOT NULL
  AND t.archived_at IS NULL
  AND t.deleted_at IS NULL;

-- Keep the global v2 allocator ahead of every existing TASK-N reference.
UPDATE users AS u
SET next_task_number = GREATEST(
  u.next_task_number,
  COALESCE((
    SELECT MAX((substring(t.reference_id from '^TASK-([0-9]+)$'))::integer) + 1
    FROM tasks AS t
    WHERE t.owner_id = u.id AND t.reference_id ~ '^TASK-[0-9]+$'
  ), 1)
);
