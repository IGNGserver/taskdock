-- A database-stable identity separates client caches across Hubs and aliases.
CREATE TABLE hub_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO hub_identity(singleton) VALUES (true);

-- Immutable, bounded-lifetime bootstrap pages survive API restart/replicas.
CREATE TABLE sync_bootstrap_snapshots (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cursor bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  page_count integer NOT NULL
);
CREATE INDEX sync_bootstrap_snapshots_owner_expiry ON sync_bootstrap_snapshots(owner_id, expires_at);
CREATE TABLE sync_bootstrap_pages (
  snapshot_id uuid NOT NULL REFERENCES sync_bootstrap_snapshots(id) ON DELETE CASCADE,
  page integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(snapshot_id, page)
);
