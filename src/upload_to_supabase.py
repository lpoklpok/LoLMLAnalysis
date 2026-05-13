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

    # Key team stats
    'blue_team_kills', 'red_team_kills',
    'blue_team_dragons', 'red_team_dragons',
    'blue_team_barons', 'red_team_barons',
    'blue_team_towers', 'red_team_towers',
    'blue_team_firstblood',
    'blue_team_golddiffat15',

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


def _upload_table(client, table: str, df: pd.DataFrame):
    print(f"Uploading {len(df):,} rows to '{table}'...")

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
