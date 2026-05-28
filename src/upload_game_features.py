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


# Champion-level features added to the post-draft model. See
# src/build_champ_features.py for the walk-forward computation.
CHAMP_FEATS = [
    'avg_champ_meta_wr_diff',         # strongest new signal
    'avg_player_champ_wr_diff',       # 2nd strongest
    'roster_stability_diff',          # small but cheap
]
CHAMP_FILL = {f: 0.0 for f in CHAMP_FEATS}


def _apply_adjustments(logodds: np.ndarray, df: pd.DataFrame) -> np.ndarray:
    """G2 draft + per-team playoff + coaching adjustments. Identical to the
    bespoke math used for the pre-draft model so both predictions share the
    same calibration framework."""
    adj = logodds.copy()
    g2_mask = ((df['game'] == 2) & (df['year'] >= 2025)).values
    adj[g2_mask] = (ALPHA_G2 * adj[g2_mask]
                    + BETA_DA * df['draft_advantage'].values[g2_mask])
    po_mask = df['playoffs'].values == 1
    if po_mask.any():
        blue_po = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['blue_team']])
        red_po  = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['red_team']])
        adj[po_mask] += (blue_po - red_po)[po_mask]
    years = df['year'].values
    for team, (from_year, bonus) in COACHING_ADJ.items():
        active = years >= from_year
        adj[(df['blue_team'].values == team) & active] += bonus
        adj[(df['red_team'].values  == team) & active] -= bonus
    return adj


def run():
    df = pd.read_csv(PROCESSED_DIR / 'features_all.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)

    # Merge champion-level features (built walk-forward by build_champ_features.py)
    champ_path = PROCESSED_DIR / 'champ_features.csv'
    if champ_path.exists():
        ch = pd.read_csv(champ_path, low_memory=False)
        df = df.merge(ch, on='gameid', how='left')
        print(f'Merged {len(ch.columns)-1} champ features ({len(ch):,} rows)')
    else:
        # Add stub columns so the post-draft model trains (and predicts at neutral)
        print('WARN: champ_features.csv missing — post_draft model will equal pre_draft.')
        for f in CHAMP_FEATS:
            df[f] = 0.0

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
    df = df.sort_values(['_date_day', 'league', '_team_key', 'game']).reset_index(drop=True)
    shifted = df.groupby(['_date_day', 'league', '_team_key'])['blue_win'].shift(1)
    df['draft_advantage'] = shifted.map(lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)).astype(int)

    train = df[df['year'].isin([2024, 2025])]

    # === PRE-DRAFT MODEL (current production: 6 features, no champ info) ===
    model_pre = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model_pre.fit(train[FEATS].fillna(FILL), train['blue_win'].values)
    s_pre, lr_pre = model_pre.named_steps['s'], model_pre.named_steps['lr']
    logodds_pre = s_pre.transform(df[FEATS].fillna(FILL)) @ lr_pre.coef_.ravel() + lr_pre.intercept_[0]
    preds = 1 / (1 + np.exp(-_apply_adjustments(logodds_pre, df)))

    # === POST-DRAFT MODEL (pre-draft + champion features) ===
    feats_post = FEATS + CHAMP_FEATS
    fill_post  = {**FILL, **CHAMP_FILL}
    model_post = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model_post.fit(train[feats_post].fillna(fill_post), train['blue_win'].values)
    s_post, lr_post = model_post.named_steps['s'], model_post.named_steps['lr']
    logodds_post = s_post.transform(df[feats_post].fillna(fill_post)) @ lr_post.coef_.ravel() + lr_post.intercept_[0]
    preds_post = 1 / (1 + np.exp(-_apply_adjustments(logodds_post, df)))

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
            'model_pred_post_draft': round(float(preds_post[i]), 4),
            'poly_blue_win_prob': _safe(row.get('poly_blue_win_prob')),
            'poly_source':        (None if (row.get('poly_source') is None or (isinstance(row.get('poly_source'), float) and np.isnan(row.get('poly_source')))) else str(row.get('poly_source'))),
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
