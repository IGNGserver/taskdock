-- TaskDock v2 additive structure. Legacy Project columns remain until the
-- backfill and a later, explicitly approved cleanup migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS next_task_number INTEGER;
UPDATE users
SET next_task_number = GREATEST(
  1,
  COALESCE((
    SELECT MAX((substring(reference_id from '^TASK-([0-9]+)$'))::integer) + 1
    FROM tasks
    WHERE tasks.owner_id = users.id
      AND reference_id ~ '^TASK-[0-9]+$'
  ), 1)
)
WHERE next_task_number IS NULL;
ALTER TABLE users ALTER COLUMN next_task_number SET DEFAULT 1;
ALTER TABLE users ALTER COLUMN next_task_number SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_next_task_number_ck;
ALTER TABLE users ADD CONSTRAINT users_next_task_number_ck CHECK (next_task_number > 0);

CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_folder_id UUID,
  title VARCHAR(160) NOT NULL CHECK (length(btrim(title)) > 0),
  rank BIGINT NOT NULL DEFAULT 1024,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at TIMESTAMPTZ,
  archived_by_operation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT folders_owner_id_uq UNIQUE (owner_id, id),
  CONSTRAINT folders_not_self_parent_ck CHECK (parent_folder_id IS NULL OR parent_folder_id <> id)
);
CREATE INDEX IF NOT EXISTS folders_owner_parent_active_rank_idx
  ON folders(owner_id, parent_folder_id, archived_at, rank, id)
  WHERE deleted_at IS NULL;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_folder_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_by_operation_id UUID;
CREATE INDEX IF NOT EXISTS tasks_owner_parent_active_rank_idx
  ON tasks(owner_id, parent_folder_id, archived_at, status, rank, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS archive_operations (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_folder_id UUID NOT NULL,
  root_base_version INTEGER NOT NULL,
  folder_count INTEGER NOT NULL CHECK (folder_count >= 0),
  task_count INTEGER NOT NULL CHECK (task_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ,
  CONSTRAINT archive_operations_owner_id_uq UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS archive_operations_owner_root_idx
  ON archive_operations(owner_id, root_folder_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_steps (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  title VARCHAR(500) NOT NULL CHECK (length(btrim(title)) > 0),
  note_markdown TEXT NOT NULL DEFAULT '' CHECK (length(note_markdown) <= 1048576),
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  rank BIGINT NOT NULL DEFAULT 1024,
  completed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT task_steps_owner_id_uq UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS task_steps_owner_task_rank_idx
  ON task_steps(owner_id, task_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL CHECK (length(btrim(name)) > 0),
  rank BIGINT NOT NULL DEFAULT 1024,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT workflows_owner_id_uq UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS workflows_owner_active_rank_idx
  ON workflows(owner_id, archived_at, rank, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_stages (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL,
  name VARCHAR(200) NOT NULL CHECK (length(btrim(name)) > 0),
  rank BIGINT NOT NULL DEFAULT 1024,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT workflow_stages_owner_id_uq UNIQUE (owner_id, id),
  CONSTRAINT workflow_stages_owner_workflow_id_uq UNIQUE (owner_id, workflow_id, id)
);
CREATE INDEX IF NOT EXISTS workflow_stages_owner_workflow_rank_idx
  ON workflow_stages(owner_id, workflow_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_task_memberships (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL,
  stage_id UUID NOT NULL,
  task_id UUID NOT NULL,
  rank BIGINT NOT NULL DEFAULT 1024,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT workflow_task_memberships_owner_id_uq UNIQUE (owner_id, id),
  CONSTRAINT workflow_task_memberships_active_task_uq UNIQUE (owner_id, workflow_id, task_id)
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS workflow_memberships_owner_stage_rank_idx
  ON workflow_task_memberships(owner_id, stage_id, rank, id)
  WHERE deleted_at IS NULL;
