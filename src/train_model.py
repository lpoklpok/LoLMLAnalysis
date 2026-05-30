"""
train_model.py
Trains logistic regression on 2024-2025 pre-game features and evaluates
raw log loss on all 2026 (LCK/LEC) against coin flip and market odds.

No temperature scaling: 30-day ELO decay already compresses tail
overconfidence, so raw predictions are better calibrated than post-scaling.

Output: data/processed/predictions.csv
"""

import os
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'

TARGET_LEAGUES = {'LCK', 'LEC'}

POSITIONS     = ['top', 'jng', 'mid', 'bot', 'sup']
ROLE_FEATS    = [f'{p}_elo_diff' for p in POSITIONS]
ROLE_SQ_FEATS = [f'{p}_elo_diff_sq' for p in POSITIONS]

GD15_FEATS  = ['gd15_diff']
GD15_R_FEATS = [f'{p}_gd15_diff' for p in POSITIONS]

FEATURES_ELO       = ['elo_diff']
FEATURES_ELO_SQ    = ['elo_diff', 'elo_diff_signed_sq']
FEATURES_FULL      = ['elo_diff', 'rwr_diff', 'h2h_wr']
FEATURES_FULL_SQ   = ['elo_diff', 'elo_diff_signed_sq', 'rwr_diff', 'h2h_wr']
FEATURES_ROLE      = ROLE_FEATS + ['rwr_diff', 'h2h_wr']
FEATURES_ROLE_SQ   = ROLE_FEATS + ROLE_SQ_FEATS + ['rwr_diff', 'h2h_wr']
FEATURES_GD15      = ['elo_diff', 'rwr_diff', 'h2h_wr'] + GD15_FEATS
FEATURES_GD15_ROLE = ROLE_FEATS + ['rwr_diff', 'h2h_wr'] + GD15_R_FEATS
FEATURES_OUTPERF   = ['elo_diff', 'rwr_diff', 'h2h_wr', 'outperf_diff']
FEATURES_KITCHEN   = ['elo_diff', 'rwr_diff', 'h2h_wr', 'gd15_diff', 'outperf_diff']
FEATURES_REST      = ['elo_diff', 'elo_diff_signed_sq', 'rwr_diff', 'h2h_wr', 'days_since_diff']

FILL_VALUES = {
    'elo_diff': 0.0, 'elo_diff_signed_sq': 0.0,
    'rwr_diff': 0.0, 'h2h_wr': 0.5,
    'gd15_diff': 0.0, 'outperf_diff': 0.0,
    'days_since_diff': 0.0,
    **{f: 0.0 for f in ROLE_FEATS},
    **{f: 0.0 for f in ROLE_SQ_FEATS},
    **{f: 0.0 for f in GD15_R_FEATS},
}


def load_data() -> pd.DataFrame:
    df = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    return df


def evaluate(name: str, y_true: np.ndarray, y_pred: np.ndarray) -> float:
    ll = log_loss(y_true, y_pred)
    print(f"  {name:<35} log loss = {ll:.4f}")
    return ll


