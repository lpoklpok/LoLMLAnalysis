"""Final LR feature sweep on the adaptive-K ELO scale. features.csv has just
been regenerated, so elo_diff is now the adaptive-K version and blue_surprise /
red_surprise are available as candidate features.

Train on 2024, OOS on 2025 + 2026, report LL + Brier per stack.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, brier_score_loss
from sklearn.preprocessing import StandardScaler

PROCESSED = Path(__file__).resolve().parent.parent / 'data' / 'processed'

BASE   = ['elo_diff', 'rwr_diff', 'h2h_wr', 'gd15_diff']
PROD   = BASE + ['outperf_diff']

FILL = {
    'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5, 'gd15_diff': 0.0,
    'outperf_diff': 0.0,
    'blue_surprise': 0.0, 'red_surprise': 0.0, 'surprise_diff': 0.0,
    'surprise_max': 0.0,
}


def evaluate(feats: list[str], label: str, train: pd.DataFrame, tests: dict[str, pd.DataFrame]) -> dict:
    print(f'\n=== {label}  ({len(feats)} feats) ===')
    for f in feats: train[f] = train[f].fillna(FILL.get(f, 0.0))
    X_tr = train[feats].values.astype(float)
    y_tr = train['blue_win'].values.astype(int)
    sc = StandardScaler().fit(X_tr)
    lr = LogisticRegression(C=1.0, max_iter=5000).fit(sc.transform(X_tr), y_tr)
    print('  coefs:  ' + '  '.join(f'{f}={c:+.3f}' for f, c in zip(feats, lr.coef_[0])))
    out = {}
    for name, df in tests.items():
        for f in feats: df[f] = df[f].fillna(FILL.get(f, 0.0))
        X = df[feats].values.astype(float)
        y = df['blue_win'].values.astype(int)
        p = lr.predict_proba(sc.transform(X))[:, 1]
        ll = log_loss(y, np.clip(p, 1e-6, 1 - 1e-6))
        br = brier_score_loss(y, p)
        out[name] = (ll, br)
        print(f'  {name:8s} ({len(df):>5,} games):  LL {ll:.4f}   Brier {br:.4f}')
    return out


def main():
    df = pd.read_csv(PROCESSED / 'features.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df['year'] = df['year'].astype(int)
    df['surprise_diff'] = df['blue_surprise'] - df['red_surprise']
    df['surprise_max']  = df[['blue_surprise', 'red_surprise']].max(axis=1)
    df = df.dropna(subset=['blue_win', 'elo_diff'])
    print(f'Loaded {len(df):,} feature rows ({df.year.min()}-{df.year.max()})')

    train = df[df['year'] == 2024].copy()
    tests = {
        '2025':    df[df['year'] == 2025].copy(),
        '2026':    df[df['year'] == 2026].copy(),
        'all OOS': df[df['year'].isin([2025, 2026])].copy(),
    }
    print(f'Train: {len(train):,}   Test 2025: {len(tests["2025"]):,}   Test 2026: {len(tests["2026"]):,}')

    results = {}
    results['A. Production (now adaptive ELO)'] = evaluate(PROD,                              'A. Production',          train, tests)
    results['B. Base (drop outperf_diff)']      = evaluate(BASE,                              'B. Base no outperf',     train, tests)
    results['C. + surprise_diff']               = evaluate(PROD + ['surprise_diff'],          'C. + surprise_diff',     train, tests)
    results['D. + surprise_max']                = evaluate(PROD + ['surprise_max'],           'D. + surprise_max',      train, tests)
    results['E. + both surprise feats']         = evaluate(PROD + ['surprise_diff', 'surprise_max'], 'E. + both', train, tests)
    results['F. Base + surprise_diff (no outperf_diff)'] = evaluate(BASE + ['surprise_diff'], 'F. Base + surprise_diff', train, tests)

    print('\n\n=== Summary (all OOS LL, lower is better) ===')
    base_ll = results['A. Production (now adaptive ELO)']['all OOS'][0]
    for k, v in results.items():
        ll = v['all OOS'][0]
        diff = (base_ll - ll) / base_ll * 100
        arrow = '↓' if diff > 0 else '↑'
        print(f'  {k:50s}  LL {ll:.4f}   {arrow} {abs(diff):+.2f}% vs A')


if __name__ == '__main__':
    main()
