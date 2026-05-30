-- Per-team per-month model bias for the /calibration page.
-- Each game contributes two rows (one per side). For each (team, month, league),
-- we report games played, actual win rate, average model-predicted win rate,
-- and bias (model_wr - actual_wr). Positive bias = model too high on the team.

create or replace function public.get_team_monthly_bias(p_year int default 2026)
returns table (
  team       text,
  league     text,
  month      int,
  games      int,
  actual_wr  numeric,
  model_wr   numeric,
  bias       numeric
)
language sql
stable
as $$
  with sides as (
    select blue_team as team, league,
           extract(month from date)::int as month,
           blue_win::numeric as won,
           model_pred::numeric as pred
    from public.game_features
    where extract(year from date) = p_year
      and league in ('LCK','LPL','LEC','LCS')
      and model_pred is not null
      and blue_win is not null
    union all
    select red_team, league,
           extract(month from date)::int,
           (1 - blue_win)::numeric,
           (1 - model_pred)::numeric
    from public.game_features
    where extract(year from date) = p_year
      and league in ('LCK','LPL','LEC','LCS')
      and model_pred is not null
      and blue_win is not null
  )
  select team, league, month,
         count(*)::int                                as games,
         round(avg(won),  4)                          as actual_wr,
         round(avg(pred), 4)                          as model_wr,
         round(avg(pred) - avg(won), 4)               as bias
  from sides
  group by team, league, month
  order by month asc, bias desc
$$;
