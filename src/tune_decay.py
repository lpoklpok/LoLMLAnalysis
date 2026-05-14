"""
tune_decay.py
Proper two-stage evaluation:
  Stage 1 — tune decay: train 2024, test 2025  (pick best setting)
  Stage 2 — blind test:  train 2024+2025, test 2026  (validate chosen setting)

Model: elo_diff + elo_diff_signed_sq + rwr_diff + h2h_wr + playoffs (raw)
"""

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from feature_engineering import build_features

TARGET = {'LCK', 'LEC'}
FEATS  = ['elo_diff', 'elo_diff_signed_sq', 'rwr_diff', 'h2h_wr', 'playoffs']
FILL   = {'elo_diff': 0.0, 'elo_diff_signed_sq': 0.0,
          'rwr_diff': 0.0, 'h2h_wr': 0.5, 'playoffs': 0}


def run(df, train_years, test_year):
    df = df[df['league'].isin(TARGET)].copy()
    train = df[df['year'].isin(train_years)]
    test  = df[(df['year'] == test_year) & df['q_blue_win'].notna()]
    m = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(train[FEATS].fillna(FILL), train['blue_win'].values)
    preds = m.predict_proba(test[FEATS].fillna(FILL))[:, 1]
    return log_loss(test['blue_win'].values, preds), log_loss(test['blue_win'].values, test['q_blue_win'].values)


configs = []

# Continuous half-life
for hl in [None, 15, 30, 60, 90, 180, 365]:
    configs.append(dict(halflife=hl, reset=None,
                        label=f"halflife={'none':>4}" if hl is None else f"halflife={hl:>4}d"))

# Split reset only
for factor in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75]:
    configs.append(dict(halflife=None, reset=factor,
                        label=f"split_reset={factor:.2f}"))

# Best combos
for hl in [90, 180, 365]:
    for factor in [0.2, 0.3, 0.4]:
        configs.append(dict(halflife=hl, reset=factor,
                            label=f"hl={hl}d + reset={factor:.1f}"))

print(f"{'config':<35} {'2025 val':>9}  {'2026 test':>9}  {'mkt25':>7}  {'mkt26':>7}")
print("-" * 72)

results = []
for c in configs:
    df = build_features(decay_halflife=c['halflife'], split_reset_factor=c['reset'])
    ll25, mkt25 = run(df, [2024],       2025)
    ll26, mkt26 = run(df, [2024, 2025], 2026)
    results.append((c['label'], ll25, ll26, mkt25, mkt26))
    print(f"  {c['label']:<33} {ll25:>9.4f}  {ll26:>9.4f}  {mkt25:>7.4f}  {mkt26:>7.4f}")

print()
best_val = min(results, key=lambda x: x[1])
print(f"Best on 2025 val:  {best_val[0]}  →  val={best_val[1]:.4f}  test2026={best_val[2]:.4f}")