def fit(feats, X_tr, y_tr):
    m = Pipeline([('scaler', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(X_tr[feats].fillna(FILL_VALUES), y_tr)
    return m


def run():
    df = load_data()
    df = df[df['league'].isin(TARGET_LEAGUES)].copy()

    train = df[df['year'].isin([2024, 2025])].copy()
    test  = df[df['year'] == 2026].copy()

    print(f"Leagues: {sorted(TARGET_LEAGUES)}")
    print(f"Train: {len(train):,} games (2024–2025)")
    print(f"Test:  {len(test):,} games (all 2026)\n")

    # Add per-role squared ELO features
    for split_df in [train, test]:
        for pos in POSITIONS:
            split_df[f'{pos}_elo_diff_sq'] = split_df[f'{pos}_elo_diff'] ** 2

    y_train   = train['blue_win'].values
    y_test    = test['blue_win'].values
    has_odds  = test['q_blue_win'].notna()
    n_odds    = has_odds.sum()

    lr_elo    = fit(FEATURES_ELO,    train, y_train)
    lr_full   = fit(FEATURES_FULL,   train, y_train)
    lr_role   = fit(FEATURES_ROLE,   train, y_train)
    lr_rsq    = fit(FEATURES_ROLE_SQ, train, y_train)
    lr_gd15   = fit(FEATURES_GD15,   train, y_train)
    lr_gd15r  = fit(FEATURES_GD15_ROLE, train, y_train)
    lr_op     = fit(FEATURES_OUTPERF,  train, y_train)
    lr_kit    = fit(FEATURES_KITCHEN,  train, y_train)
    lr_elosq  = fit(FEATURES_ELO_SQ,  train, y_train)
    lr_fullsq = fit(FEATURES_FULL_SQ, train, y_train)
    lr_rest   = fit(FEATURES_REST,    train, y_train)

    def pred(m, feats):
        return m.predict_proba(test[feats].fillna(FILL_VALUES))[:, 1]

    pred_market = test['q_blue_win'].fillna(0.5).values

    print(f"=== 2026 full year — games with odds ({n_odds:,}) ===")
    if n_odds == 0:
        print("  (no 2026 games with odds in this run — skipping log-loss comparison)")
    else:
        yo = y_test[has_odds]
        evaluate("Coin flip",               yo, np.full(n_odds, 0.5))
        evaluate("Market odds",             yo, pred_market[has_odds])
        evaluate("LR — ELO only",           yo, pred(lr_elo,    FEATURES_ELO)[has_odds])
        evaluate("LR — full",               yo, pred(lr_full,   FEATURES_FULL)[has_odds])
        evaluate("LR — role diffs",         yo, pred(lr_role,   FEATURES_ROLE)[has_odds])
        evaluate("LR — role+sq",            yo, pred(lr_rsq,    FEATURES_ROLE_SQ)[has_odds])
        evaluate("LR — full + gd15",        yo, pred(lr_gd15,   FEATURES_GD15)[has_odds])
        evaluate("LR — role + gd15/role",   yo, pred(lr_gd15r,  FEATURES_GD15_ROLE)[has_odds])
        evaluate("LR — full + outperf",     yo, pred(lr_op,     FEATURES_OUTPERF)[has_odds])
        evaluate("LR — gd15 + outperf",     yo, pred(lr_kit,    FEATURES_KITCHEN)[has_odds])
        evaluate("LR — elo + signed_sq",    yo, pred(lr_elosq,  FEATURES_ELO_SQ)[has_odds])
        evaluate("LR — full + signed_sq",   yo, pred(lr_fullsq, FEATURES_FULL_SQ)[has_odds])
        evaluate("LR — full+sq + rest",     yo, pred(lr_rest,   FEATURES_REST)[has_odds])

    print("\n=== Full + outperf coefficients ===")
    for feat, coef in zip(FEATURES_OUTPERF, lr_op.named_steps['lr'].coef_[0]):
        print(f"  {feat:<22} {coef:+.4f}")

    print("\n=== Kitchen sink coefficients ===")
    for feat, coef in zip(FEATURES_KITCHEN, lr_kit.named_steps['lr'].coef_[0]):
        print(f"  {feat:<22} {coef:+.4f}")

    print("\n=== Full + signed_sq coefficients ===")
    for feat, coef in zip(FEATURES_FULL_SQ, lr_fullsq.named_steps['lr'].coef_[0]):
        print(f"  {feat:<22} {coef:+.4f}")

    # --- Save predictions (all 2025+2026 for website) ---
    all_out      = df[df['year'] >= 2025].copy()
    for split_df in [all_out]:
        for pos in POSITIONS:
            split_df[f'{pos}_elo_diff_sq'] = split_df[f'{pos}_elo_diff'] ** 2

    out = all_out[['gameid', 'date', 'league', 'playoffs', 'blue_team', 'red_team',
                   'blue_win', 'q_blue_win']].copy()
    out['pred_elo']  = lr_elo.predict_proba(all_out[FEATURES_ELO].fillna(FILL_VALUES))[:, 1]
    out['pred_full'] = lr_full.predict_proba(all_out[FEATURES_FULL].fillna(FILL_VALUES))[:, 1]
    out['pred_op']   = lr_op.predict_proba(all_out[FEATURES_OUTPERF].fillna(FILL_VALUES))[:, 1]
    out.to_csv(PROCESSED_DIR / 'predictions.csv', index=False)
    print(f"\nPredictions saved to predictions.csv")


if __name__ == '__main__':
    run()
