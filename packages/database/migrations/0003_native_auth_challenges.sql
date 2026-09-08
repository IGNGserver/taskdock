CREATE TABLE IF NOT EXISTS native_auth_challenges (
  id UUID PRIMARY KEY,
  origin TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS native_auth_challenges_expiry_idx
  ON native_auth_challenges (expires_at);
