"""
train_model.py
Trains logistic regression and XGBoost on pre-game features and evaluates
log loss against two baselines: coin flip and market odds.

Train: 2024 games
Test:  2025-2026 games

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
from xgboost import XGBClassifier

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'

FEATURES_ELO  = ['elo_diff']
FEATURES_FULL = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs']
FILL_VALUES   = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5, 'playoffs': 0}


def load_data() -> pd.DataFrame:
    df = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    return df


def evaluate(name: str, y_true: np.ndarray, y_pred: np.ndarray) -> float:
    ll = log_loss(y_true, y_pred)
    print(f"  {name:<25} log loss = {ll:.4f}")
    return ll


def run():
    df = load_data()

    train = df[df['year'] == 2024].copy()
    test  = df[df['year'] >= 2025].copy()

    print(f"Train: {len(train):,} games (2024)")
    print(f"Test:  {len(test):,} games (2025-2026)\n")

    y_train = train['blue_win'].values
    y_test  = test['blue_win'].values

    # --- ELO-only Logistic Regression ---
    X_train_elo = train[FEATURES_ELO].fillna(FILL_VALUES)
    X_test_elo  = test[FEATURES_ELO].fillna(FILL_VALUES)
    lr_elo = Pipeline([
        ('scaler', StandardScaler()),
        ('lr',     LogisticRegression(max_iter=1000)),
    ])
    lr_elo.fit(X_train_elo, y_train)
    pred_elo = lr_elo.predict_proba(X_test_elo)[:, 1]

    # --- Full Logistic Regression ---
    X_train_full = train[FEATURES_FULL].fillna(FILL_VALUES)
    X_test_full  = test[FEATURES_FULL].fillna(FILL_VALUES)
    lr_full = Pipeline([
        ('scaler', StandardScaler()),
        ('lr',     LogisticRegression(max_iter=1000)),
    ])
    lr_full.fit(X_train_full, y_train)
    pred_full = lr_full.predict_proba(X_test_full)[:, 1]

    # --- Baselines ---
    pred_coin   = np.full(len(y_test), 0.5)
    pred_market = test['q_blue_win'].fillna(0.5).values
    has_odds    = test['q_blue_win'].notna()
    n_odds      = has_odds.sum()

    print("=== Full test set ===")
    evaluate("Coin flip (50/50)",      y_test, pred_coin)
    evaluate("LR — ELO only",          y_test, pred_elo)
    evaluate("LR — ELO + form + H2H",  y_test, pred_full)

    print(f"\n=== Games with market odds ({n_odds:,} games) ===")
    evaluate("Coin flip (50/50)",      y_test[has_odds], pred_coin[has_odds])
    evaluate("Market odds",            y_test[has_odds], pred_market[has_odds])
    evaluate("LR — ELO only",          y_test[has_odds], pred_elo[has_odds])
    evaluate("LR — ELO + form + H2H",  y_test[has_odds], pred_full[has_odds])

    # --- Coefficients ---
    print("\n=== ELO-only coefficients ===")
    print(f"  elo_diff  {lr_elo.named_steps['lr'].coef_[0][0]:+.4f}")

    print("\n=== Full model coefficients ===")
    for feat, coef in zip(FEATURES_FULL, lr_full.named_steps['lr'].coef_[0]):
        print(f"  {feat:<20} {coef:+.4f}")

    # --- Save predictions ---
    out = test[['gameid', 'date', 'league', 'playoffs', 'blue_team', 'red_team',
                'blue_win', 'q_blue_win']].copy()
    out['pred_elo']  = pred_elo
    out['pred_full'] = pred_full
    out.to_csv(PROCESSED_DIR / 'predictions.csv', index=False)
    print(f"\nPredictions saved to predictions.csv")


if __name__ == '__main__':
    run()
