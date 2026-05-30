-- player_elo_history: per-game per-player ELO snapshots for the /players/[name] page.
-- Populated by src/upload_player_elo_history.py (run as part of the daily cron),
-- which reads data/processed/player_elo_history.csv from feature_engineering.

create table if not exists public.player_elo_history (
  id          bigserial primary key,
  player      text       not null,
  gameid      text       not null,
  date        date       not null,
  year        integer    not null,
  league      text       not null,
  pos         text       not null,
  team        text       not null,
  opp_team    text       not null,
  elo_before  numeric    not null,
  elo_after   numeric    not null,
  won         smallint   not null,
  unique (player, gameid)
);

-- Fast lookup by player (most common query: get all games for a single player ordered by date)
create index if not exists player_elo_history_player_date
  on public.player_elo_history (player, date);

-- Egress hygiene: this table is read by an authenticated RPC; disable RLS for now
-- (matches the pattern used by player_elos, games, etc).
alter table public.player_elo_history disable row level security;


-- RPC: full ELO trajectory for one player. Returns rows ordered ascending by date.
create or replace function get_player_elo_history(p_player text)
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
  where lower(player) = lower(p_player)
  order by date asc, gameid asc
$$;
