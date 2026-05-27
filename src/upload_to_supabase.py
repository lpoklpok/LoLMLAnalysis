"""
upload_to_supabase.py
Selects relevant columns from games_with_odds.csv and uploads to Supabase.
Run once to seed the database; re-run to refresh (truncates and reloads).

Requires .env in the project root with:
    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_SERVICE_KEY=your_service_role_key
"""

import os
import math
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(os.path.dirname(__file__)) / '..' / '.env')

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_KEY']
PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'
BATCH_SIZE = 500

# Columns to keep — enough for all planned visualizations
KEEP_COLS = [
    # Game metadata
    'gameid', 'league', 'year', 'split', 'playoffs', 'date', 'game', 'patch', 'gamelength',

    # Teams and result
    'blue_team_teamname', 'red_team_teamname', 'blue_team_result',

    # Players and champions per position
    'blue_top_playername', 'blue_jng_playername', 'blue_mid_playername',
    'blue_bot_playername', 'blue_sup_playername',
    'red_top_playername',  'red_jng_playername',  'red_mid_playername',
    'red_bot_playername',  'red_sup_playername',
    'blue_top_champion', 'blue_jng_champion', 'blue_mid_champion',
    'blue_bot_champion', 'blue_sup_champion',
    'red_top_champion',  'red_jng_champion',  'red_mid_champion',
    'red_bot_champion',  'red_sup_champion',

    # Per-position gold diff @ time
    *[f'{side}_{pos}_golddiffat{t}'
      for side in ('blue','red') for pos in ('top','jng','mid','bot','sup') for t in (10,15,20,25)],

    # Key team stats
    'blue_team_kills', 'red_team_kills',
    'blue_team_dragons', 'red_team_dragons',
    'blue_team_barons', 'red_team_barons',
    'blue_team_towers', 'red_team_towers',
    'blue_team_firstblood',

    # Team aggregates
    *[f'{side}_team_{stat}'
      for side in ('blue','red')
      for stat in ('totalgold','earnedgold','damagetochampions','visionscore',
                    'wardsplaced','wardskilled','controlwardsbought',
                    'minionkills','monsterkills',
                    'firstdragon','firstherald','firstbaron','firsttower')],

    # Team @ time benchmarks
    *[f'{side}_team_{stat}{t}'
      for side in ('blue','red')
      for stat in ('goldat','csat','xpat','killsat','assistsat','deathsat','golddiffat')
      for t in (10, 15, 20, 25)],

    # Draft: pick order + bans
    *[f'{side}_team_{kind}{slot}'
      for side in ('blue','red') for kind in ('pick','ban') for slot in (1,2,3,4,5)],
    'blue_team_firstPick',

    # Odds
    'odd1_decimal', 'odd2_decimal',
    'implied_prob1_vigfree', 'implied_prob2_vigfree',
    'team1', 'team2', 'format', 'q_blue_win', 'score_match',
]


INT_COLS = [
    'year', 'playoffs', 'game', 'gamelength',
    'blue_team_result', 'blue_team_kills', 'red_team_kills',
    'blue_team_dragons', 'red_team_dragons', 'blue_team_barons', 'red_team_barons',
    'blue_team_towers', 'red_team_towers', 'blue_team_firstblood',
    'blue_team_firstPick',
    *[f'{side}_team_first{obj}' for side in ('blue','red') for obj in ('dragon','herald','baron','tower')],
]


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df['date'] = pd.to_datetime(df['date']).dt.strftime('%Y-%m-%dT%H:%M:%S')
    # Use pandas nullable Int64 so NaN stays NaN (not dropped) but non-null values are ints
    for col in INT_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').astype('Int64')
    return df


def _sanitize_record(record: dict) -> dict:
    """Convert NaN/inf/NA values to None so JSON serialization doesn't fail."""
    out = {}
    for k, v in record.items():
        if v is pd.NA:
            out[k] = None
        elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            out[k] = None
        elif hasattr(v, 'item'):  # numpy scalar → python native
            out[k] = v.item()
        else:
            out[k] = v
    return out


def _existing_columns(client, table: str) -> set[str]:
    """Return the set of columns currently in the target Supabase table.
    Used to gracefully skip columns whose ALTER TABLE migration hasn't been
    applied yet — otherwise the insert would 400 on the first unknown column."""
    try:
        resp = client.table(table).select('*').limit(1).execute()
        if resp.data:
            return set(resp.data[0].keys())
        # Table is empty — fall back to inserting a probe to learn the schema?
        # Easier: rely on the table having at least one row from prior upload.
        # If totally empty, just return None to mean "send everything".
    except Exception as e:
        print(f"  Couldn't introspect {table} columns: {e!r}")
    return set()


def _upload_table(client, table: str, df: pd.DataFrame):
    existing_cols = _existing_columns(client, table)
    if existing_cols:
        skipped = [c for c in df.columns if c not in existing_cols]
        if skipped:
            print(f"  Skipping {len(skipped)} cols not in '{table}' schema "
                  f"(run the SQL migration to unlock): {skipped[:5]}{' ...' if len(skipped) > 5 else ''}")
            df = df[[c for c in df.columns if c in existing_cols]]

    print(f"Uploading {len(df):,} rows × {len(df.columns)} cols to '{table}'...")

    # Truncate existing data
    client.table(table).delete().neq('gameid', '').execute()

    records = [_sanitize_record(r) for r in df.to_dict(orient='records')]
    total_batches = math.ceil(len(records) / BATCH_SIZE)

    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        print(f"  Batch {batch_num}/{total_batches}...", end='\r')
        client.table(table).insert(batch).execute()

    print(f"\nDone — '{table}' uploaded.")


def run():
    path = PROCESSED_DIR / 'games_with_odds.csv'
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}. Run merge_data.py first.")

    print("Loading data...")
    df = pd.read_csv(path, low_memory=False, usecols=[c for c in KEEP_COLS
                                                       if c not in ('format', 'score_match')]
                     + ['format', 'score_match'])

    # Only keep columns that actually exist (odds cols may be absent for some rows)
    existing = [c for c in KEEP_COLS if c in df.columns]
    df = df[existing]
    df = _clean(df)

    print(f"Rows: {len(df):,}  Columns: {len(df.columns)}")

    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    _upload_table(client, 'games', df)


if __name__ == '__main__':
    run()
