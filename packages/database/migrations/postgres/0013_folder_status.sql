-- Folders own an explicit three-state workflow status (default TODO)
-- independent of descendant task progress counts.
ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'TODO',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE folders
  DROP CONSTRAINT IF EXISTS folders_status_ck;

ALTER TABLE folders
  ADD CONSTRAINT folders_status_ck CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE'));

DROP INDEX IF EXISTS folders_mobile_directory;
CREATE INDEX folders_mobile_directory ON folders
  (owner_id, parent_folder_id, (CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END), rank, id)
  WHERE deleted_at IS NULL;
