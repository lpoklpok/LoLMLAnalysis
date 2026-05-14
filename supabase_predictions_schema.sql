-- Run in Supabase SQL editor

CREATE TABLE IF NOT EXISTS predictions (
  gameid        text PRIMARY KEY,
  date          timestamptz,
  league        text,
  playoffs      int,
  blue_team     text,
  red_team      text,
  blue_win      int,
  q_blue_win    float8,
  pred_elo      float8,
  pred_full     float8
);

CREATE INDEX IF NOT EXISTS predictions_league_idx ON predictions (league);
CREATE INDEX IF NOT EXISTS predictions_date_idx   ON predictions (date);

ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON predictions FOR SELECT USING (true);
