"""
upload_player_elo_history.py
Reads player_elo_history.csv (emitted by feature_engineering) and uploads
the last 2 years of snapshots to the player_elo_history Supabase table.

Strategy: full replace (delete-all + insert) keyed on player+gameid is
overkill; instead we DELETE WHERE year >= cutoff_year and re-insert. Older
rows stay untouched.
"""
from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIR = ROOT / 'data' / 'processed'
CSV_PATH = PROCESSED_DIR / 'player_elo_history.csv'

# Window: starting from 2024 (the year the model was trained on) so the chart
# shows the full pre-current-meta trajectory, not just the last 1.5 years.
CUTOFF_YEAR = 2024


def run():
    if not CSV_PATH.exists():
        print(f"ERROR: {CSV_PATH} not found. Run feature_engineering.py first.")
        return

    df = pd.read_csv(CSV_PATH, low_memory=False)
    print(f"Loaded {len(df):,} total snapshots")
    df = df[df['year'] >= CUTOFF_YEAR].copy()
    print(f"Filtered to year >= {CUTOFF_YEAR}: {len(df):,} rows")
    if df.empty:
        print("No rows to upload."); return

    # Round to keep payload tight
    df['elo_before'] = df['elo_before'].round(1)
    df['elo_after']  = df['elo_after'].round(1)

    load_dotenv()
    sb_url = os.environ.get('SUPABASE_URL')
    sb_key = os.environ.get('SUPABASE_SERVICE_KEY')
    if not sb_url or not sb_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        return
    client = create_client(sb_url, sb_key)

    records = df.to_dict(orient='records')
    print(f"Upserting {len(records):,} rows...")
    BATCH = 1000
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        client.table('player_elo_history').upsert(
            batch, on_conflict='player,gameid'
        ).execute()
        print(f"  {min(i + BATCH, len(records))}/{len(records)}")
    print("Done.")


if __name__ == '__main__':
    run()
