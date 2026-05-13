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

FEATURES    = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs']
FILL_VALUES = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5, 'playoffs': 0}


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

    X_train = train[FEATURES].fillna(FILL_VALUES)
    X_test  = test[FEATURES].fillna(FILL_VALUES)
    y_train = train['blue_win'].values
    y_test  = test['blue_win'].values

    # --- Logistic Regression ---
    lr = Pipeline([
        ('scaler', StandardScaler()),
        ('lr',     LogisticRegression(max_iter=1000)),
    ])
    lr.fit(X_train, y_train)
    pred_lr = lr.predict_proba(X_test)[:, 1]

    # --- XGBoost ---
    xgb = XGBClassifier(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        use_label_encoder=False,
        eval_metric='logloss',
        random_state=42,
    )
    xgb.fit(X_train, y_train)
    pred_xgb = xgb.predict_proba(X_test)[:, 1]

    # --- Baselines ---
    pred_coin   = np.full(len(y_test), 0.5)
    pred_market = test['q_blue_win'].fillna(0.5).values
    has_odds    = test['q_blue_win'].notna()
    n_odds      = has_odds.sum()

    print("=== Full test set ===")
    evaluate("Coin flip (50/50)",   y_test, pred_coin)
    evaluate("Logistic Regression", y_test, pred_lr)
    evaluate("XGBoost",             y_test, pred_xgb)

    print(f"\n=== Games with market odds ({n_odds:,} games) ===")
    evaluate("Coin flip (50/50)",   y_test[has_odds], pred_coin[has_odds])
    evaluate("Market odds",         y_test[has_odds], pred_market[has_odds])
    evaluate("Logistic Regression", y_test[has_odds], pred_lr[has_odds])
    evaluate("XGBoost",             y_test[has_odds], pred_xgb[has_odds])

    # --- LR Coefficients ---
    print("\n=== Logistic Regression coefficients ===")
    coefs = lr.named_steps['lr'].coef_[0]
    for feat, coef in zip(FEATURES, coefs):
        print(f"  {feat:<20} {coef:+.4f}")

    # --- XGBoost feature importance ---
    print("\n=== XGBoost feature importance ===")
    importances = xgb.feature_importances_
    for feat, imp in sorted(zip(FEATURES, importances), key=lambda x: -x[1]):
        print(f"  {feat:<20} {imp:.4f}")

    # --- Save predictions (best model = whichever has lower log loss) ---
    out = test[['gameid', 'date', 'league', 'blue_team', 'red_team',
                'blue_win', 'q_blue_win']].copy()
    out['pred_lr']  = pred_lr
    out['pred_xgb'] = pred_xgb
    out.to_csv(PROCESSED_DIR / 'predictions.csv', index=False)
    print(f"\nPredictions saved to predictions.csv")


if __name__ == '__main__':
    run()
