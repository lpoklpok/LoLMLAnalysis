"""
upload_predictions.py
Uploads model predictions (test set 2025-2026) to Supabase predictions table.
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


def _sanitize(record: dict) -> dict:
    out = {}
    for k, v in record.items():
        if v is pd.NA:
            out[k] = None
        elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            out[k] = None
        elif hasattr(v, 'item'):
            out[k] = v.item()
        else:
            out[k] = v
    return out


def run():
    df = pd.read_csv(PROCESSED_DIR / 'predictions.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date']).dt.strftime('%Y-%m-%dT%H:%M:%S')

    print(f"Uploading {len(df):,} predictions...")
    client = create_client(SUPABASE_URL, SUPABASE_KEY)

    records = [_sanitize(r) for r in df.to_dict(orient='records')]
    total_batches = math.ceil(len(records) / BATCH_SIZE)

    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        print(f"  Batch {i // BATCH_SIZE + 1}/{total_batches}...", end='\r')
        client.table('predictions').upsert(batch, on_conflict='gameid').execute()

    print(f"\nDone — {len(records):,} predictions uploaded.")


if __name__ == '__main__':
    run()
