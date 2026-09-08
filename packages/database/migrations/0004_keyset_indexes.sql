-- Cover the owner-scoped keyset predicates and tie-breakers used by the API.
-- Partial indexes keep tombstones out of the hot list paths.
CREATE INDEX IF NOT EXISTS projects_owner_rank_keyset_idx
  ON projects(owner_id, archived_at, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_owner_rank_keyset_idx
  ON tasks(owner_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS time_points_owner_date_keyset_idx
  ON time_points(owner_id, type, local_date, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS time_points_owner_event_rank_keyset_idx
  ON time_points(owner_id, type, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS placements_owner_timepoint_rank_keyset_idx
  ON placements(owner_id, time_point_id, rank, id)
  WHERE deleted_at IS NULL;
