-- Additive indexes only: no business rows, cursors or client queues are rewritten.
-- Parent + status ordering matches the bounded mobile directory preview.
CREATE INDEX tasks_mobile_directory ON tasks
  (owner_id, parent_folder_id, (CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END), rank, id)
  WHERE deleted_at IS NULL;
CREATE INDEX folders_mobile_directory ON folders (owner_id, parent_folder_id, rank, id)
  WHERE deleted_at IS NULL;
CREATE INDEX sync_bootstrap_expiry ON sync_bootstrap_snapshots (expires_at, id);
CREATE INDEX sync_bootstrap_revision ON sync_bootstrap_snapshots (owner_id, cursor, expires_at DESC)
  WHERE page_count > 0;
