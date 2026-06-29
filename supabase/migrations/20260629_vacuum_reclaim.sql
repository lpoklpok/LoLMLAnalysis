-- Reclaim disk on the five churn tables after the delete-all-then-insert
-- bloat incident of 2026-06-20..2026-06-29.
--
-- IMPORTANT: VACUUM cannot run inside a transaction. The Supabase SQL editor
-- wraps a multi-statement query in a transaction, so paste these ONE AT A
-- TIME. Each one locks its table briefly (ACCESS EXCLUSIVE) — safe while the
-- cron is paused.

vacuum full public.game_features;
vacuum full public.predictions;
vacuum full public.player_elo_history;
vacuum full public.player_elos;
vacuum full public.upcoming_predictions;
