"""
min_logloss.py
Finds the minimum achievable log loss on 2026 LCK/LEC/LPL games using all
available pre-game features. Train: 2024-2025. Test: 2026.

Pre-game features used:
  - Player ELO diff (tiered starting ELO, K=48)
  - Rolling win rate diff
  - Head-to-head win rate
  - Playoffs / game number in series
  - Rolling in-game stats from previous games:
      gold diff at 15, kill diff, first blood rate, first dragon rate,
      first tower rate, game length, dragons, barons, towers
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
from xgboost import XGBClassifier

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'
MAJOR_LEAGUES = {'LEC', 'LPL', 'LCK'}
POSITIONS     = ['top', 'jng', 'mid', 'bot', 'sup']
K_FACTOR      = 48
ELO_SCALE     = 400
ROLL_N        = 10  # rolling window for team stats

_ELO_TIER = {
    'LCK': 1620, 'LPL': 1620,
    'LEC': 1500,
    'LCS': 1380, 'LTA': 1380, 'LTA N': 1380, 'LTA S': 1380, 'LCKC': 1380,
}
_ELO_DEFAULT = 1260

def _start(league): return _ELO_TIER.get(league, _ELO_DEFAULT)
def _exp(a, b): return 1.0 / (1.0 + 10 ** ((b - a) / ELO_SCALE))
def _team_elo(players, elo_map, league):
    s = _start(league)
    return np.mean([elo_map.get(p, s) for p in players])

def _rolling(history, n=ROLL_N):
    if len(history) < 3: return float('nan')
    return np.mean(history[-n:])


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    elo_map       = {}
    team_wins     = defaultdict(list)
    h2h           = defaultdict(list)
    # Rolling in-game stat histories per team (from team's perspective)
    team_stats    = defaultdict(lambda: defaultdict(list))

    rows = []

    STAT_COLS = [
        'gold15',       # gold diff at 15 (team perspective)
        'kills',        # team kills
        'game_len',     # game length
        'first_blood',  # 1 if team got first blood
        'first_dragon', # 1 if team got first dragon
        'first_tower',  # 1 if team got first tower
        'dragons',      # total dragons
        'barons',       # total barons
        'towers',       # total towers
    ]

    for g in df.itertuples(index=False):
        bp = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        rp = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp):
            continue

        league    = g.league
        blue_team = str(g.blue_team_teamname)
        red_team  = str(g.red_team_teamname)
        blue_win  = int(g.blue_team_result)

        # --- ELO snapshot ---
        blue_elo = _team_elo(bp, elo_map, league)
        red_elo  = _team_elo(rp, elo_map, league)

        # --- Rolling win rate ---
        blue_rwr = _rolling(team_wins[blue_team])
        red_rwr  = _rolling(team_wins[red_team])

        # --- H2H ---
        pair = tuple(sorted([blue_team, red_team]))
        h2h_hist = h2h[pair]
        if len(h2h_hist) >= 2:
            h2h_wr = sum(h2h_hist)/len(h2h_hist) if pair[0]==blue_team \
                     else 1-sum(h2h_hist)/len(h2h_hist)
        else:
            h2h_wr = float('nan')

        # --- Rolling in-game stats (pre-game snapshot) ---
        def roll_stat(team, stat):
            return _rolling(team_stats[team][stat])

        row = {
            'league':   league,
            'year':     g.year,
            'playoffs': int(g.playoffs),
            'game':     int(g.game),
            'q_blue_win': g.q_blue_win,
            'blue_win': blue_win,

            # ELO
            'elo_diff': blue_elo - red_elo,

            # Win rate
            'rwr_diff': blue_rwr - red_rwr if not (pd.isna(blue_rwr) or pd.isna(red_rwr)) else np.nan,
            'h2h_wr':   h2h_wr,

            # Rolling stat diffs (blue team avg - red team avg)
            **{f'd_{s}': roll_stat(blue_team, s) - roll_stat(red_team, s)
               if not (pd.isna(roll_stat(blue_team, s)) or pd.isna(roll_stat(red_team, s)))
               else np.nan
               for s in STAT_COLS}
        }

        if league in MAJOR_LEAGUES:
            rows.append(row)

        # --- Update ELO ---
        s = _start(league)
        for p in bp:
            r = elo_map.get(p, s)
            elo_map[p] = r + K_FACTOR * (blue_win - _exp(r, red_elo))
        for p in rp:
            r = elo_map.get(p, s)
            elo_map[p] = r + K_FACTOR * ((1-blue_win) - _exp(r, blue_elo))

        team_wins[blue_team].append(blue_win)
        team_wins[red_team].append(1 - blue_win)
        h2h[pair].append(blue_win if pair[0]==blue_team else 1-blue_win)

        # --- Update rolling in-game stats ---
        # Extract from blue/red perspective and store from team perspective
        def _val(col, default=np.nan):
            v = getattr(g, col, default)
            return float(v) if not pd.isna(v) else np.nan

        blue_g15 = _val('blue_team_golddiffat15')
        red_g15  = -blue_g15 if not np.isnan(blue_g15) else np.nan

        stats_blue = {
            'gold15':       blue_g15,
            'kills':        _val('blue_team_kills'),
            'game_len':     _val('gamelength'),
            'first_blood':  _val('blue_team_firstblood'),
            'first_dragon': _val('blue_team_firstdragon'),
            'first_tower':  _val('blue_team_firsttower'),
            'dragons':      _val('blue_team_dragons'),
            'barons':       _val('blue_team_barons'),
            'towers':       _val('blue_team_towers'),
        }
        stats_red = {
            'gold15':       red_g15,
            'kills':        _val('red_team_kills'),
            'game_len':     _val('gamelength'),
            'first_blood':  1 - _val('blue_team_firstblood') if not np.isnan(_val('blue_team_firstblood')) else np.nan,
            'first_dragon': 1 - _val('blue_team_firstdragon') if not np.isnan(_val('blue_team_firstdragon')) else np.nan,
            'first_tower':  1 - _val('blue_team_firsttower') if not np.isnan(_val('blue_team_firsttower')) else np.nan,
            'dragons':      _val('red_team_dragons'),
            'barons':       _val('red_team_barons'),
            'towers':       _val('red_team_towers'),
        }
        for stat, val in stats_blue.items():
            if not np.isnan(val):
                team_stats[blue_team][stat].append(val)
        for stat, val in stats_red.items():
            if not np.isnan(val):
                team_stats[red_team][stat].append(val)

    return pd.DataFrame(rows)


def evaluate(name, y, p):
    ll = log_loss(y, p)
    print(f"  {name:<35} log loss = {ll:.4f}")
    return ll


def run():
    raw = pd.read_csv(PROCESSED_DIR / 'games_with_odds.csv', low_memory=False)
    raw['date'] = pd.to_datetime(raw['date'], utc=True)
    raw = raw.sort_values('date').reset_index(drop=True)

    print("Building features...")
    df = build_features(raw)

    train = df[df['year'].isin([2024, 2025])].copy()
    test  = df[df['year'] == 2026].copy()

    print(f"Train: {len(train):,} games (2024-2025)")
    print(f"Test:  {len(test):,} games (2026)\n")

    FILL = {
        'elo_diff': 0, 'rwr_diff': 0, 'h2h_wr': 0.5, 'playoffs': 0, 'game': 1,
        **{f'd_{s}': 0 for s in ['gold15','kills','game_len','first_blood',
                                  'first_dragon','first_tower','dragons','barons','towers']}
    }

    BASE_FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'game']
    STAT_FEATS = [f'd_{s}' for s in ['gold15','kills','game_len','first_blood',
                                      'first_dragon','first_tower','dragons','barons','towers']]
    ALL_FEATS  = BASE_FEATS + STAT_FEATS

    X_train = train[ALL_FEATS].fillna(FILL)
    X_test  = test[ALL_FEATS].fillna(FILL)
    y_train = train['blue_win'].values
    y_test  = test['blue_win'].values

    has_odds = test['q_blue_win'].notna()
    n_odds   = has_odds.sum()
    y_odds   = y_test[has_odds]
    pred_coin   = np.full(n_odds, 0.5)
    pred_market = test['q_blue_win'].fillna(0.5).values[has_odds]

    print(f"=== 2026 test set — games with odds ({n_odds:,}) ===")
    evaluate("Coin flip",    y_odds, pred_coin)
    evaluate("Market odds",  y_odds, pred_market)

    # Logistic Regression
    lr = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    lr.fit(X_train[BASE_FEATS].fillna(FILL), y_train)
    evaluate("LR — ELO + form + H2H",
             y_odds, lr.predict_proba(X_test[BASE_FEATS].fillna(FILL))[:, 1][has_odds])

    lr_all = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    lr_all.fit(X_train, y_train)
    evaluate("LR — all features",
             y_odds, lr_all.predict_proba(X_test)[:, 1][has_odds])

    # XGBoost — various configs
    for depth, n_est, lr_rate, label in [
        (3, 200, 0.05, "XGB — shallow (d=3, n=200)"),
        (4, 300, 0.03, "XGB — medium  (d=4, n=300)"),
        (2, 500, 0.02, "XGB — wide    (d=2, n=500)"),
    ]:
        xgb = XGBClassifier(
            n_estimators=n_est, max_depth=depth, learning_rate=lr_rate,
            subsample=0.8, colsample_bytree=0.8,
            eval_metric='logloss', random_state=42, verbosity=0,
        )
        xgb.fit(X_train, y_train)
        evaluate(label, y_odds, xgb.predict_proba(X_test)[:, 1][has_odds])

    print(f"\nBest features (LR all):")
    feats = ALL_FEATS
    coefs = sorted(zip(feats, lr_all.named_steps['lr'].coef_[0]), key=lambda x: -abs(x[1]))
    for f, c in coefs[:10]:
        print(f"  {f:<25} {c:+.4f}")


if __name__ == '__main__':
    run()
