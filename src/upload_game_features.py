"""
upload_game_features.py
Trains the model on 2024-2025 data, computes per-game predictions for all
historical games, and uploads to the game_features Supabase table.

Run once after the SQL table has been created, then re-run whenever
features.csv is rebuilt (e.g. after feature_engineering.py).
"""

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from supabase import create_client

load_dotenv(Path(os.path.dirname(__file__)) / '..' / '.env')

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'

FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FILL  = {'elo_diff': 0., 'rwr_diff': 0., 'h2h_wr': 0.5,
         'playoffs': 0, 'gd15_diff': 0., 'outperf_diff': 0.}


def _safe(v):
    try:
        return None if (v is None or np.isnan(v) or np.isinf(v)) else float(v)
    except Exception:
        return None


def run():
    df = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)

    train = df[df['year'].isin([2024, 2025])]
    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(train[FEATS].fillna(FILL), train['blue_win'].values)

    preds = model.predict_proba(df[FEATS].fillna(FILL))[:, 1]

    records = []
    for i, (_, row) in enumerate(df.iterrows()):
        records.append({
            'date':         row['date'].isoformat(),
            'league':       str(row['league']),
            'year':         int(row['year']),
            'playoffs':     int(row['playoffs']),
            'blue_team':    str(row['blue_team']),
            'red_team':     str(row['red_team']),
            'blue_win':     int(row['blue_win']),
            'blue_elo':     _safe(row.get('blue_elo')),
            'red_elo':      _safe(row.get('red_elo')),
            'elo_diff':     _safe(row.get('elo_diff')),
            'h2h_wr':       _safe(row.get('h2h_wr')),
            'rwr_diff':     _safe(row.get('rwr_diff')),
            'gd15_diff':    _safe(row.get('gd15_diff')),
            'outperf_diff': _safe(row.get('outperf_diff')),
            'q_blue_win':   _safe(row.get('q_blue_win')),
            'model_pred':   round(float(preds[i]), 4),
        })

    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_KEY')
    if not supabase_url or not supabase_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        return

    client = create_client(supabase_url, supabase_key)

    print(f"Deleting existing rows...")
    client.table('game_features').delete().neq('id', 0).execute()

    print(f"Uploading {len(records)} games...")
    for i in range(0, len(records), 500):
        batch = records[i:i+500]
        client.table('game_features').insert(batch).execute()
        print(f"  {min(i+500, len(records))}/{len(records)}")

    print("Done.")


if __name__ == '__main__':
    run()
