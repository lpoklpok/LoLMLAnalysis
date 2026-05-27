-- Adds the columns upload_to_supabase.py needs to upload per-game stats
-- (draft + per-team @ time + team aggregates + per-position gold diff).
-- Idempotent — uses IF NOT EXISTS so re-running is safe.
--
-- Run once in the Supabase SQL editor; subsequent CI runs of
-- upload_to_supabase.py will populate the new columns.

DO $$
DECLARE
    col_name TEXT;
    col_type TEXT;
    -- Each tuple = (column_name, postgres_type).
    cols TEXT[][] := ARRAY[
        -- Per-position gold diff @ time (40 cols)
        ['blue_top_golddiffat10','numeric'], ['blue_top_golddiffat15','numeric'], ['blue_top_golddiffat20','numeric'], ['blue_top_golddiffat25','numeric'],
        ['blue_jng_golddiffat10','numeric'], ['blue_jng_golddiffat15','numeric'], ['blue_jng_golddiffat20','numeric'], ['blue_jng_golddiffat25','numeric'],
        ['blue_mid_golddiffat10','numeric'], ['blue_mid_golddiffat15','numeric'], ['blue_mid_golddiffat20','numeric'], ['blue_mid_golddiffat25','numeric'],
        ['blue_bot_golddiffat10','numeric'], ['blue_bot_golddiffat15','numeric'], ['blue_bot_golddiffat20','numeric'], ['blue_bot_golddiffat25','numeric'],
        ['blue_sup_golddiffat10','numeric'], ['blue_sup_golddiffat15','numeric'], ['blue_sup_golddiffat20','numeric'], ['blue_sup_golddiffat25','numeric'],
        ['red_top_golddiffat10','numeric'],  ['red_top_golddiffat15','numeric'],  ['red_top_golddiffat20','numeric'],  ['red_top_golddiffat25','numeric'],
        ['red_jng_golddiffat10','numeric'],  ['red_jng_golddiffat15','numeric'],  ['red_jng_golddiffat20','numeric'],  ['red_jng_golddiffat25','numeric'],
        ['red_mid_golddiffat10','numeric'],  ['red_mid_golddiffat15','numeric'],  ['red_mid_golddiffat20','numeric'],  ['red_mid_golddiffat25','numeric'],
        ['red_bot_golddiffat10','numeric'],  ['red_bot_golddiffat15','numeric'],  ['red_bot_golddiffat20','numeric'],  ['red_bot_golddiffat25','numeric'],
        ['red_sup_golddiffat10','numeric'],  ['red_sup_golddiffat15','numeric'],  ['red_sup_golddiffat20','numeric'],  ['red_sup_golddiffat25','numeric'],

        -- Team aggregates (28 cols total — 14 per side)
        ['blue_team_totalgold','numeric'],            ['red_team_totalgold','numeric'],
        ['blue_team_earnedgold','numeric'],           ['red_team_earnedgold','numeric'],
        ['blue_team_damagetochampions','numeric'],    ['red_team_damagetochampions','numeric'],
        ['blue_team_visionscore','numeric'],          ['red_team_visionscore','numeric'],
        ['blue_team_wardsplaced','numeric'],          ['red_team_wardsplaced','numeric'],
        ['blue_team_wardskilled','numeric'],          ['red_team_wardskilled','numeric'],
        ['blue_team_controlwardsbought','numeric'],   ['red_team_controlwardsbought','numeric'],
        ['blue_team_minionkills','numeric'],          ['red_team_minionkills','numeric'],
        ['blue_team_monsterkills','numeric'],         ['red_team_monsterkills','numeric'],
        ['blue_team_firstdragon','integer'],          ['red_team_firstdragon','integer'],
        ['blue_team_firstherald','integer'],          ['red_team_firstherald','integer'],
        ['blue_team_firstbaron','integer'],           ['red_team_firstbaron','integer'],
        ['blue_team_firsttower','integer'],           ['red_team_firsttower','integer'],

        -- Team @ time benchmarks (56 cols — 7 stats × 4 times × 2 sides)
        ['blue_team_goldat10','numeric'],     ['blue_team_goldat15','numeric'],     ['blue_team_goldat20','numeric'],     ['blue_team_goldat25','numeric'],
        ['blue_team_csat10','numeric'],       ['blue_team_csat15','numeric'],       ['blue_team_csat20','numeric'],       ['blue_team_csat25','numeric'],
        ['blue_team_xpat10','numeric'],       ['blue_team_xpat15','numeric'],       ['blue_team_xpat20','numeric'],       ['blue_team_xpat25','numeric'],
        ['blue_team_killsat10','numeric'],    ['blue_team_killsat15','numeric'],    ['blue_team_killsat20','numeric'],    ['blue_team_killsat25','numeric'],
        ['blue_team_assistsat10','numeric'],  ['blue_team_assistsat15','numeric'],  ['blue_team_assistsat20','numeric'],  ['blue_team_assistsat25','numeric'],
        ['blue_team_deathsat10','numeric'],   ['blue_team_deathsat15','numeric'],   ['blue_team_deathsat20','numeric'],   ['blue_team_deathsat25','numeric'],
        ['blue_team_golddiffat10','numeric'], ['blue_team_golddiffat20','numeric'], ['blue_team_golddiffat25','numeric'],
        ['red_team_goldat10','numeric'],      ['red_team_goldat15','numeric'],      ['red_team_goldat20','numeric'],      ['red_team_goldat25','numeric'],
        ['red_team_csat10','numeric'],        ['red_team_csat15','numeric'],        ['red_team_csat20','numeric'],        ['red_team_csat25','numeric'],
        ['red_team_xpat10','numeric'],        ['red_team_xpat15','numeric'],        ['red_team_xpat20','numeric'],        ['red_team_xpat25','numeric'],
        ['red_team_killsat10','numeric'],     ['red_team_killsat15','numeric'],     ['red_team_killsat20','numeric'],     ['red_team_killsat25','numeric'],
        ['red_team_assistsat10','numeric'],   ['red_team_assistsat15','numeric'],   ['red_team_assistsat20','numeric'],   ['red_team_assistsat25','numeric'],
        ['red_team_deathsat10','numeric'],    ['red_team_deathsat15','numeric'],    ['red_team_deathsat20','numeric'],    ['red_team_deathsat25','numeric'],
        ['red_team_golddiffat10','numeric'],  ['red_team_golddiffat15','numeric'],  ['red_team_golddiffat20','numeric'],  ['red_team_golddiffat25','numeric'],

        -- Draft: picks + bans (21 cols)
        ['blue_team_pick1','text'], ['blue_team_pick2','text'], ['blue_team_pick3','text'], ['blue_team_pick4','text'], ['blue_team_pick5','text'],
        ['blue_team_ban1','text'],  ['blue_team_ban2','text'],  ['blue_team_ban3','text'],  ['blue_team_ban4','text'],  ['blue_team_ban5','text'],
        ['red_team_pick1','text'],  ['red_team_pick2','text'],  ['red_team_pick3','text'],  ['red_team_pick4','text'],  ['red_team_pick5','text'],
        ['red_team_ban1','text'],   ['red_team_ban2','text'],   ['red_team_ban3','text'],   ['red_team_ban4','text'],   ['red_team_ban5','text'],
        ['blue_team_firstPick','integer']
    ];
    i INTEGER;
BEGIN
    FOR i IN 1..array_length(cols, 1) LOOP
        col_name := cols[i][1];
        col_type := cols[i][2];
        EXECUTE format('ALTER TABLE games ADD COLUMN IF NOT EXISTS %I %s', col_name, col_type);
    END LOOP;
END $$;
