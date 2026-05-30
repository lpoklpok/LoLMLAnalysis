"""LR-integrated test for adaptive K. Mirrors compare_glicko_lr.py's structure
so the comparison is apples-to-apples.

We replay games once with adaptive K (best config from tune_adaptive_k:
N=12, λ=0.5, scale=0.15) and emit per-game features: adaptive_elo_diff and
the pre-game team surprise scores. Merge into features.csv, train LR
with several feature stacks, report OOS log loss + Brier.

The question: does the better-calibrated ELO from adaptive K give the LR
a more useful feature than fixed-K ELO?
"""
from __future__ import annotations

from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, brier_score_loss
from sklearn.preprocessing import StandardScaler

from feature_engineering import POSITIONS, _starting_elo, K_FACTOR, ELO_SCALE, SERIES_K_ALPHA

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
GAMES_CSV    = PROCESSED / 'games_with_odds.csv'
FEATURES_CSV = PROCESSED / 'features.csv'

# Best from tune_adaptive_k.py
ADAPTIVE_N     = 12
ADAPTIVE_LAM   = 0.5
ADAPTIVE_SCALE = 0.15


def replay_adaptive(games_df: pd.DataFrame) -> pd.DataFrame:
    """Walk games chronologically with adaptive K. Return per-game pre-game
    features keyed by gameid."""
    elo_map: dict[str, float] = {}
    residuals: dict[str, deque] = defaultdict(lambda: deque(maxlen=ADAPTIVE_N))
    rows = []

    df = games_df.sort_values('date').reset_index(drop=True)
    for g in df.itertuples(index=False):
        bp = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        rp = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp): continue
        bw = g.blue_team_result
        if pd.isna(bw): continue
        bw = int(bw)
        league = str(g.league); year = int(g.year)
        b_team = str(g.blue_team_teamname); r_team = str(g.red_team_teamname)

        start = _starting_elo(league)
        b_avg = sum(elo_map.get(p, start) for p in bp) / 5
        r_avg = sum(elo_map.get(p, start) for p in rp) / 5
        pred  = 1.0 / (1.0 + 10 ** ((r_avg - b_avg) / ELO_SCALE))

        b_xs = residuals[b_team]; r_xs = residuals[r_team]
        s_blue = abs(sum(b_xs) / len(b_xs)) if len(b_xs) >= 3 else 0.0
        s_red  = abs(sum(r_xs) / len(r_xs)) if len(r_xs) >= 3 else 0.0

        rows.append({
            'gameid':           str(g.gameid),
            'adapt_elo_diff':   b_avg - r_avg,
            's_blue':           s_blue,
            's_red':            s_red,
            'surprise_diff':    s_blue - s_red,
            'surprise_max':     max(s_blue, s_red),
        })

        k_eff  = K_FACTOR * (SERIES_K_ALPHA if year >= 2025 else 1.0)
        k_blue = k_eff * (1.0 + ADAPTIVE_LAM * (s_blue / ADAPTIVE_SCALE))
        k_red  = k_eff * (1.0 + ADAPTIVE_LAM * (s_red  / ADAPTIVE_SCALE))

        for p in bp:
            e = elo_map.get(p, start)
            exp_i = 1.0 / (1.0 + 10 ** ((r_avg - e) / ELO_SCALE))
            elo_map[p] = e + k_blue * (bw - exp_i)
        for p in rp:
            e = elo_map.get(p, start)
            exp_i = 1.0 / (1.0 + 10 ** ((b_avg - e) / ELO_SCALE))
            elo_map[p] = e + k_red * ((1 - bw) - exp_i)

        residuals[b_team].append(bw - pred)
        residuals[r_team].append((1 - bw) - (1 - pred))

    return pd.DataFrame(rows)


BASE_FEATS = ['rwr_diff', 'h2h_wr', 'gd15_diff']   # matches export_model_params.py (no playoffs)
PROD_FEATS = ['elo_diff']        + BASE_FEATS + ['outperf_diff']
ADAPT_FEATS = ['adapt_elo_diff'] + BASE_FEATS + ['outperf_diff']
ADAPT_PLUS  = ['adapt_elo_diff'] + BASE_FEATS + ['outperf_diff', 'surprise_max']

