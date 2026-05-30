-- The original get_player_elo_history used `lower(player) = lower(p_player)`,
-- which disables the (player, date) btree index and forces a full table scan
-- of player_elo_history. On a cold cache that pushed past the per-request
-- statement_timeout; on a warm cache it was fast (hence the
-- "fails on click, works on refresh" symptom).
--
-- Player names in the games table are case-consistent, so dropping lower()
-- is safe.

create or replace function public.get_player_elo_history(p_player text)
returns table (
  game_date  date,
  gameid     text,
  league     text,
  pos        text,
  team       text,
  opp_team   text,
  elo_before numeric,
  elo_after  numeric,
  won        smallint
)
language sql
stable
as $$
  select date as game_date, gameid, league, pos, team, opp_team,
         elo_before, elo_after, won
  from public.player_elo_history
  where player = p_player
  order by date asc, gameid asc
$$;
