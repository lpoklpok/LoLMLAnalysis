-- Run this in the Supabase SQL editor

CREATE OR REPLACE FUNCTION get_market_game_data()
RETURNS TABLE(
  date        timestamptz,
  league      text,
  playoffs    int,
  blue_win    int,
  q_blue_win  float8
)
LANGUAGE sql STABLE
AS $$
  SELECT
    date::timestamptz,
    league::text,
    playoffs::int,
    blue_team_result::int,
    q_blue_win::float8
  FROM games
  WHERE league IN ('LEC', 'LPL', 'LCK')
    AND q_blue_win  IS NOT NULL
    AND blue_team_result IS NOT NULL
  ORDER BY date;
$$;