FILL = {
    'elo_diff': 0.0, 'adapt_elo_diff': 0.0,
    'rwr_diff': 0.0, 'h2h_wr': 0.5, 'gd15_diff': 0.0,
    'outperf_diff': 0.0,
    'surprise_diff': 0.0, 'surprise_max': 0.0,
}


def train_eval(feats: list[str], label: str, train: pd.DataFrame, tests: dict[str, pd.DataFrame]) -> None:
    print(f'\n=== {label} ===')
    for f in feats: train[f] = train[f].fillna(FILL.get(f, 0.0))
    X_tr = train[feats].values.astype(float)
    y_tr = train['blue_win'].values.astype(int)
    scaler = StandardScaler().fit(X_tr)
    lr = LogisticRegression(C=1.0, max_iter=5000).fit(scaler.transform(X_tr), y_tr)
    print('  coefs:  ' + '  '.join(f'{f}={c:+.3f}' for f, c in zip(feats, lr.coef_[0])))
    for name, df in tests.items():
        for f in feats: df[f] = df[f].fillna(FILL.get(f, 0.0))
        X = df[feats].values.astype(float)
        y = df['blue_win'].values.astype(int)
        p = lr.predict_proba(scaler.transform(X))[:, 1]
        ll = log_loss(y, np.clip(p, 1e-6, 1 - 1e-6))
        br = brier_score_loss(y, p)
        print(f'  {name:8s} ({len(df):>5,} games):  LL {ll:.4f}   Brier {br:.4f}')


def main():
    print(f'Loading games + features.csv...')
    games = pd.read_csv(GAMES_CSV, low_memory=False)
    games['date'] = pd.to_datetime(games['date'], utc=True)
    feats = pd.read_csv(FEATURES_CSV, low_memory=False)

    print(f'Replaying with adaptive K (N={ADAPTIVE_N}, λ={ADAPTIVE_LAM}, scale={ADAPTIVE_SCALE})...')
    new_feats = replay_adaptive(games)
    df = feats.merge(new_feats, on='gameid', how='left')
    df = df.dropna(subset=['blue_win', 'elo_diff', 'adapt_elo_diff'])
    df['year'] = df['year'].astype(int)
    print(f'  merged: {len(df):,} rows ({df.year.min()}-{df.year.max()})')

    train = df[df['year'] == 2024].copy()
    tests = {
        '2025':    df[df['year'] == 2025].copy(),
        '2026':    df[df['year'] == 2026].copy(),
        'all OOS': df[df['year'].isin([2025, 2026])].copy(),
    }
    print(f'Train: {len(train):,}   Test 2025: {len(tests["2025"]):,}   Test 2026: {len(tests["2026"]):,}')

    # Sanity: standalone (no LR) adaptive vs fixed elo_diff -> implied prob
    print('\n--- Standalone (no LR) reference ---')
    for name, sub in tests.items():
        p_fix = 1 / (1 + 10 ** (-sub['elo_diff'] / 400))
        p_adp = 1 / (1 + 10 ** (-sub['adapt_elo_diff'] / 400))
        y = sub['blue_win'].values.astype(int)
        ll_fix = log_loss(y, np.clip(p_fix, 1e-6, 1 - 1e-6))
        ll_adp = log_loss(y, np.clip(p_adp, 1e-6, 1 - 1e-6))
        print(f'  {name:8s}:  fixed LL {ll_fix:.4f}   adaptive LL {ll_adp:.4f}   Δ {(ll_fix-ll_adp)/ll_fix*100:+.2f}%')

    train_eval(PROD_FEATS,  'A. Production (fixed K)',           train, tests)
    train_eval(ADAPT_FEATS, 'B. Adaptive K (drop-in replace)',   train, tests)
    train_eval(ADAPT_PLUS,  'C. Adaptive K + surprise_max',      train, tests)


if __name__ == '__main__':
    main()
