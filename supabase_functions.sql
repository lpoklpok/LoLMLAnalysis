-- Returns side win rate + summary stats for given filters
create or replace function get_summary_stats(
  p_league text default null,
  p_year   integer default null,
  p_patch  text default null
)
returns json
language sql
stable
as $$
  select json_build_object(
    'total_games',       count(*),
    'blue_wins',         sum(blue_team_result),
    'avg_gamelength',    round(avg(gamelength)::numeric, 1),
    'games_with_odds',   count(*) filter (where q_blue_win is not null),
    'favorite_wins',     count(*) filter (
                           where q_blue_win is not null
                           and (
                             (q_blue_win > 0.5 and blue_team_result = 1) or
                             (q_blue_win < 0.5 and blue_team_result = 0)
                           )
                         )
  )
  from games
  where (p_league is null or league = p_league)
    and (p_year   is null or year   = p_year)
    and (p_patch  is null or patch  = p_patch)
$$;

-- Returns champion pick + win rates for a given position and filters
create or replace function get_champion_stats(
  p_position text,
  p_league   text default null,
  p_year     integer default null,
  p_patch    text default null
)
returns table(champion text, picks bigint, wins bigint)
language sql
stable
as $$
  with blue_side as (
    select
      case p_position
        when 'top' then blue_top_champion
        when 'jng' then blue_jng_champion
        when 'mid' then blue_mid_champion
        when 'bot' then blue_bot_champion
        when 'sup' then blue_sup_champion
      end as champion,
      blue_team_result as won
    from games
    where (p_league is null or league = p_league)
      and (p_year   is null or year   = p_year)
      and (p_patch  is null or patch  = p_patch)
  ),
  red_side as (
    select
      case p_position
        when 'top' then red_top_champion
        when 'jng' then red_jng_champion
        when 'mid' then red_mid_champion
        when 'bot' then red_bot_champion
        when 'sup' then red_sup_champion
      end as champion,
      1 - blue_team_result as won
    from games
    where (p_league is null or league = p_league)
      and (p_year   is null or year   = p_year)
      and (p_patch  is null or patch  = p_patch)
  ),
  combined as (
    select * from blue_side
    union all
    select * from red_side
  )
  select
    champion,
    count(*)        as picks,
    sum(won)        as wins
  from combined
  where champion is not null
  group by champion
  having count(*) >= 5
  order by picks desc
  limit 30
$$;

-- Returns unique filter values
create or replace function get_filter_options()
returns json
language sql
stable
as $$
  select json_build_object(
    'years',   (select json_agg(distinct year order by year desc) from games),
    'patches', (select json_agg(distinct patch order by patch desc) from games where patch is not null)
  )
$$;
