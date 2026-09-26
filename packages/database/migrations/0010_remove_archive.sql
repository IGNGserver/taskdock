-- Remove the archive mechanism entirely. Archived rows are treated as deleted:
-- their archived_at timestamp is promoted to deleted_at so any historical
-- archive data disappears from listings without silently resurrecting it.
-- The archive_operations cascade bookkeeping is dropped together with the
-- archived_by_operation_id columns and every archived_at column/index.

-- Promote archived rows to soft-deleted before dropping the columns.
UPDATE folders
SET deleted_at = COALESCE(archived_at, deleted_at),
    updated_at = now()
WHERE archived_at IS NOT NULL AND deleted_at IS NULL;

UPDATE tasks
SET deleted_at = COALESCE(archived_at, deleted_at),
    updated_at = now()
WHERE archived_at IS NOT NULL AND deleted_at IS NULL;

UPDATE time_points
SET deleted_at = COALESCE(archived_at, deleted_at),
    updated_at = now()
WHERE archived_at IS NOT NULL AND deleted_at IS NULL;

UPDATE workflows
SET deleted_at = COALESCE(archived_at, deleted_at),
    updated_at = now()
WHERE archived_at IS NOT NULL AND deleted_at IS NULL;

-- Drop foreign keys that reference archive_operations before dropping the table.
ALTER TABLE folders
  DROP CONSTRAINT IF EXISTS folders_owner_archive_operation_fk;
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_owner_archive_operation_fk;
ALTER TABLE archive_operations
  DROP CONSTRAINT IF EXISTS archive_operations_owner_root_folder_fk;

DROP TABLE IF EXISTS archive_operations;

-- Archived placements can only exist behind archived tasks/time points, which
-- are now soft-deleted; nothing to promote here. Drop helper columns and
-- indexes that reference archived_at.
DROP INDEX IF EXISTS folders_owner_parent_active_rank_idx;
DROP INDEX IF EXISTS tasks_owner_project_category_idx;
DROP INDEX IF EXISTS time_points_owner_event_state_idx;
DROP INDEX IF EXISTS workflows_owner_active_rank_idx;
DROP INDEX IF EXISTS projects_owner_archived_rank_idx;

ALTER TABLE folders DROP COLUMN IF EXISTS archived_at;
ALTER TABLE folders DROP COLUMN IF EXISTS archived_by_operation_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS archived_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS archived_by_operation_id;
ALTER TABLE time_points DROP COLUMN IF EXISTS archived_at;
ALTER TABLE workflows DROP COLUMN IF EXISTS archived_at;
ALTER TABLE projects DROP COLUMN IF EXISTS archived_at;

-- Recreate the listing indexes on soft-delete state instead of archived_at.
CREATE INDEX IF NOT EXISTS folders_owner_parent_active_rank_idx
  ON folders(owner_id, parent_folder_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_owner_project_category_idx
  ON tasks(owner_id, project_id, category, status, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS time_points_owner_event_state_idx
  ON time_points(owner_id, type, reached_at, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS workflows_owner_active_rank_idx
  ON workflows(owner_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS projects_owner_rank_idx
  ON projects(owner_id, rank, id)
  WHERE deleted_at IS NULL;
