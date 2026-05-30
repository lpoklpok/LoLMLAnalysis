"""Apples-to-apples LR comparison: production features vs. swapping in Glicko-2.

Trains 3 logistic regressions on identical games, identical splits, identical
preprocessing — only the rating feature(s) differ:

  A.  ELO baseline (production):  elo_diff + rwr_diff + h2h_wr + playoffs +
                                  gd15_diff + outperf_diff
  B.  Glicko-2 swap:              glicko_r_diff replaces elo_diff
  C.  Glicko-2 + uncertainty:     adds phi_combined (the rating uncertainty
                                  the ELO system can't express)

Train on 2024 (matching production), test OOS on 2025 + 2026 separately.
Reports LL + Brier + LR coefficients.

Excludes the post-hoc TEAM_PO_ADJ / COACHING_ADJ / G2 ALPHA_G2/BETA_DA shifts,
since those would apply identically on top of any feature set.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, brier_score_loss
from sklearn.preprocessing import StandardScaler

from feature_engineering import (
    POSITIONS, _starting_elo, K_FACTOR, ELO_SCALE, SERIES_K_ALPHA,
)
import glicko2 as g2

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'

GAMES_CSV    = PROCESSED / 'games_with_odds.csv'
FEATURES_CSV = PROCESSED / 'features.csv'

# Match upload_game_features.py: production features + neutral fills
BASE_FEATS = ['rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
ELO_FEATS  = ['elo_diff']        + BASE_FEATS
GLK_FEATS  = ['glicko_r_diff']   + BASE_FEATS
GLK_UNC_FEATS = ['glicko_r_diff', 'phi_combined'] + BASE_FEATS

FILL = {
    'elo_diff':      0.0,
    'glicko_r_diff': 0.0,
    'phi_combined':  g2.DEFAULT_RD * math.sqrt(2) / g2.SCALE,  # neutral
    'rwr_diff':      0.0,
    'h2h_wr':        0.5,
    'playoffs':      0,
    'gd15_diff':     0.0,
    'outperf_diff':  0.0,
}


def replay_glicko(games_df: pd.DataFrame) -> pd.DataFrame:
    """Walk every game chronologically, maintain Glicko-2 state per player.
    Return a DataFrame keyed by gameid with glicko_r_diff and phi_combined
    pre-game (snapshot before the game's result is applied)."""
    gmap: dict[str, tuple[float, float, float]] = {}
    rows = []

    df = games_df.sort_values('date').reset_index(drop=True)
    for g_row in df.itertuples(index=False):
        bp = [getattr(g_row, f'blue_{p}_playername') for p in POSITIONS]
        rp = [getattr(g_row, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp): continue
        bw = g_row.blue_team_result
        if pd.isna(bw): continue
        bw = int(bw); league = str(g_row.league)

        blue_state = [gmap.get(p, (_starting_elo(league), g2.DEFAULT_RD, g2.DEFAULT_SIGMA)) for p in bp]
        red_state  = [gmap.get(p, (_starting_elo(league), g2.DEFAULT_RD, g2.DEFAULT_SIGMA)) for p in rp]
        b_r = sum(s[0] for s in blue_state) / 5
        r_r = sum(s[0] for s in red_state)  / 5
        b_rd = math.sqrt(sum(s[1] ** 2 for s in blue_state) / 5)
        r_rd = math.sqrt(sum(s[1] ** 2 for s in red_state)  / 5)

        # Pre-game snapshot features
        mu_b, phi_b = g2.to_g2(b_r, b_rd)
        mu_r, phi_r = g2.to_g2(r_r, r_rd)
        phi_combined = math.sqrt(phi_b ** 2 + phi_r ** 2)

        rows.append({
            'gameid':        str(g_row.gameid),
            'glicko_r_diff': b_r - r_r,
            'phi_combined':  phi_combined,
        })

        # Update Glicko-2 state for every player based on this game
        for p, (r, rd, sigma) in zip(bp, blue_state):
            gmap[p] = g2.update(r, rd, sigma, [(r_r, r_rd, float(bw))])
        for p, (r, rd, sigma) in zip(rp, red_state):
            gmap[p] = g2.update(r, rd, sigma, [(b_r, b_rd, float(1 - bw))])

    return pd.DataFrame(rows)


def train_eval(feats: list[str], label: str,
               train: pd.DataFrame, tests: dict[str, pd.DataFrame]) -> None:
    print(f'\n=== {label}  features={feats} ===')
    for f in feats: train[f] = train[f].fillna(FILL[f])
    X_tr = train[feats].values.astype(float)
    y_tr = train['blue_win'].values.astype(int)

    scaler = StandardScaler().fit(X_tr)
    lr = LogisticRegression(C=1.0, max_iter=5000, solver='lbfgs').fit(scaler.transform(X_tr), y_tr)

    coefs = dict(zip(feats, lr.coef_[0]))
    print(f'  coefs:   ' + '   '.join(f'{k}={v:+.3f}' for k, v in coefs.items()))
    print(f'  intercept={lr.intercept_[0]:+.3f}')

    for name, df in tests.items():
        for f in feats: df[f] = df[f].fillna(FILL[f])
        X_te = df[feats].values.astype(float)
        y_te = df['blue_win'].values.astype(int)
        p = lr.predict_proba(scaler.transform(X_te))[:, 1]
        ll = log_loss(y_te, np.clip(p, 1e-6, 1 - 1e-6))
        br = brier_score_loss(y_te, p)
        print(f'  {name:8s} ({len(df):,} games): LL {ll:.4f}   Brier {br:.4f}')


def main():
    print(f'Loading games_with_odds.csv...')
    games = pd.read_csv(GAMES_CSV, low_memory=False)
    games['date'] = pd.to_datetime(games['date'], utc=True)
    games['year'] = games['year'].astype(int)
    print(f'  {len(games):,} games')

    print(f'Loading features.csv...')
    feats = pd.read_csv(FEATURES_CSV, low_memory=False)
    feats['date'] = pd.to_datetime(feats['date'], utc=True)
    print(f'  {len(feats):,} feature rows')

    print(f'Replaying Glicko-2 over all games...')
    glk = replay_glicko(games)
    print(f'  {len(glk):,} Glicko snapshots produced')

    print(f'Merging features ⊕ glicko...')
    df = feats.merge(glk, on='gameid', how='left')
    print(f'  {len(df):,} merged rows;   glicko coverage: '
          f'{df["glicko_r_diff"].notna().mean()*100:.1f}%')

    # Drop rows missing the target or that didn't merge cleanly
    df = df.dropna(subset=['blue_win', 'glicko_r_diff', 'elo_diff'])
    df['year'] = df['year'].astype(int)
    print(f'  after cleanup: {len(df):,} rows  ({df.year.min()}-{df.year.max()})')

    train = df[df['year'] == 2024].copy()
    tests = {
        '2025':  df[df['year'] == 2025].copy(),
        '2026':  df[df['year'] == 2026].copy(),
        'all OOS': df[df['year'].isin([2025, 2026])].copy(),
    }
    print(f'\nTrain: {len(train):,}  Test 2025: {len(tests["2025"]):,}  '
          f'Test 2026: {len(tests["2026"]):,}')

    train_eval(ELO_FEATS,     'A. ELO baseline (prod)',           train, tests)
    train_eval(GLK_FEATS,     'B. Glicko-2 swap',                 train, tests)
    train_eval(GLK_UNC_FEATS, 'C. Glicko-2 + phi (uncertainty)',  train, tests)


if __name__ == '__main__':
    main()
