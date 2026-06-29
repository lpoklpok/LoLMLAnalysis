-- Enables idempotent upserts for the daily pipeline.
-- Switching upload_* scripts from delete-all-then-insert to upsert eliminates
-- the dead-tuple churn that blew up disk on 2026-06-{20..29} and tripped
-- PGRST002 "Could not query the database for the schema cache."
--
-- This file holds the ALTER TABLE statements (safe to run as one batch).
-- Disk reclamation lives in 20260629_vacuum_reclaim.sql (must be run one
-- statement at a time — VACUUM cannot run inside a transaction block, which
-- is how the Supabase SQL editor batches statements).

-- game_features: no gameid column (downstream queries key on date+teams), so
-- use the composite that uniquely identifies a game.
alter table public.game_features
  add constraint game_features_natural_key
    unique (date, blue_team, red_team, game_in_series);

-- predictions already has `gameid text PRIMARY KEY` (see
-- supabase_predictions_schema.sql), which is itself a unique constraint —
-- upsert(on_conflict='gameid') uses it directly. No additional constraint.
--
-- player_elos stays on delete-then-insert: the table is small (~hundreds of
-- rows) AND the delete semantics drop retired/inactive players. Upsert would
-- leave stale rows behind.
--
-- player_elo_history already declared `unique (player, gameid)` in
-- 20260529_player_elo_history.sql, so no constraint change needed there.
--
-- upcoming_predictions stays on delete-then-insert: tiny (~tens of rows) and
-- the table semantically *is* the current upcoming-game list; stale rows
-- should disappear when games complete.
