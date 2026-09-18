ALTER TABLE folders
  DROP CONSTRAINT IF EXISTS folders_owner_parent_fk,
  DROP CONSTRAINT IF EXISTS folders_owner_archive_operation_fk;
ALTER TABLE folders
  ADD CONSTRAINT folders_owner_parent_fk
    FOREIGN KEY (owner_id, parent_folder_id) REFERENCES folders(owner_id, id),
  ADD CONSTRAINT folders_owner_archive_operation_fk
    FOREIGN KEY (owner_id, archived_by_operation_id)
    REFERENCES archive_operations(owner_id, id);

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_owner_parent_folder_fk,
  DROP CONSTRAINT IF EXISTS tasks_owner_archive_operation_fk;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_owner_parent_folder_fk
    FOREIGN KEY (owner_id, parent_folder_id) REFERENCES folders(owner_id, id),
  ADD CONSTRAINT tasks_owner_archive_operation_fk
    FOREIGN KEY (owner_id, archived_by_operation_id)
    REFERENCES archive_operations(owner_id, id);

ALTER TABLE archive_operations
  DROP CONSTRAINT IF EXISTS archive_operations_owner_root_folder_fk;
ALTER TABLE archive_operations
  ADD CONSTRAINT archive_operations_owner_root_folder_fk
    FOREIGN KEY (owner_id, root_folder_id) REFERENCES folders(owner_id, id);

ALTER TABLE task_steps
  DROP CONSTRAINT IF EXISTS task_steps_owner_task_fk;
ALTER TABLE task_steps
  ADD CONSTRAINT task_steps_owner_task_fk
    FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, id);

ALTER TABLE workflow_stages
  DROP CONSTRAINT IF EXISTS workflow_stages_owner_workflow_fk;
ALTER TABLE workflow_stages
  ADD CONSTRAINT workflow_stages_owner_workflow_fk
    FOREIGN KEY (owner_id, workflow_id) REFERENCES workflows(owner_id, id);

ALTER TABLE workflow_task_memberships
  DROP CONSTRAINT IF EXISTS workflow_memberships_owner_workflow_fk,
  DROP CONSTRAINT IF EXISTS workflow_memberships_owner_stage_fk,
  DROP CONSTRAINT IF EXISTS workflow_memberships_owner_task_fk;
ALTER TABLE workflow_task_memberships
  ADD CONSTRAINT workflow_memberships_owner_workflow_fk
    FOREIGN KEY (owner_id, workflow_id) REFERENCES workflows(owner_id, id),
  ADD CONSTRAINT workflow_memberships_owner_stage_fk
    FOREIGN KEY (owner_id, stage_id) REFERENCES workflow_stages(owner_id, id),
  ADD CONSTRAINT workflow_memberships_owner_task_fk
    FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, id);

ALTER TABLE workflow_task_memberships
  DROP CONSTRAINT IF EXISTS workflow_task_memberships_active_task_uq;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_memberships_active_task_uq
  ON workflow_task_memberships(owner_id, workflow_id, task_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_owner_parent_folder_idx
  ON tasks(owner_id, parent_folder_id, rank, id)
  WHERE deleted_at IS NULL;

-- Migrate legacy setting values to v2 targets.
-- The v1 CHECK constraint only permits ('GLOBAL_MISC','RECENT_CONTEXT'), so it
-- must be dropped BEFORE rewriting a row to 'ROOT'/'RECENT_FOLDER'; otherwise
-- every existing v1 deployment fails this migration with
-- "violates check constraint user_settings_default_capture_target_check".
ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_default_capture_target_check;

UPDATE user_settings
SET default_capture_target = 'RECENT_FOLDER'
WHERE default_capture_target = 'RECENT_CONTEXT';

UPDATE user_settings
SET default_capture_target = 'ROOT'
WHERE default_capture_target = 'GLOBAL_MISC' OR default_capture_target NOT IN ('ROOT', 'RECENT_FOLDER');

ALTER TABLE user_settings
  ALTER COLUMN default_capture_target SET DEFAULT 'ROOT';

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_default_capture_target_check
  CHECK (default_capture_target IN ('ROOT', 'RECENT_FOLDER'));
