CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug citext NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RUNNING', 'PAUSED', 'FINISHED')),
  settings jsonb NOT NULL DEFAULT '{"retryCooldownSeconds":10,"maxAttempts":5}'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code citext NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  member_code citext NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, member_code)
);

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN', 'SUPER_ADMIN')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE,
  participant_id uuid REFERENCES participants(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((participant_id IS NOT NULL)::int + (admin_id IS NOT NULL)::int = 1)
);

CREATE TABLE checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code citext NOT NULL,
  label text NOT NULL,
  qr_token_hash char(64) NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE TABLE rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE RESTRICT,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 8),
  clue text NOT NULL,
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, sequence),
  UNIQUE (event_id, checkpoint_id)
);

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  config jsonb NOT NULL,
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  cooldown_seconds integer NOT NULL DEFAULT 10 CHECK (cooldown_seconds BETWEEN 0 AND 3600),
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (game_id, difficulty)
);

CREATE TABLE team_progress (
  team_id uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  current_sequence smallint NOT NULL DEFAULT 1 CHECK (current_sequence BETWEEN 1 AND 9),
  status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DISQUALIFIED')),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE RESTRICT,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  game_level_id uuid NOT NULL REFERENCES game_levels(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED', 'PASSED', 'CANCELLED')),
  public_challenge jsonb NOT NULL,
  secret_challenge jsonb NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  passed_at timestamptz,
  UNIQUE (team_id, round_id),
  UNIQUE (team_id, game_id)
);

CREATE TABLE game_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES game_assignments(id) ON DELETE RESTRICT,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
  attempt_number smallint NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'passed', 'failed', 'expired', 'abandoned', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  result_metadata jsonb,
  start_idempotency_key text NOT NULL,
  submit_idempotency_key text,
  UNIQUE (assignment_id, participant_id, attempt_number),
  UNIQUE (participant_id, start_idempotency_key),
  UNIQUE (id, submit_idempotency_key)
);

CREATE UNIQUE INDEX one_active_attempt_per_assignment ON game_attempts (assignment_id) WHERE status = 'in_progress';

CREATE TABLE event_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE UNIQUE INDEX one_open_pause_per_event ON event_pauses (event_id) WHERE ended_at IS NULL;

CREATE TABLE admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX participants_team_idx ON participants(team_id);
CREATE INDEX attempts_assignment_idx ON game_attempts(assignment_id, attempt_number);
CREATE INDEX attempts_participant_idx ON game_attempts(participant_id, started_at DESC);
CREATE INDEX assignments_team_idx ON game_assignments(team_id, assigned_at);
CREATE INDEX pauses_event_idx ON event_pauses(event_id, started_at);

CREATE OR REPLACE FUNCTION validate_attempt_membership() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id AND p.team_id = NEW.team_id) THEN
    RAISE EXCEPTION 'attempt participant does not belong to team';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM game_assignments a WHERE a.id = NEW.assignment_id AND a.team_id = NEW.team_id) THEN
    RAISE EXCEPTION 'attempt assignment does not belong to team';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_attempt_membership BEFORE INSERT OR UPDATE OF assignment_id, team_id, participant_id ON game_attempts
FOR EACH ROW EXECUTE FUNCTION validate_attempt_membership();

CREATE OR REPLACE FUNCTION protect_attempt_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.assignment_id <> NEW.assignment_id OR OLD.team_id <> NEW.team_id OR OLD.participant_id <> NEW.participant_id
     OR OLD.attempt_number <> NEW.attempt_number OR OLD.started_at <> NEW.started_at THEN
    RAISE EXCEPTION 'attempt identity and start time are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER immutable_attempt_identity BEFORE UPDATE ON game_attempts
FOR EACH ROW EXECUTE FUNCTION protect_attempt_identity();

CREATE OR REPLACE FUNCTION initialize_team_progress() RETURNS trigger AS $$
BEGIN
  INSERT INTO team_progress(team_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER team_progress_on_registration AFTER INSERT ON teams
FOR EACH ROW EXECUTE FUNCTION initialize_team_progress();
