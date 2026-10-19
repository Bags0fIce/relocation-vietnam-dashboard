-- Initial self-hosted dashboard schema. Apply only to a new isolated database.
CREATE TABLE IF NOT EXISTS team_members (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  password_hash text,
  role text NOT NULL CHECK (role IN ('owner','general_manager','intern','project_contributor','member')),
  active boolean NOT NULL DEFAULT false,
  finance_access boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT finance_access OR role IN ('owner','general_manager','project_contributor'))
);

CREATE TABLE IF NOT EXISTS workspace_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type text NOT NULL CHECK (record_type IN ('customer','service_track','task','message_thread','message','followup','campaign','improvement','activity')),
  record_key text NOT NULL CHECK (length(trim(record_key)) BETWEEN 1 AND 160),
  customer_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES team_members(user_id) ON DELETE SET NULL,
  updated_by uuid REFERENCES team_members(user_id) ON DELETE SET NULL,
  UNIQUE(record_type, record_key)
);
CREATE INDEX IF NOT EXISTS workspace_records_type_updated_idx ON workspace_records(record_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS workspace_records_customer_idx ON workspace_records(customer_key) WHERE customer_key IS NOT NULL;

-- Kept physically separate; the API must check finance_access on every request.
CREATE TABLE IF NOT EXISTS finance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_key text NOT NULL UNIQUE CHECK (length(trim(record_key)) BETWEEN 1 AND 160),
  customer_key text,
  record_kind text NOT NULL CHECK (record_kind IN ('quote','invoice','payment','expense','commission','other')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES team_members(user_id) ON DELETE SET NULL,
  updated_by uuid REFERENCES team_members(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS finance_records_customer_idx ON finance_records(customer_key) WHERE customer_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES team_members(user_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  auth_mode text NOT NULL DEFAULT 'normal' CHECK (auth_mode IN ('normal','invite','recovery')),
  flow_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry_idx ON dashboard_sessions(expires_at);

CREATE TABLE IF NOT EXISTS team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES team_members(user_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by uuid REFERENCES team_members(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES team_members(user_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE','UPSERT','DELETE','LOGIN','LOGOUT','INVITE','PASSWORD_RESET','PASSWORD_CHANGE')),
  actor_id uuid REFERENCES team_members(user_id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- This schema is intentionally not exposed to a browser role. Application
-- access must go through the API using its private database connection.
