-- Remove duplicate rows on the natural key of game_features before adding
-- the unique constraint. These dups accumulated from interrupted/overlapping
-- delete-then-insert pipeline runs over the years. Keep the highest-id row
-- for each group (most recent insert wins).
--
-- Run before 20260629_upsert_unique_keys.sql.
--
-- predictions already has `gameid text PRIMARY KEY` from supabase_predictions_schema.sql,
-- so it's both deduped-by-design and constraint-ready — no work needed there.

delete from public.game_features
where id in (
  select id from (
    select id,
           row_number() over (
             partition by date, blue_team, red_team, game_in_series
             order by id desc
           ) as rn
    from public.game_features
  ) t
  where t.rn > 1
);
