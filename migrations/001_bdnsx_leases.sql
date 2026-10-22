-- bDNSX index cache (Hetzner self-hosted Supabase). NOT RUN YET: review, then apply via /migration.
-- The chain is the source of truth; these tables can be rebuilt from bdnsx records.

BEGIN;

CREATE TABLE IF NOT EXISTS bdnsx_leases (
  name           text PRIMARY KEY,
  renter_key     text NOT NULL CHECK (renter_key ~ '^0[23][0-9a-f]{64}$'),
  lease_from     timestamptz NOT NULL,
  lease_until    timestamptz NOT NULL,
  annual_usd     numeric(12,2) NOT NULL CHECK (annual_usd >= 0),
  price_set_at   timestamptz NOT NULL,
  record_txid    text NOT NULL,           -- latest record (lease/renew/transfer/revoke)
  dry_run        boolean NOT NULL DEFAULT true,
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (lease_until > lease_from)
);
CREATE INDEX IF NOT EXISTS bdnsx_leases_renter_idx ON bdnsx_leases (renter_key);
CREATE INDEX IF NOT EXISTS bdnsx_leases_until_idx  ON bdnsx_leases (lease_until);

-- Every published record, in order, so a lease's history is auditable without the chain.
CREATE TABLE IF NOT EXISTS bdnsx_records (
  txid        text PRIMARY KEY,
  name        text,
  type        text NOT NULL CHECK (type IN ('lease','renew','transfer','link','revoke')),
  prev_txid   text,
  fields      jsonb NOT NULL,
  aip_address text NOT NULL,
  aip_sig     text NOT NULL,
  dry_run     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bdnsx_records_name_idx ON bdnsx_records (name, created_at);

-- Each payment txid can buy one lease or renewal.
CREATE TABLE IF NOT EXISTS bdnsx_payments (
  txid       text PRIMARY KEY CHECK (txid ~ '^[0-9a-f]{64}$'),
  name       text NOT NULL,
  sats       bigint,
  used_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bdnsx_links (
  domain      text PRIMARY KEY,
  key         text NOT NULL CHECK (key ~ '^0[23][0-9a-f]{64}$'),
  name        text,
  site        text,
  record_txid text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bdnsx_links_key_idx ON bdnsx_links (key);

-- Pricing state: adoption high-water multiplier (never decreases automatically).
CREATE TABLE IF NOT EXISTS bdnsx_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO bdnsx_meta (key, value) VALUES ('adoption_high_water', '1'::jsonb) ON CONFLICT DO NOTHING;

-- Service-only tables: no anon/authenticated access. The service connects with its own role.
ALTER TABLE bdnsx_leases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdnsx_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdnsx_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdnsx_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdnsx_meta     ENABLE ROW LEVEL SECURITY;

COMMIT;
