-- TaskDock MySQL 8.4 baseline: the consolidated schema of PostgreSQL
-- migrations 0001..0013. A new MySQL hub starts here; later schema changes
-- ship one file per engine with the same version number.
--
-- Structural differences from PostgreSQL, all deliberate:
--   * partial unique indexes become STORED generated columns whose value is
--     NULL once the row is soft-deleted (a unique index ignores NULLs), so a
--     live row and any number of tombstones can coexist;
--   * partial (non-unique) indexes become full indexes; tombstones stay in the
--     index and cost a little space;
--   * trigram GIN indexes have no MySQL equivalent, so search stays a
--     LIKE '%term%' scan bounded by owner_id;
--   * `rank` and `cursor` are reserved words and are always backticked;
--   * every child foreign key cascades on delete, so removing an Owner is one
--     statement regardless of the order MySQL walks the cascade graph; the
--     application itself only soft-deletes;
--   * timestamps are DATETIME(6) in UTC (the session time zone is pinned to
--     +00:00 by the driver), JSON replaces jsonb.

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_misc_task_number INT NOT NULL DEFAULT 1,
  next_task_number INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  disabled_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY users_username_uq (username),
  CONSTRAINT users_next_misc_task_number_ck CHECK (next_misc_task_number > 0),
  CONSTRAINT users_next_task_number_ck CHECK (next_task_number > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS user_settings (
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'Asia/Shanghai',
  week_starts_on SMALLINT NOT NULL DEFAULT 1,
  default_capture_target VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ROOT',
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  PRIMARY KEY (owner_id),
  CONSTRAINT user_settings_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_settings_week_starts_on_ck CHECK (week_starts_on IN (0, 1)),
  CONSTRAINT user_settings_default_capture_target_ck CHECK (default_capture_target IN ('ROOT', 'RECENT_FOLDER')),
  CONSTRAINT user_settings_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS projects (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  task_prefix VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_task_number INT NOT NULL DEFAULT 1,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  active_key SMALLINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY projects_owner_id_uq (owner_id, id),
  UNIQUE KEY projects_owner_prefix_uq (owner_id, task_prefix, active_key),
  KEY projects_owner_rank_idx (owner_id, `rank`, id),
  CONSTRAINT projects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT projects_name_ck CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT projects_task_prefix_ck CHECK (REGEXP_LIKE(task_prefix, '^[A-Z][A-Z0-9]{1,9}$', 'c')),
  CONSTRAINT projects_next_task_number_ck CHECK (next_task_number > 0),
  CONSTRAINT projects_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS folders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_folder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  title VARCHAR(160) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'TODO',
  completed_at DATETIME(6) NULL,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY folders_owner_id_uq (owner_id, id),
  KEY folders_owner_parent_rank_idx (owner_id, parent_folder_id, `rank`, id),
  KEY folders_mobile_directory (owner_id, parent_folder_id,
    (CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END), `rank`, id),
  CONSTRAINT folders_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT folders_owner_parent_fk FOREIGN KEY (owner_id, parent_folder_id) REFERENCES folders (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT folders_not_self_parent_ck CHECK (parent_folder_id IS NULL OR parent_folder_id <> id),
  CONSTRAINT folders_status_ck CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  CONSTRAINT folders_title_ck CHECK (CHAR_LENGTH(TRIM(title)) > 0),
  CONSTRAINT folders_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tasks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reference_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(500) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'TODO',
  priority VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'NONE',
  `rank` BIGINT NOT NULL DEFAULT 1024,
  completed_at DATETIME(6) NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  parent_folder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  active_key SMALLINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY tasks_owner_id_uq (owner_id, id),
  UNIQUE KEY tasks_owner_reference_uq (owner_id, reference_id, active_key),
  KEY tasks_owner_rank_idx (owner_id, `rank`, id),
  KEY tasks_owner_project_category_idx (owner_id, project_id, category, status, `rank`, id),
  KEY tasks_owner_parent_rank_idx (owner_id, parent_folder_id, `rank`, id),
  KEY tasks_mobile_directory (owner_id, parent_folder_id,
    (CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END), `rank`, id),
  CONSTRAINT tasks_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT tasks_owner_project_fk FOREIGN KEY (owner_id, project_id) REFERENCES projects (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT tasks_owner_parent_folder_fk FOREIGN KEY (owner_id, parent_folder_id) REFERENCES folders (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT tasks_category_ck CHECK (category IN ('FEATURE', 'MISC')),
  CONSTRAINT tasks_status_ck CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  CONSTRAINT tasks_priority_ck CHECK (priority IN ('NONE', 'LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT tasks_global_category_ck CHECK ((project_id IS NULL AND category = 'MISC') OR project_id IS NOT NULL),
  CONSTRAINT tasks_title_ck CHECK (CHAR_LENGTH(TRIM(title)) > 0),
  CONSTRAINT tasks_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS notes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_markdown MEDIUMTEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  active_key SMALLINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY notes_owner_task_uq (owner_id, task_id, active_key),
  CONSTRAINT notes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT notes_owner_task_fk FOREIGN KEY (owner_id, task_id) REFERENCES tasks (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT notes_content_markdown_ck CHECK (CHAR_LENGTH(content_markdown) <= 1048576),
  CONSTRAINT notes_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS task_steps (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(500) NOT NULL,
  note_markdown MEDIUMTEXT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'TODO',
  `rank` BIGINT NOT NULL DEFAULT 1024,
  completed_at DATETIME(6) NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY task_steps_owner_id_uq (owner_id, id),
  KEY task_steps_owner_task_rank_idx (owner_id, task_id, `rank`, id),
  CONSTRAINT task_steps_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT task_steps_owner_task_fk FOREIGN KEY (owner_id, task_id) REFERENCES tasks (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT task_steps_status_ck CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  CONSTRAINT task_steps_title_ck CHECK (CHAR_LENGTH(TRIM(title)) > 0),
  CONSTRAINT task_steps_note_markdown_ck CHECK (CHAR_LENGTH(note_markdown) <= 1048576),
  CONSTRAINT task_steps_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workflows (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY workflows_owner_id_uq (owner_id, id),
  KEY workflows_owner_rank_idx (owner_id, `rank`, id),
  CONSTRAINT workflows_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT workflows_name_ck CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT workflows_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workflow_stages (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY workflow_stages_owner_id_uq (owner_id, id),
  UNIQUE KEY workflow_stages_owner_workflow_id_uq (owner_id, workflow_id, id),
  KEY workflow_stages_owner_workflow_rank_idx (owner_id, workflow_id, `rank`, id),
  CONSTRAINT workflow_stages_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT workflow_stages_owner_workflow_fk FOREIGN KEY (owner_id, workflow_id) REFERENCES workflows (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_stages_name_ck CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT workflow_stages_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workflow_task_memberships (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  active_key SMALLINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY workflow_task_memberships_owner_id_uq (owner_id, id),
  UNIQUE KEY workflow_memberships_active_task_uq (owner_id, workflow_id, task_id, active_key),
  KEY workflow_memberships_owner_workflow_rank_idx (owner_id, workflow_id, `rank`, id),
  CONSTRAINT workflow_task_memberships_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT workflow_memberships_owner_workflow_fk FOREIGN KEY (owner_id, workflow_id) REFERENCES workflows (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_memberships_owner_stage_fk FOREIGN KEY (owner_id, stage_id) REFERENCES workflow_stages (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_memberships_owner_task_fk FOREIGN KEY (owner_id, task_id) REFERENCES tasks (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_memberships_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS time_points (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  local_date DATE NULL,
  title VARCHAR(200) NULL,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  reached_at DATETIME(6) NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  date_key SMALLINT GENERATED ALWAYS AS (
    IF(type = 'DATE' AND deleted_at IS NULL, 1, NULL)
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY time_points_owner_id_uq (owner_id, id),
  UNIQUE KEY time_points_owner_date_uq (owner_id, local_date, date_key),
  KEY time_points_owner_type_date_idx (owner_id, type, local_date, id),
  KEY time_points_owner_type_rank_idx (owner_id, type, `rank`, id),
  KEY time_points_owner_type_reached_idx (owner_id, type, reached_at, id),
  CONSTRAINT time_points_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT time_points_type_ck CHECK (type IN ('DATE', 'EVENT')),
  CONSTRAINT time_points_shape_ck CHECK (
    (type = 'DATE' AND local_date IS NOT NULL AND title IS NULL) OR
    (type = 'EVENT' AND local_date IS NULL AND title IS NOT NULL AND CHAR_LENGTH(TRIM(title)) > 0)
  ),
  CONSTRAINT time_points_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS placements (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  time_point_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `rank` BIGINT NOT NULL DEFAULT 1024,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  active_key SMALLINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY placements_task_timepoint_active_uq (task_id, time_point_id, active_key),
  KEY placements_owner_timepoint_rank_idx (owner_id, time_point_id, `rank`),
  KEY placements_owner_timepoint_rank_keyset_idx (owner_id, time_point_id, `rank`, id),
  CONSTRAINT placements_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT placements_owner_task_fk FOREIGN KEY (owner_id, task_id) REFERENCES tasks (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT placements_owner_time_point_fk FOREIGN KEY (owner_id, time_point_id) REFERENCES time_points (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT placements_version_ck CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS devices (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  platform VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY devices_owner_id_uq (owner_id, id),
  CONSTRAINT devices_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  replaced_by_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  used_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY refresh_sessions_token_hash_uq (token_hash),
  UNIQUE KEY refresh_sessions_owner_id_uq (owner_id, id),
  CONSTRAINT refresh_sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT refresh_sessions_owner_device_fk FOREIGN KEY (owner_id, device_id) REFERENCES devices (owner_id, id) ON DELETE CASCADE
  -- The PostgreSQL self-reference on (owner_id, replaced_by_id) is omitted:
  -- MySQL cannot SET NULL on a composite key that includes a NOT NULL column,
  -- and a self-referencing cascade would delete the rotated-from session.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS client_mutations (
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mutation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON NOT NULL,
  first_processed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (owner_id, client_id, mutation_id),
  CONSTRAINT client_mutations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sync_changes (
  seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_type VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_version INT NOT NULL,
  operation VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  snapshot JSON NULL,
  committed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  protocol_version SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (seq),
  KEY sync_changes_owner_seq_idx (owner_id, seq),
  KEY sync_changes_protocol_owner_seq_idx (protocol_version, owner_id, seq),
  CONSTRAINT sync_changes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT sync_changes_protocol_version_ck CHECK (protocol_version IN (1, 2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS rollover_operations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_date DATE NOT NULL,
  target_date DATE NOT NULL,
  placement_ids JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  undone_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  CONSTRAINT rollover_operations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS native_auth_challenges (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin VARCHAR(255) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY native_auth_challenges_expiry_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS hub_identity (
  singleton TINYINT(1) NOT NULL DEFAULT 1,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT (UUID()),
  PRIMARY KEY (singleton),
  CONSTRAINT hub_identity_singleton_ck CHECK (singleton = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sync_bootstrap_snapshots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cursor` BIGINT NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  page_count INT NOT NULL,
  PRIMARY KEY (id),
  KEY sync_bootstrap_snapshots_owner_expiry (owner_id, expires_at),
  KEY sync_bootstrap_expiry (expires_at, id),
  KEY sync_bootstrap_revision (owner_id, `cursor`, expires_at),
  CONSTRAINT sync_bootstrap_snapshots_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sync_bootstrap_pages (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page INT NOT NULL,
  payload JSON NOT NULL,
  PRIMARY KEY (snapshot_id, page),
  CONSTRAINT sync_bootstrap_pages_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES sync_bootstrap_snapshots (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO hub_identity (singleton) VALUES (1);
