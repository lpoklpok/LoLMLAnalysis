-- Incremental ELO history refresh. Replaces rebuild_player_elo_history()
-- (which can't complete inside Supabase's 2-minute API gateway timeout for
-- a full replay over 25k+ games) with a much faster incremental pass.
--
-- How it works:
--   1. Seed in-memory state (jsonb of player -> latest Elo) from
--      public.player_elo_history with one query.
--   2. Walk public.games where (date, gameid) > the existing watermark.
--   3. Update state and insert new snapshot rows. ON CONFLICT (player, gameid)
--      DO NOTHING so repeated runs are idempotent.
--
-- Typical run cost: a few hundred new games per day -> ~10-15 seconds.

create or replace function public.refresh_player_elo_history()
returns bigint
language plpgsql
set statement_timeout to '5min'
as $$
declare
  K_FACTOR  constant numeric := 48;
  ELO_SCALE constant numeric := 400;
  SNAPSHOT_FROM_YEAR constant int := 2024;
  POSITIONS constant text[] := array['top','jng','mid','bot','sup'];

  player_elo jsonb;
  cutoff_date date;
  cutoff_gameid text;
  rec record;
  blue_pre numeric[]; red_pre numeric[];
  blue_post numeric[]; red_post numeric[];
  blue_avg numeric; red_avg numeric;
  k_scale numeric; start_elo numeric; actual_b numeric; expected numeric;
  i int;
  inserted int := 0;
begin
  -- Seed in-memory Elo from the latest snapshot per player
  select coalesce(jsonb_object_agg(player, elo_after), '{}'::jsonb) into player_elo
  from (
    select distinct on (player) player, elo_after
    from public.player_elo_history
    order by player, date desc, gameid desc
  ) s;

  -- Watermark for incremental processing. Tie-break on gameid so games on the
  -- same date that come in batches don't get reprocessed.
  select coalesce(max(date), '2014-01-01'::date) into cutoff_date
    from public.player_elo_history;
  select max(gameid) into cutoff_gameid
    from public.player_elo_history where date = cutoff_date;

  for rec in
    select g.date::date as game_date, g.year, g.league, g.gameid::text as gameid,
           g.blue_team_teamname as blue_team, g.red_team_teamname as red_team,
           g.blue_team_result as blue_win,
           array[g.blue_top_playername,g.blue_jng_playername,g.blue_mid_playername,
                 g.blue_bot_playername,g.blue_sup_playername] as bp,
           array[g.red_top_playername,g.red_jng_playername,g.red_mid_playername,
                 g.red_bot_playername,g.red_sup_playername] as rp
    from public.games g
    where g.blue_top_playername is not null and g.blue_jng_playername is not null
      and g.blue_mid_playername is not null and g.blue_bot_playername is not null
      and g.blue_sup_playername is not null and g.red_top_playername is not null
      and g.red_jng_playername is not null and g.red_mid_playername is not null
      and g.red_bot_playername is not null and g.red_sup_playername is not null
      and g.blue_team_result is not null
      and (g.date::date > cutoff_date
           or (g.date::date = cutoff_date and g.gameid::text > coalesce(cutoff_gameid, '')))
    order by g.date asc, g.gameid asc
  loop
    start_elo := public.starting_elo(rec.league);
    k_scale   := case when rec.year >= 2025 then 0.3 else 1.0 end;
    actual_b  := rec.blue_win::numeric;
    blue_pre  := array[]::numeric[]; red_pre := array[]::numeric[];
    for i in 1..5 loop
      blue_pre := array_append(blue_pre, coalesce((player_elo -> rec.bp[i])::numeric, start_elo));
      red_pre  := array_append(red_pre,  coalesce((player_elo -> rec.rp[i])::numeric, start_elo));
    end loop;
    blue_avg := (blue_pre[1]+blue_pre[2]+blue_pre[3]+blue_pre[4]+blue_pre[5])/5.0;
    red_avg  := (red_pre[1]+red_pre[2]+red_pre[3]+red_pre[4]+red_pre[5])/5.0;
    blue_post := array[]::numeric[]; red_post := array[]::numeric[];
    for i in 1..5 loop
      expected := 1.0/(1.0+power(10.0::numeric,(red_avg-blue_pre[i])/ELO_SCALE));
      blue_post := array_append(blue_post, blue_pre[i]+K_FACTOR*k_scale*(actual_b-expected));
      expected := 1.0/(1.0+power(10.0::numeric,(blue_avg-red_pre[i])/ELO_SCALE));
      red_post := array_append(red_post, red_pre[i]+K_FACTOR*k_scale*((1.0-actual_b)-expected));
    end loop;
    for i in 1..5 loop
      player_elo := jsonb_set(player_elo, array[rec.bp[i]], to_jsonb(blue_post[i]), true);
      player_elo := jsonb_set(player_elo, array[rec.rp[i]], to_jsonb(red_post[i]), true);
    end loop;
    if rec.year >= SNAPSHOT_FROM_YEAR then
      for i in 1..5 loop
        insert into public.player_elo_history
          (player, gameid, date, year, league, pos, team, opp_team, elo_before, elo_after, won)
        values
          (rec.bp[i], rec.gameid, rec.game_date, rec.year, rec.league, POSITIONS[i],
           rec.blue_team, rec.red_team,
           round(blue_pre[i]::numeric,1), round(blue_post[i]::numeric,1), rec.blue_win),
          (rec.rp[i], rec.gameid, rec.game_date, rec.year, rec.league, POSITIONS[i],
           rec.red_team, rec.blue_team,
           round(red_pre[i]::numeric,1), round(red_post[i]::numeric,1), (1-rec.blue_win)::smallint)
        on conflict (player, gameid) do nothing;
        inserted := inserted + 2;
      end loop;
    end if;
  end loop;

  return inserted;
end;
$$;
