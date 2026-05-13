-- Returns champion stats for a specific player
create or replace function get_player_stats(p_playername text)
returns table(
  champion  text,
  pos       text,
  picks     bigint,
  wins      bigint,
  league    text,
  year      integer
)
language sql
stable
as $$
  with all_games as (
    select 'top' as pos, blue_top_playername as player, blue_top_champion as champ,
           blue_team_result as won, league, year from games
    union all
    select 'jng', blue_jng_playername, blue_jng_champion, blue_team_result, league, year from games
    union all
    select 'mid', blue_mid_playername, blue_mid_champion, blue_team_result, league, year from games
    union all
    select 'bot', blue_bot_playername, blue_bot_champion, blue_team_result, league, year from games
    union all
    select 'sup', blue_sup_playername, blue_sup_champion, blue_team_result, league, year from games
    union all
    select 'top', red_top_playername, red_top_champion, 1 - blue_team_result, league, year from games
    union all
    select 'jng', red_jng_playername, red_jng_champion, 1 - blue_team_result, league, year from games
    union all
    select 'mid', red_mid_playername, red_mid_champion, 1 - blue_team_result, league, year from games
    union all
    select 'bot', red_bot_playername, red_bot_champion, 1 - blue_team_result, league, year from games
    union all
    select 'sup', red_sup_playername, red_sup_champion, 1 - blue_team_result, league, year from games
  )
  select champ as champion, pos, count(*) as picks, sum(won) as wins, league, year
  from all_games
  where lower(player) = lower(p_playername)
    and champ is not null
  group by champ, pos, league, year
  order by picks desc
$$;

-- Search players by name prefix (for autocomplete)
create or replace function search_players(p_query text)
returns table(playername text, games bigint)
language sql
stable
as $$
  with all_players as (
    select blue_top_playername as player from games where blue_top_playername is not null
    union all select blue_jng_playername from games where blue_jng_playername is not null
    union all select blue_mid_playername from games where blue_mid_playername is not null
    union all select blue_bot_playername from games where blue_bot_playername is not null
    union all select blue_sup_playername from games where blue_sup_playername is not null
    union all select red_top_playername  from games where red_top_playername  is not null
    union all select red_jng_playername  from games where red_jng_playername  is not null
    union all select red_mid_playername  from games where red_mid_playername  is not null
    union all select red_bot_playername  from games where red_bot_playername  is not null
    union all select red_sup_playername  from games where red_sup_playername  is not null
  )
  select player as playername, count(*) as games
  from all_players
  where lower(player) like lower(p_query) || '%'
  group by player
  order by games desc
  limit 10
$$;
