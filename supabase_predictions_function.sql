-- Run in Supabase SQL editor

CREATE OR REPLACE FUNCTION get_predictions()
RETURNS TABLE(
  date        timestamptz,
  league      text,
  playoffs    int,
  blue_win    int,
  q_blue_win  float8,
  pred_elo    float8,
  pred_full   float8
)
LANGUAGE sql STABLE
AS $$
  SELECT date, league, playoffs, blue_win, q_blue_win, pred_elo, pred_full
  FROM predictions
  ORDER BY date;
$$;
