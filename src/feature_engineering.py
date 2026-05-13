"""
feature_engineering.py
Builds a pre-game feature matrix from games_with_odds.csv.

ELO is computed globally across all leagues (so players carry ELO when
they switch leagues), then the output is filtered to LEC/LPL/LCK for
model training.

Output: data/processed/features.csv
"""

import os
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'

MAJOR_LEAGUES = {'LEC', 'LPL', 'LCK'}

# ELO constants
INITIAL_ELO = 1500
K_FACTOR    = 32
ELO_SCALE   = 400

POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']


# ---------------------------------------------------------------------------
# ELO helpers
# ---------------------------------------------------------------------------

def _expected(elo_a: float, elo_b: float) -> float:
    return 1.0 / (1.0 + 10 ** ((elo_b - elo_a) / ELO_SCALE))


def _team_elo(players: list[str], elo_map: dict) -> float:
    return np.mean([elo_map.get(p, INITIAL_ELO) for p in players])


def _update_players(players: list[str], elo_map: dict,
                    actual: float, opp_avg: float) -> None:
    for p in players:
        r = elo_map.get(p, INITIAL_ELO)
        e = _expected(r, opp_avg)
        elo_map[p] = r + K_FACTOR * (actual - e)


# ---------------------------------------------------------------------------
# Rolling win-rate helpers
# ---------------------------------------------------------------------------

def _rolling_winrate(history: list[int], n: int = 10) -> float:
    """Win rate over last n games; NaN if fewer than 3 games played."""
    if len(history) < 3:
        return float('nan')
    recent = history[-n:]
    return sum(recent) / len(recent)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_features() -> pd.DataFrame:
    path = PROCESSED_DIR / 'games_with_odds.csv'
    df = pd.read_csv(path, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)

    elo_map: dict[str, float] = {}          # player → current ELO
    team_history: dict[str, list[int]] = defaultdict(list)  # team → [1/0, ...]
    h2h: dict[tuple, list[int]] = defaultdict(list)         # (t1,t2) → [1/0 from t1 pov]

    rows = []

    for g in df.itertuples(index=False):
        blue_players = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        red_players  = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]

        # Skip if any player name is missing
        if any(pd.isna(x) for x in blue_players + red_players):
            continue

        blue_team = str(g.blue_team_teamname)
        red_team  = str(g.red_team_teamname)
        blue_win  = int(g.blue_team_result)

        # --- Pre-game features (snapshot BEFORE this game) ---
        blue_elo = _team_elo(blue_players, elo_map)
        red_elo  = _team_elo(red_players,  elo_map)

        blue_rwr = _rolling_winrate(team_history[blue_team])
        red_rwr  = _rolling_winrate(team_history[red_team])

        # Head-to-head: (canonical pair) always stored as (alphabetically first, second)
        pair     = tuple(sorted([blue_team, red_team]))
        h2h_hist = h2h[pair]
        if len(h2h_hist) >= 2:
            # from blue team's perspective
            if pair[0] == blue_team:
                h2h_wr = sum(h2h_hist) / len(h2h_hist)
            else:
                h2h_wr = 1 - sum(h2h_hist) / len(h2h_hist)
        else:
            h2h_wr = float('nan')

        rows.append({
            'gameid':          g.gameid,
            'date':            g.date,
            'league':          g.league,
            'year':            g.year,
            'split':           g.split,
            'playoffs':        g.playoffs,
            'game':            g.game,
            'patch':           g.patch,
            'blue_team':       blue_team,
            'red_team':        red_team,

            # ELO
            'blue_elo':        blue_elo,
            'red_elo':         red_elo,
            'elo_diff':        blue_elo - red_elo,

            # Rolling win rate
            'blue_rwr':        blue_rwr,
            'red_rwr':         red_rwr,
            'rwr_diff':        blue_rwr - red_rwr if not (pd.isna(blue_rwr) or pd.isna(red_rwr)) else np.nan,

            # Head-to-head
            'h2h_wr':          h2h_wr,

            # Market (may be NaN for games without odds)
            'q_blue_win':      g.q_blue_win,

            # Target
            'blue_win':        blue_win,
        })

        # --- Update state AFTER recording pre-game snapshot ---
        _update_players(blue_players, elo_map, float(blue_win),      red_elo)
        _update_players(red_players,  elo_map, float(1 - blue_win),  blue_elo)

        team_history[blue_team].append(blue_win)
        team_history[red_team].append(1 - blue_win)

        # H2H stored from perspective of pair[0]
        if pair[0] == blue_team:
            h2h[pair].append(blue_win)
        else:
            h2h[pair].append(1 - blue_win)

    features = pd.DataFrame(rows)

    # Filter to major leagues for modeling
    features_major = features[features['league'].isin(MAJOR_LEAGUES)].copy()

    features.to_csv(PROCESSED_DIR / 'features_all.csv', index=False)
    features_major.to_csv(PROCESSED_DIR / 'features.csv', index=False)

    print(f"All leagues:    {len(features):,} games")
    print(f"Major leagues:  {len(features_major):,} games")
    print(f"\nFeature columns: {list(features_major.columns)}")
    print(f"\nMissing values:\n{features_major.isna().sum()}")

    return features_major


if __name__ == '__main__':
    build_features()
