-- Keep v1 and v2 change-feed contracts in one durable sequence without
-- allowing a client to decode the other protocol's snapshot shape.
ALTER TABLE sync_changes
  ADD COLUMN IF NOT EXISTS protocol_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE sync_changes
  DROP CONSTRAINT IF EXISTS sync_changes_protocol_version_ck;
ALTER TABLE sync_changes
  ADD CONSTRAINT sync_changes_protocol_version_ck CHECK (protocol_version IN (1, 2));

CREATE INDEX IF NOT EXISTS sync_changes_protocol_owner_seq_idx
  ON sync_changes(protocol_version, owner_id, seq);
