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

FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff', 'draft_advantage']
FILL  = {'elo_diff': 0., 'rwr_diff': 0., 'h2h_wr': 0.5,
         'playoffs': 0, 'gd15_diff': 0., 'outperf_diff': 0., 'draft_advantage': 0}

# G2 shrinkage: in 2025+, predictions for game 2 are shrunk toward 50%
# because the G1 result provides information that regresses team quality toward the mean.
# Alpha fitted via leave-one-year-out CV on 2025-2026 G2 games.
ALPHA_G2 = 0.85


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

    # Raw log-odds for all games
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(df[FEATS].fillna(FILL))
    logodds = X_sc @ lr.coef_.ravel() + lr.intercept_[0]

    # Apply G2 shrinkage for 2025+ games
    shrink_mask = (df['game'] == 2) & (df['year'] >= 2025)
    logodds_adj = logodds.copy()
    logodds_adj[shrink_mask] *= ALPHA_G2
    preds = 1 / (1 + np.exp(-logodds_adj))

    # Compute series metadata: group same matchup on same calendar day
    df['_date_day'] = df['date'].dt.date
    df['_team_key'] = df.apply(
        lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1
    )
    df['_series_max'] = df.groupby(['_date_day', 'league', '_team_key'])['game'].transform('max')

    def _series_type(row):
        if row['playoffs']:
            return 'bo5'
        return 'bo1' if row['_series_max'] == 1 else 'bo3'
    df['_series_type'] = df.apply(_series_type, axis=1)

    # draft_advantage: the loser of the previous game chooses side/pick order next game.
    # +1 = blue team lost prev game (blue has draft choice), -1 = blue won prev (red has choice), 0 = G1/bo1
    df = df.sort_values(['_date_day', 'league', '_team_key', 'game'])
    def _add_draft_advantage(grp):
        grp = grp.sort_values('game')
        prev = grp['blue_win'].shift(1)
        grp['draft_advantage'] = prev.apply(
            lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)
        ).astype(int)
        return grp
    df = df.groupby(['_date_day', 'league', '_team_key'], group_keys=False).apply(_add_draft_advantage)

    records = []
    for i, (_, row) in enumerate(df.iterrows()):
        records.append({
            'date':           row['date'].isoformat(),
            'league':         str(row['league']),
            'year':           int(row['year']),
            'playoffs':       int(row['playoffs']),
            'blue_team':      str(row['blue_team']),
            'red_team':       str(row['red_team']),
            'blue_win':       int(row['blue_win']),
            'game_in_series':   int(row['game']),
            'series_type':      str(row['_series_type']),
            'draft_advantage':  int(row['draft_advantage']),
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
