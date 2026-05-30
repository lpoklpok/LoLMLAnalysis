-- Server-side ELO history rebuild. Replaces the local Python feature_engineering
-- → upload_player_elo_history.py path so the table stays fresh from the games
-- table directly, with no dependency on local CSV freshness.
--
-- Production ELO logic (from src/feature_engineering.py):
--   * K_FACTOR = 48
--   * SERIES_K_ALPHA = 0.3 (scales K for year >= 2025)
--   * ELO_SCALE = 400 (Elo logistic)
--   * Decay, split-reset, patch-reset, transfer-reset are all OFF in production
--   * Per-league starting Elo (_ELO_TIER)
--
-- So the simulation reduces to: walk games chronologically, for each game
-- average the 5 players' Elo on each side, compute expected, update each
-- player by K * k_scale * (actual - expected), and snapshot.

create or replace function public.starting_elo(p_league text)
returns numeric
language sql
immutable
as $$
  select case p_league
    when 'LCK'   then 1620
    when 'LPL'   then 1620
    when 'LEC'   then 1500
    when 'LCS'   then 1380
    when 'LTA'   then 1380
    when 'LTA N' then 1380
    when 'LTA S' then 1380
    when 'LCKC'  then 1380
    else 1260
  end::numeric
$$;


-- Full rebuild: truncates player_elo_history and replays every game from the
-- games table chronologically. Returns the number of snapshots inserted.
-- Idempotent. Safe to call as often as desired.
create or replace function public.rebuild_player_elo_history()
returns bigint
language plpgsql
as $$
declare
  K_FACTOR        constant numeric := 48;
  ELO_SCALE       constant numeric := 400;
  SNAPSHOT_FROM_YEAR constant int := 2024;

  rec record;

  blue_pre   numeric[];   -- pre-game Elo per blue position
  red_pre    numeric[];
  blue_post  numeric[];   -- post-game Elo per blue position
  red_post   numeric[];
  blue_avg   numeric;
  red_avg    numeric;
  k_scale    numeric;
  start_elo  numeric;
  actual_b   numeric;
  expected   numeric;
  positions  constant text[] := array['top','jng','mid','bot','sup'];
  i          int;
  inserted   bigint;
begin
  -- Per-player running Elo state (default = league starting Elo on first sight)
  create temp table _player_elo (
    player text primary key,
    elo    numeric not null
  ) on commit drop;

  -- We accumulate snapshots in a temp table and bulk-insert at the end.
  -- Bulk insert is dramatically faster than per-row INSERT inside the loop.
  create temp table _new_history (
    player     text,
    gameid     text,
    date       date,
    year       integer,
    league     text,
    pos        text,
    team       text,
    opp_team   text,
    elo_before numeric,
    elo_after  numeric,
    won        smallint
  ) on commit drop;

  for rec in
    select
      g.date::date                  as game_date,
      g.year                        as year,
      g.league                      as league,
      g.gameid::text                as gameid,
      g.blue_team_teamname          as blue_team,
      g.red_team_teamname           as red_team,
      g.blue_team_result            as blue_win,
      array[
        g.blue_top_playername, g.blue_jng_playername, g.blue_mid_playername,
        g.blue_bot_playername, g.blue_sup_playername
      ]                             as bp,
      array[
        g.red_top_playername, g.red_jng_playername, g.red_mid_playername,
        g.red_bot_playername, g.red_sup_playername
      ]                             as rp
    from public.games g
    where g.blue_top_playername is not null
      and g.blue_jng_playername is not null
      and g.blue_mid_playername is not null
      and g.blue_bot_playername is not null
      and g.blue_sup_playername is not null
      and g.red_top_playername  is not null
      and g.red_jng_playername  is not null
      and g.red_mid_playername  is not null
      and g.red_bot_playername  is not null
      and g.red_sup_playername  is not null
      and g.blue_team_result is not null
    order by g.date asc, g.gameid asc
  loop
    start_elo := public.starting_elo(rec.league);
    k_scale   := case when rec.year >= 2025 then 0.3 else 1.0 end;
    actual_b  := rec.blue_win::numeric;

    blue_pre  := array[]::numeric[];
    red_pre   := array[]::numeric[];

    -- Pull pre-game Elo for each of the 10 players
    for i in 1..5 loop
      blue_pre := array_append(
        blue_pre,
        coalesce((select elo from _player_elo where player = rec.bp[i]), start_elo)
      );
      red_pre := array_append(
        red_pre,
        coalesce((select elo from _player_elo where player = rec.rp[i]), start_elo)
      );
    end loop;

    blue_avg := (blue_pre[1] + blue_pre[2] + blue_pre[3] + blue_pre[4] + blue_pre[5]) / 5.0;
    red_avg  := (red_pre[1]  + red_pre[2]  + red_pre[3]  + red_pre[4]  + red_pre[5])  / 5.0;

    -- Update Elo for each player. The "expected" uses the OPPONENT TEAM
    -- average vs the INDIVIDUAL player's Elo, mirroring _update_players in
    -- feature_engineering.py (not the team-vs-team expected).
    blue_post := array[]::numeric[];
    red_post  := array[]::numeric[];

    for i in 1..5 loop
      expected := 1.0 / (1.0 + power(10.0::numeric, (red_avg - blue_pre[i]) / ELO_SCALE));
      blue_post := array_append(
        blue_post,
        blue_pre[i] + K_FACTOR * k_scale * (actual_b - expected)
      );

      expected := 1.0 / (1.0 + power(10.0::numeric, (blue_avg - red_pre[i]) / ELO_SCALE));
      red_post := array_append(
        red_post,
        red_pre[i] + K_FACTOR * k_scale * ((1.0 - actual_b) - expected)
      );
    end loop;

    -- Commit Elo updates to running state
    for i in 1..5 loop
      insert into _player_elo (player, elo) values (rec.bp[i], blue_post[i])
        on conflict (player) do update set elo = excluded.elo;
      insert into _player_elo (player, elo) values (rec.rp[i], red_post[i])
        on conflict (player) do update set elo = excluded.elo;
    end loop;

    -- Snapshot for the period we serve to the page
    if rec.year >= SNAPSHOT_FROM_YEAR then
      for i in 1..5 loop
        insert into _new_history values (
          rec.bp[i], rec.gameid, rec.game_date, rec.year, rec.league,
          positions[i], rec.blue_team, rec.red_team,
          round(blue_pre[i]::numeric, 1), round(blue_post[i]::numeric, 1),
          rec.blue_win
        );
        insert into _new_history values (
          rec.rp[i], rec.gameid, rec.game_date, rec.year, rec.league,
          positions[i], rec.red_team, rec.blue_team,
          round(red_pre[i]::numeric, 1), round(red_post[i]::numeric, 1),
          (1 - rec.blue_win)::smallint
        );
      end loop;
    end if;
  end loop;

  -- Swap into the live table in one transaction
  truncate table public.player_elo_history restart identity;
  insert into public.player_elo_history
    (player, gameid, date, year, league, pos, team, opp_team, elo_before, elo_after, won)
  select player, gameid, date, year, league, pos, team, opp_team, elo_before, elo_after, won
  from _new_history;

  select count(*) into inserted from public.player_elo_history;
  return inserted;
end;
$$;
