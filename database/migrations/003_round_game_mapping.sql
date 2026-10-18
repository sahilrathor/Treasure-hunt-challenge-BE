-- Migration: Add optional mapped game_id to rounds table
ALTER TABLE rounds
ADD COLUMN IF NOT EXISTS game_id uuid REFERENCES games(id) ON DELETE SET NULL;
