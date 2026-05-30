"""Test whether multi-window team-vs-MODEL residual features beat the existing
single-window team-vs-MARKET feature (outperf_diff).

For each team, we track win - elo_implied_p per game (residual vs the model's
ELO-implied probability). Then we expose rolling means over multiple windows:

  outperf_vs_elo_10:  mean residual over last 10 games
  outperf_vs_elo_5:   mean residual over last 5 games
  outperf_vs_elo_2:   mean residual over last 2 games

Each becomes a paired-difference feature blue_team − red_team, mirroring
elo_diff / outperf_diff conventions.

Trains LR with several feature stacks, holds out 2025 + 2026 OOS, prints
log loss + Brier + coefficients.
"""
from __future__ import annotations

import math
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

WINDOWS = [10, 5, 2]


# ── Per-team rolling residual computation ──────────────────────────────────

def compute_residual_features(games_df: pd.DataFrame) -> pd.DataFrame:
    """Walk games chronologically, maintain ELO state + per-team residuals.
    Return DataFrame keyed by gameid with the new pre-game features."""
    elo_map: dict[str, float] = {}
    team_residuals: dict[str, deque] = defaultdict(lambda: deque(maxlen=max(WINDOWS)))
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

        # Pre-game ELO snapshot
        start = _starting_elo(league)
        b_elo_avg = sum(elo_map.get(p, start) for p in bp) / 5
        r_elo_avg = sum(elo_map.get(p, start) for p in rp) / 5
        p_blue = 1.0 / (1.0 + 10 ** ((r_elo_avg - b_elo_avg) / ELO_SCALE))

        # Rolling residual features per team
        row: dict = {'gameid': str(g.gameid)}
        for w in WINDOWS:
            b_recent = list(team_residuals[b_team])[-w:]
            r_recent = list(team_residuals[r_team])[-w:]
            b_out = float(np.mean(b_recent)) if len(b_recent) >= min(w, 2) else float('nan')
            r_out = float(np.mean(r_recent)) if len(r_recent) >= min(w, 2) else float('nan')
            row[f'outperf_vs_elo_{w}']      = b_out if not np.isnan(b_out) else 0.0
            row[f'outperf_vs_elo_{w}_diff'] = (b_out - r_out) if (not np.isnan(b_out) and not np.isnan(r_out)) else 0.0
        rows.append(row)

        # Update residuals AFTER recording the pre-game snapshot
        team_residuals[b_team].append(bw - p_blue)
        team_residuals[r_team].append((1 - bw) - (1 - p_blue))

        # Update ELO (production rule)
        k_scale = SERIES_K_ALPHA if year >= 2025 else 1.0
        for p, e in zip(bp, [elo_map.get(p, start) for p in bp]):
            exp_i = 1.0 / (1.0 + 10 ** ((r_elo_avg - e) / ELO_SCALE))
            elo_map[p] = e + K_FACTOR * k_scale * (bw - exp_i)
        for p, e in zip(rp, [elo_map.get(p, start) for p in rp]):
            exp_i = 1.0 / (1.0 + 10 ** ((b_elo_avg - e) / ELO_SCALE))
            elo_map[p] = e + K_FACTOR * k_scale * ((1 - bw) - exp_i)

    return pd.DataFrame(rows)


# ── LR training + evaluation ───────────────────────────────────────────────

BASE_FEATS  = ['elo_diff', 'rwr_diff', 'h2h_wr', 'gd15_diff']  # matches export_model_params
PROD_FEATS  = BASE_FEATS + ['outperf_diff']

FILL = {
    'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5, 'gd15_diff': 0.0,
    'outperf_diff': 0.0,
    'outperf_vs_elo_10_diff': 0.0,
    'outperf_vs_elo_5_diff':  0.0,
    'outperf_vs_elo_2_diff':  0.0,
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
        X_te = df[feats].values.astype(float)
        y_te = df['blue_win'].values.astype(int)
        p = lr.predict_proba(scaler.transform(X_te))[:, 1]
        ll = log_loss(y_te, np.clip(p, 1e-6, 1 - 1e-6))
        br = brier_score_loss(y_te, p)
        print(f'  {name:8s} ({len(df):>5,} games):  LL {ll:.4f}   Brier {br:.4f}')


def main():
    print(f'Loading games + features...')
    games = pd.read_csv(GAMES_CSV, low_memory=False)
    games['date'] = pd.to_datetime(games['date'], utc=True)
    feats = pd.read_csv(FEATURES_CSV, low_memory=False)
    feats['date'] = pd.to_datetime(feats['date'], utc=True)

    print(f'Replaying games to build multi-window residual features...')
    new_feats = compute_residual_features(games)
    print(f'  {len(new_feats):,} game rows produced')

    df = feats.merge(new_feats, on='gameid', how='left')
    df = df.dropna(subset=['blue_win', 'elo_diff'])
    df['year'] = df['year'].astype(int)
    print(f'Merged dataset: {len(df):,} rows ({df.year.min()}-{df.year.max()})')

    train = df[df['year'] == 2024].copy()
    tests = {
        '2025':   df[df['year'] == 2025].copy(),
        '2026':   df[df['year'] == 2026].copy(),
        'all OOS': df[df['year'].isin([2025, 2026])].copy(),
    }
    print(f'Train: {len(train):,}   Test 2025: {len(tests["2025"]):,}   Test 2026: {len(tests["2026"]):,}')

    train_eval(PROD_FEATS,                                                          'A. Production baseline (with outperf_diff vs market)', train, tests)
    train_eval(BASE_FEATS + ['outperf_vs_elo_10_diff'],                             'B. + 10g residual vs ELO',                               train, tests)
    train_eval(BASE_FEATS + ['outperf_vs_elo_5_diff'],                              'C. + 5g residual vs ELO',                                train, tests)
    train_eval(BASE_FEATS + ['outperf_vs_elo_2_diff'],                              'D. + 2g residual vs ELO',                                train, tests)
    train_eval(BASE_FEATS + ['outperf_vs_elo_10_diff', 'outperf_vs_elo_5_diff', 'outperf_vs_elo_2_diff'],
                                                                                    'E. + all 3 windows',                                     train, tests)
    train_eval(PROD_FEATS + ['outperf_vs_elo_10_diff', 'outperf_vs_elo_5_diff', 'outperf_vs_elo_2_diff'],
                                                                                    'F. Production + all 3 windows (kitchen sink)',           train, tests)


if __name__ == '__main__':
    main()
