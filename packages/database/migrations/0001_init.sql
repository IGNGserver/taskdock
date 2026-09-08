CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  next_misc_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_misc_task_number > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_settings (
  owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  week_starts_on SMALLINT NOT NULL DEFAULT 1 CHECK (week_starts_on IN (0, 1)),
  default_capture_target TEXT NOT NULL DEFAULT 'GLOBAL_MISC' CHECK (default_capture_target IN ('GLOBAL_MISC', 'RECENT_CONTEXT')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL CHECK (length(btrim(name)) > 0),
  task_prefix VARCHAR(10) NOT NULL CHECK (task_prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
  rank BIGINT NOT NULL DEFAULT 1024,
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT projects_owner_id_uq UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_prefix_uq ON projects(owner_id, task_prefix) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_owner_archived_rank_idx ON projects(owner_id, archived_at, rank);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID,
  category TEXT NOT NULL CHECK (category IN ('FEATURE', 'MISC')),
  reference_id VARCHAR(32) NOT NULL,
  title VARCHAR(500) NOT NULL CHECK (length(btrim(title)) > 0),
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  priority TEXT NOT NULL DEFAULT 'NONE' CHECK (priority IN ('NONE', 'LOW', 'MEDIUM', 'HIGH')),
  rank BIGINT NOT NULL DEFAULT 1024,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT tasks_global_category_ck CHECK ((project_id IS NULL AND category = 'MISC') OR project_id IS NOT NULL),
  CONSTRAINT tasks_owner_project_fk FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id),
  CONSTRAINT tasks_owner_id_uq UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_owner_reference_uq ON tasks(owner_id, reference_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_owner_project_category_idx ON tasks(owner_id, project_id, category, archived_at, status, rank);
CREATE INDEX IF NOT EXISTS tasks_title_trgm_idx ON tasks USING gin (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  content_markdown TEXT NOT NULL DEFAULT '' CHECK (length(content_markdown) <= 1048576),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT notes_owner_task_fk FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS notes_owner_task_uq ON notes(owner_id, task_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notes_content_trgm_idx ON notes USING gin (content_markdown gin_trgm_ops);

CREATE TABLE IF NOT EXISTS time_points (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('DATE', 'EVENT')),
  local_date DATE,
  title VARCHAR(200),
  rank BIGINT NOT NULL DEFAULT 1024,
  reached_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT time_points_shape_ck CHECK ((type = 'DATE' AND local_date IS NOT NULL AND title IS NULL) OR (type = 'EVENT' AND local_date IS NULL AND title IS NOT NULL AND length(btrim(title)) > 0)),
  CONSTRAINT time_points_owner_id_uq UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_points_owner_date_uq ON time_points(owner_id, local_date) WHERE type = 'DATE' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS time_points_owner_type_date_idx ON time_points(owner_id, type, local_date);
CREATE INDEX IF NOT EXISTS time_points_owner_event_state_idx ON time_points(owner_id, type, archived_at, reached_at);

CREATE TABLE IF NOT EXISTS placements (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  time_point_id UUID NOT NULL,
  rank BIGINT NOT NULL DEFAULT 1024,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT placements_owner_task_fk FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, id),
  CONSTRAINT placements_owner_time_point_fk FOREIGN KEY (owner_id, time_point_id) REFERENCES time_points(owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS placements_task_timepoint_active_uq ON placements(task_id, time_point_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS placements_owner_timepoint_rank_idx ON placements(owner_id, time_point_id, rank);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  platform VARCHAR(40) NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT devices_owner_id_uq UNIQUE (owner_id, id)
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  replaced_by_id UUID,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refresh_sessions_owner_device_fk FOREIGN KEY (owner_id, device_id) REFERENCES devices(owner_id, id),
  CONSTRAINT refresh_sessions_owner_id_uq UNIQUE (owner_id, id),
  CONSTRAINT refresh_sessions_owner_replaced_by_fk FOREIGN KEY (owner_id, replaced_by_id) REFERENCES refresh_sessions(owner_id, id)
);

CREATE TABLE IF NOT EXISTS client_mutations (
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  mutation_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  first_processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, client_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS sync_changes (
  seq BIGSERIAL PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  entity_version INTEGER NOT NULL,
  operation VARCHAR(20) NOT NULL,
  snapshot JSONB,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_changes_owner_seq_idx ON sync_changes(owner_id, seq);

CREATE TABLE IF NOT EXISTS rollover_operations (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_date DATE NOT NULL,
  target_date DATE NOT NULL,
  placement_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS projects_name_trgm_idx ON projects USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tasks_reference_trgm_idx ON tasks USING gin (reference_id gin_trgm_ops);
