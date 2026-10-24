CREATE INDEX IF NOT EXISTS sessions_active_participant_idx
  ON sessions(participant_id, created_at DESC)
  WHERE revoked_at IS NULL;
