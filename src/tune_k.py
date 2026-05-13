"""
tune_k.py
Grid search over ELO K-factor values.
For each K: rebuilds ELO features, trains logistic regression on 2024,
evaluates log loss on 2025-2026. Picks the best K.
"""

import os
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'
MAJOR_LEAGUES = {'LEC', 'LPL', 'LCK'}
POSITIONS     = ['top', 'jng', 'mid', 'bot', 'sup']
ELO_SCALE     = 400
INITIAL_ELO   = 1500
FEATURES      = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs']
FILL_VALUES   = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5, 'playoffs': 0}
K_GRID        = [4, 8, 16, 24, 32, 48, 64, 96, 128]


def _expected(elo_a, elo_b):
    return 1.0 / (1.0 + 10 ** ((elo_b - elo_a) / ELO_SCALE))


def _team_elo(players, elo_map):
    return np.mean([elo_map.get(p, INITIAL_ELO) for p in players])


def _rolling_winrate(history, n=10):
    if len(history) < 3:
        return float('nan')
    recent = history[-n:]
    return sum(recent) / len(recent)


def build_features_for_k(df: pd.DataFrame, k: float) -> pd.DataFrame:
    elo_map      = {}
    team_history = defaultdict(list)
    h2h          = defaultdict(list)
    rows         = []

    for g in df.itertuples(index=False):
        blue_players = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        red_players  = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]

        if any(pd.isna(x) for x in blue_players + red_players):
            continue

        blue_team = str(g.blue_team_teamname)
        red_team  = str(g.red_team_teamname)
        blue_win  = int(g.blue_team_result)

        blue_elo = _team_elo(blue_players, elo_map)
        red_elo  = _team_elo(red_players,  elo_map)
        blue_rwr = _rolling_winrate(team_history[blue_team])
        red_rwr  = _rolling_winrate(team_history[red_team])

        pair     = tuple(sorted([blue_team, red_team]))
        h2h_hist = h2h[pair]
        if len(h2h_hist) >= 2:
            h2h_wr = sum(h2h_hist) / len(h2h_hist) if pair[0] == blue_team \
                     else 1 - sum(h2h_hist) / len(h2h_hist)
        else:
            h2h_wr = float('nan')

        if g.league in MAJOR_LEAGUES:
            rows.append({
                'year':     g.year,
                'elo_diff': blue_elo - red_elo,
                'rwr_diff': blue_rwr - red_rwr if not (pd.isna(blue_rwr) or pd.isna(red_rwr)) else np.nan,
                'h2h_wr':   h2h_wr,
                'playoffs': g.playoffs,
                'q_blue_win': g.q_blue_win,
                'blue_win': blue_win,
            })

        # Update ELO
        for p in blue_players:
            r = elo_map.get(p, INITIAL_ELO)
            elo_map[p] = r + k * (blue_win - _expected(r, red_elo))
        for p in red_players:
            r = elo_map.get(p, INITIAL_ELO)
            elo_map[p] = r + k * ((1 - blue_win) - _expected(r, blue_elo))

        team_history[blue_team].append(blue_win)
        team_history[red_team].append(1 - blue_win)
        h2h[pair].append(blue_win if pair[0] == blue_team else 1 - blue_win)

    return pd.DataFrame(rows)


def run():
    raw = pd.read_csv(PROCESSED_DIR / 'games_with_odds.csv', low_memory=False)
    raw['date'] = pd.to_datetime(raw['date'], utc=True)
    raw = raw.sort_values('date').reset_index(drop=True)

    print(f"{'K':>6}  {'Log Loss':>10}  {'vs Market':>10}")
    print("-" * 32)

    results = []
    for k in K_GRID:
        features = build_features_for_k(raw, k)

        train = features[features['year'] == 2024]
        test  = features[features['year'] >= 2025]

        X_train = train[FEATURES].fillna(FILL_VALUES)
        X_test  = test[FEATURES].fillna(FILL_VALUES)
        y_train = train['blue_win'].values
        y_test  = test['blue_win'].values

        model = Pipeline([('scaler', StandardScaler()),
                          ('lr', LogisticRegression(max_iter=1000))])
        model.fit(X_train, y_train)
        pred = model.predict_proba(X_test)[:, 1]
        ll = log_loss(y_test, pred)

        # Market comparison on games with odds
        has_odds = test['q_blue_win'].notna()
        market_ll = log_loss(y_test[has_odds], test['q_blue_win'].fillna(0.5).values[has_odds])
        our_ll    = log_loss(y_test[has_odds], pred[has_odds])
        gap       = our_ll - market_ll

        print(f"{k:>6}  {ll:>10.4f}  {gap:>+10.4f}")
        results.append((k, ll, gap))

    best_k, best_ll, _ = min(results, key=lambda x: x[1])
    print(f"\nBest K = {best_k}  (log loss = {best_ll:.4f})")
    return best_k


if __name__ == '__main__':
    run()
