"""
train_model_v2.py
A gradient-boosting alternative to the production logistic-regression model.
Uses all pre-game features already engineered in features_all.csv (40+ cols),
plus walk-forward CV so we don't fool ourselves with random-split log loss.

Run:
    python src/train_model_v2.py
    python src/train_model_v2.py --leagues LCK LPL LEC LCS
    python src/train_model_v2.py --train-years 2024 2025 --eval-year 2026

Outputs:
    data/processed/predictions_v2.csv  — per-game predictions for the eval set
    stdout                              — fold-by-fold log loss vs LR baseline
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score, brier_score_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    import xgboost as xgb
except ImportError:
    print('Installing xgboost...')
    import subprocess
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'xgboost'], check=True)
    import xgboost as xgb


PROCESSED = Path(__file__).resolve().parent.parent / 'data' / 'processed'
MAJOR     = ['LCK', 'LPL', 'LEC', 'LCS']

# Every pre-game feature available in features_all.csv. Excludes obvious
# post-game leakage (game_len, kills, dragons), keeps only what we'd know
# before the first move.
FEATURES_FULL = [
    # ELO
    'elo_diff', 'elo_diff_signed_sq',
    'top_elo_diff', 'jng_elo_diff', 'mid_elo_diff', 'bot_elo_diff', 'sup_elo_diff',
    # Recent win rate
    'rwr_diff', 'rwr_exp_diff',
    # Head-to-head
    'h2h_wr', 'role_h2h_wr', 'role_h2h_signed_sq',
    # Gold@15 (rolling — IS a pre-game feature even though the underlying
    # observations come from past games)
    'gd15_diff', 'gd15_exp_diff',
    'top_gd15_diff', 'jng_gd15_diff', 'mid_gd15_diff', 'bot_gd15_diff', 'sup_gd15_diff',
    # Outperformance vs market / vs ELO
    'outperf_diff', 'outperf_exp_diff', 'outperf_elo_diff', 'outperf_elo_exp_diff',
    # Rolling objectives (averaged across past games — still pre-game)
    'first_blood_diff', 'first_dragon_diff', 'first_tower_diff',
    # Context flags
    'playoffs', 'game', 'blue_first_pick', 'series_score',
    'days_since_diff',
]

# Leaner set — drops collinear / redundant columns. Goal: keep one
# representative per concept and let XGB find interactions.
FEATURES_LEAN = [
    'elo_diff', 'elo_diff_signed_sq',
    'rwr_diff', 'h2h_wr',
    'gd15_diff', 'outperf_diff',
    'playoffs', 'game', 'blue_first_pick', 'series_score',
    'days_since_diff',
    'first_dragon_diff',
]

# v3: lean + champion-level features from build_champ_features.py
FEATURES_CHAMP = FEATURES_LEAN + [
    'avg_player_champ_familiarity_diff',
    'avg_player_champ_wr_diff',
    'avg_champ_meta_wr_diff',
    'roster_stability_diff',
]

# Conservative fill values for NaN feature cells (matches the production model)
FILL = {f: 0.0 for f in FEATURES_FULL}
for f in ['h2h_wr', 'role_h2h_wr']:
    FILL[f] = 0.5
for f in ['playoffs', 'game', 'blue_first_pick', 'series_score']:
    FILL[f] = 0
# Champ features: 0 is the neutral fill for "diff" features
for f in ['avg_player_champ_familiarity_diff', 'avg_player_champ_wr_diff',
          'avg_champ_meta_wr_diff', 'roster_stability_diff']:
    FILL[f] = 0.0


def load_data(leagues: list[str] | None) -> pd.DataFrame:
    df = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    # Merge champ-level features if available
    champ_path = PROCESSED / 'champ_features.csv'
    if champ_path.exists():
        ch = pd.read_csv(champ_path, low_memory=False)
        df = df.merge(ch, on='gameid', how='left')
        print(f'  merged {len(ch.columns)-1} champion features')
    if leagues:
        df = df[df['league'].isin(leagues)].copy()
    df = df.sort_values('date').reset_index(drop=True)
    return df


def fit_lr(train: pd.DataFrame, features: list[str]):
    m = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(train[features].fillna(FILL), train['blue_win'].values)
    return m


def fit_xgb(train: pd.DataFrame, features: list[str], calibrate: bool = False):
    """XGBoost with aggressive regularization + early stopping. ~3.5k training
    games is small for boosting, so we keep depth shallow and min_child_weight
    high to avoid memorizing individual matchups. Chronological 10% val
    split inside `train` for early stopping. Optional isotonic calibration
    on top to fix any sigmoid distortion."""
    train = train.sort_values('date').reset_index(drop=True)
    cut = int(len(train) * 0.9)
    tr  = train.iloc[:cut]
    val = train.iloc[cut:]

    m = xgb.XGBClassifier(
        n_estimators=600,
        max_depth=3,           # shallower
        learning_rate=0.03,
        min_child_weight=20,   # stronger — needs 20+ samples to split
        subsample=0.8,
        colsample_bytree=0.7,
        reg_lambda=3.0,        # heavier L2
        reg_alpha=0.5,         # add L1
        objective='binary:logistic',
        eval_metric='logloss',
        tree_method='hist',
        verbosity=0,
        random_state=42,
        early_stopping_rounds=30,
    )
    m.fit(
        tr[features].fillna(FILL), tr['blue_win'].values,
        eval_set=[(val[features].fillna(FILL), val['blue_win'].values)],
        verbose=False,
    )

    if calibrate and len(val) >= 50:
        # Refit isotonic on the val predictions
        from sklearn.isotonic import IsotonicRegression
        val_p = m.predict_proba(val[features].fillna(FILL))[:, 1]
        cal = IsotonicRegression(out_of_bounds='clip')
        cal.fit(val_p, val['blue_win'].values)
        # Wrap as a thin object that exposes predict_proba like the bare model
        class _Calibrated:
            def __init__(self, base, cal, features, fill):
                self.base = base
                self.cal  = cal
                self.features = features
                self.fill = fill
            def predict_proba(self, X):
                p = self.base.predict_proba(X)[:, 1]
                p_cal = self.cal.predict(p)
                return np.column_stack([1 - p_cal, p_cal])
            @property
            def feature_importances_(self):
                return self.base.feature_importances_
        return _Calibrated(m, cal, features, FILL)
    return m


def evaluate(name: str, y_true, y_pred) -> dict:
    ll = log_loss(y_true, np.clip(y_pred, 1e-6, 1-1e-6))
    auc = roc_auc_score(y_true, y_pred) if len(np.unique(y_true)) == 2 else float('nan')
    brier = brier_score_loss(y_true, y_pred)
    return {'model': name, 'n': len(y_true), 'log_loss': ll, 'auc': auc, 'brier': brier}


def walk_forward_cv(df: pd.DataFrame, train_years: list[int],
                     eval_year: int, features: list[str]) -> pd.DataFrame:
    """Train on `train_years` (full), then evaluate month-by-month in `eval_year`.
    For each eval month, the training set is all of train_years + everything
    in eval_year prior to that month — so the model is always being tested
    on the future."""
    train_base = df[df['year'].isin(train_years)].copy()
    eval_df    = df[df['year'] == eval_year].copy()
    if len(train_base) == 0 or len(eval_df) == 0:
        raise RuntimeError(f'empty split: train={len(train_base)}, eval={len(eval_df)}')

    print(f'\nBase training set ({train_years}): {len(train_base):,} games')
    print(f'Eval set ({eval_year}): {len(eval_df):,} games')

    eval_df['month'] = eval_df['date'].dt.to_period('M')
    months = sorted(eval_df['month'].unique())
    print(f'Walk-forward across {len(months)} eval months: {[str(m) for m in months]}\n')

    rows = []
    for m in months:
        in_month  = eval_df[eval_df['month'] == m]
        before_m  = eval_df[eval_df['month'] < m]
        train_set = pd.concat([train_base, before_m], ignore_index=True)
        if len(in_month) == 0:
            continue
        lr_m  = fit_lr(train_set, features)
        xgb_m = fit_xgb(train_set, features)
        y     = in_month['blue_win'].values
        p_lr  = lr_m.predict_proba(in_month[features].fillna(FILL))[:, 1]
        p_xgb = xgb_m.predict_proba(in_month[features].fillna(FILL))[:, 1]
        e_lr  = evaluate('lr',  y, p_lr)
        e_xgb = evaluate('xgb', y, p_xgb)
        rows.append({'month': str(m), 'n': len(in_month),
                     'lr_ll':  e_lr['log_loss'],  'lr_auc':  e_lr['auc'],
                     'xgb_ll': e_xgb['log_loss'], 'xgb_auc': e_xgb['auc'],
                     'delta_ll': e_xgb['log_loss'] - e_lr['log_loss']})
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--leagues', nargs='+', default=MAJOR,
                         help='Leagues to include (default: major). Use "ALL" for everything.')
    parser.add_argument('--train-years', nargs='+', type=int, default=[2024, 2025])
    parser.add_argument('--eval-year', type=int, default=2026)
    args = parser.parse_args()

    leagues = None if args.leagues == ['ALL'] else args.leagues
    df = load_data(leagues)
    print(f'Loaded {len(df):,} games across {df["league"].nunique()} leagues '
          f'(years {df["year"].min()}–{df["year"].max()})')

    # Run all feature sets so we can see what helps
    for label, feats in [('FULL (30 feats)',  FEATURES_FULL),
                         ('LEAN (12 feats)',  FEATURES_LEAN),
                         ('CHAMP (16 feats)', FEATURES_CHAMP)]:
        print(f'\n{"#"*60}\n# Feature set: {label}\n{"#"*60}')
        cv = walk_forward_cv(df, args.train_years, args.eval_year, feats)
        if cv.empty:
            continue
        print('\nWalk-forward log loss by month:')
        print(cv.to_string(index=False, float_format=lambda v: f'{v:.4f}'))
        wlr  = (cv['lr_ll']  * cv['n']).sum() / cv['n'].sum()
        wxgb = (cv['xgb_ll'] * cv['n']).sum() / cv['n'].sum()
        delta = (wxgb - wlr) / wlr * 100
        sign = '−' if delta < 0 else '+'
        print(f'  weighted LR  log loss: {wlr:.4f}')
        print(f'  weighted XGB log loss: {wxgb:.4f}')
        print(f'  Δ = {sign}{abs(delta):.2f}%  ({"better" if delta < 0 else "worse"})')

    # Use LEAN for the final exported predictions
    cv = walk_forward_cv(df, args.train_years, args.eval_year, FEATURES_LEAN)
    # Use CHAMP feature set as the final exported model
    feats = FEATURES_CHAMP
    full_train = df[df['year'].isin(args.train_years + [args.eval_year])]
    final_xgb = fit_xgb(full_train, feats)
    print(f'\nFinal XGB (LEAN) trained on {len(full_train):,} games.')

    eval_df = df[df['year'] == args.eval_year].copy()
    eval_df['pred_xgb'] = final_xgb.predict_proba(eval_df[feats].fillna(FILL))[:, 1]
    out_cols = ['gameid', 'date', 'league', 'blue_team', 'red_team', 'blue_win',
                'q_blue_win', 'poly_blue_win_prob', 'pred_xgb']
    eval_df[[c for c in out_cols if c in eval_df.columns]].to_csv(
        PROCESSED / 'predictions_v2.csv', index=False)
    print(f'Wrote {PROCESSED / "predictions_v2.csv"} ({len(eval_df):,} predictions)')

    print('\n=== Top 12 features by XGB gain ===')
    imp = pd.DataFrame({'feature': feats,
                         'gain': final_xgb.feature_importances_,
                         }).sort_values('gain', ascending=False)
    print(imp.to_string(index=False, float_format=lambda v: f'{v:.4f}'))


if __name__ == '__main__':
    main()
