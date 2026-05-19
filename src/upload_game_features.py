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

# G2 adjustment for 2025+: z_G2 = ALPHA_G2 * logodds + BETA_DA * draft_advantage
# Separates blanket regression-to-mean (alpha) from the genuine draft-advantage boost (beta).
# Both fitted via minimising log-loss on 2025 G2 games, validated on 2026 holdout.
ALPHA_G2 = 0.8970
BETA_DA  = 0.0929

# Per-team playoff logodds adjustment (positive = outperforms in playoffs vs regular season).
# Fitted via leave-one-year-out residuals, scaled by a single global shrinkage factor (0.76)
# optimised on 2025+2026 log loss. Only teams with ≥10 playoff games included.
TEAM_PO_ADJ = {
    'G2 Esports':         0.4172,
    'FunPlus Phoenix':    0.3159,
    'Bilibili Gaming':    0.2242,
    'T1':                 0.2068,
    'KT Rolster':         0.1991,
    'Weibo Gaming':       0.1234,
    'BNK FEARX':          0.1069,
    "Anyone's Legend":    0.0801,
    'Team BDS':           0.0612,
    'Karmine Corp':       0.0416,
    'Hanwha Life Esports':-0.0616,
    'Team WE':           -0.0757,
    'Top Esports':       -0.0927,
    'Dplus Kia':         -0.0968,
    'JD Gaming':         -0.1238,
    'Invictus Gaming':   -0.1406,
    'Gen.G':             -0.1510,
    'Movistar KOI':      -0.1518,
    'Team Heretics':     -0.3450,
    'ThunderTalk Gaming':-0.3521,
    'Ninjas in Pyjamas': -0.3548,
    'EDward Gaming':     -0.3743,
    'Team Vitality':     -0.4237,
    'Fnatic':            -0.4427,
    'GiantX':            -0.4491,
    'Nongshim RedForce': -0.6670,
}

# Coaching adjustments: team → (from_year, logodds_bonus).
# Applied to all games (regular season + playoffs) from from_year onwards.
# Reapered joined Karmine Corp for 2026; fitted on 2026 KC games.
COACHING_ADJ = {
    'Karmine Corp': (2026, 0.3695),
}


def _safe(v):
    try:
        return None if (v is None or np.isnan(v) or np.isinf(v)) else float(v)
    except Exception:
        return None


def run():
    df = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)

    # Compute series metadata first — draft_advantage must exist before model training
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

    # draft_advantage: loser of prev game chooses side/pick order independently.
    # +1 = blue lost prev (blue has draft choice), -1 = blue won (red has choice), 0 = G1/bo1
    df = df.sort_values(['_date_day', 'league', '_team_key', 'game'])
    def _add_draft_advantage(grp):
        grp = grp.sort_values('game')
        prev = grp['blue_win'].shift(1)
        grp['draft_advantage'] = prev.apply(
            lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)
        ).astype(int)
        return grp
    df = df.groupby(['_date_day', 'league', '_team_key'], group_keys=False).apply(_add_draft_advantage)
    df = df.reset_index(drop=True)

    train = df[df['year'].isin([2024, 2025])]
    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(train[FEATS].fillna(FILL), train['blue_win'].values)

    # Raw log-odds aligned with current df row order
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(df[FEATS].fillna(FILL))
    logodds = X_sc @ lr.coef_.ravel() + lr.intercept_[0]

    # G2 adjustment for 2025+: alpha * logodds + beta * draft_advantage
    g2_mask = ((df['game'] == 2) & (df['year'] >= 2025)).values
    logodds_adj = logodds.copy()
    logodds_adj[g2_mask] = (ALPHA_G2 * logodds[g2_mask]
                            + BETA_DA * df['draft_advantage'].values[g2_mask])

    # Team playoff adjustment: per-team logodds shift when in playoffs
    po_mask = df['playoffs'].values == 1
    if po_mask.any():
        blue_po = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['blue_team']])
        red_po  = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['red_team']])
        logodds_adj[po_mask] += (blue_po - red_po)[po_mask]

    # Coaching adjustments: applied to all games from the specified year onwards
    years = df['year'].values
    for team, (from_year, bonus) in COACHING_ADJ.items():
        active = years >= from_year
        blue_mask = (df['blue_team'].values == team) & active
        red_mask  = (df['red_team'].values  == team) & active
        logodds_adj[blue_mask] += bonus
        logodds_adj[red_mask]  -= bonus

    preds = 1 / (1 + np.exp(-logodds_adj))

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
