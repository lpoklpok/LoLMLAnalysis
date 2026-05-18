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
K_FACTOR  = 48
ELO_SCALE = 400

# League-tier starting ELOs
# Derived from implied win probabilities:
#   LCK/LPL = LEC + 120.4 pts  →  2/3 win prob  (2-1 favorite)
#   LEC = LCS/LTA/LCKC + 120.4 pts  →  2/3 win prob
#   LCS/LTA/LCKC = others + 120.4 pts  →  2/3 win prob
# 120.4 = 400 * log10(2)
_ELO_TIER: dict[str, float] = {
    # Tier 1
    'LCK': 1620, 'LPL': 1620,
    # Tier 2
    'LEC': 1500,
    # Tier 3
    'LCS': 1380, 'LTA': 1380, 'LTA N': 1380, 'LTA S': 1380, 'LCKC': 1380,
}
_ELO_DEFAULT = 1260  # Tier 4 — all other leagues

def _starting_elo(league: str) -> float:
    return _ELO_TIER.get(league, _ELO_DEFAULT)

POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']


# ---------------------------------------------------------------------------
# ELO helpers
# ---------------------------------------------------------------------------

def _expected(elo_a: float, elo_b: float) -> float:
    return 1.0 / (1.0 + 10 ** ((elo_b - elo_a) / ELO_SCALE))


def _team_elo(players: list[str], elo_map: dict, league: str) -> float:
    start = _starting_elo(league)
    return np.mean([elo_map.get(p, start) for p in players])


def _update_players(players: list[str], elo_map: dict, league: str,
                    actual: float, opp_avg: float) -> None:
    start = _starting_elo(league)
    for p in players:
        r = elo_map.get(p, start)
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

ROLL_N          = 10   # default rolling window
GD15_ROLL       = 5    # rolling window for player GD@15
OUTPERF_N       = 5    # rolling window for outperformance
EXP_DECAY       = 0.70 # exponential decay weight (most recent game = 1.0), tuned on 2026
DECAY_HALFLIFE  = None # no decay — doesn't generalise out of sample


def _rolling(history: list[float], n: int = ROLL_N, min_obs: int = 3) -> float:
    if len(history) < min_obs:
        return float('nan')
    return float(np.mean(history[-n:]))


def _rolling_exp(history: list[float], n: int = ROLL_N, min_obs: int = 3,
                 decay: float = EXP_DECAY) -> float:
    """Exponentially weighted mean; recent games count more."""
    recent = history[-n:]
    if len(recent) < min_obs:
        return float('nan')
    weights = np.array([decay ** (len(recent) - 1 - i) for i in range(len(recent))])
    return float(np.average(recent, weights=weights))


def _rolling_gd15(history: list[float], n: int = GD15_ROLL) -> float:
    if len(history) < 2:
        return float('nan')
    return float(np.mean(history[-n:]))


def _rolling_outperf(history: list[float], n: int = OUTPERF_N) -> float:
    if len(history) < 3:
        return float('nan')
    return float(np.mean(history[-n:]))


def _apply_elo_decay(players: list[str], elo_map: dict, league: str,
                     current_date, player_last_played: dict,
                     halflife: float | None) -> None:
    """Pull each player's ELO toward their league starting value based on inactivity."""
    if halflife is None:
        return
    start = _starting_elo(league)
    for p in players:
        if p not in player_last_played:
            continue
        days = (current_date - player_last_played[p]).days
        if days <= 0:
            continue
        decay = 0.5 ** (days / halflife)
        current = elo_map.get(p, start)
        elo_map[p] = start + (current - start) * decay


def build_features(decay_halflife: float | None = DECAY_HALFLIFE,
                   split_reset_factor: float | None = None) -> pd.DataFrame:
    """
    decay_halflife:     continuous time-based ELO decay (days). None = off.
    split_reset_factor: one-time fraction of deviation lost at each split
                        boundary (e.g. 0.5 = halve deviation on first game
                        of each new split). None = off. Applied instead of
                        or in addition to halflife decay.
    """
    path = PROCESSED_DIR / 'games_with_odds.csv'
    df = pd.read_csv(path, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)

    elo_map: dict[str, float] = {}
    player_last_played: dict[str, object] = {}   # player -> last game date (for ELO decay)
    player_last_split: dict[str, tuple] = {}      # player -> (year, split) of last game
    team_history: dict[str, list[int]] = defaultdict(list)
    h2h: dict[tuple, list[int]] = defaultdict(list)
    player_gd15: dict[str, list[float]] = defaultdict(list)
    team_gd20: dict[str, list[float]] = defaultdict(list)
    team_outperf: dict[str, list[float]] = defaultdict(list)
    team_outperf_elo: dict[str, list[float]] = defaultdict(list)
    # Games played since last odds-based outperf update (staleness guard)
    team_outperf_staleness: dict[str, int] = defaultdict(int)
    # Objective / margin-of-victory histories (from each team's perspective)
    team_stats: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    # Series score tracker: series_key -> {team: wins}
    series_record: dict[tuple, dict[str, int]] = {}

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

        league = g.league
        current_date = g.date

        # --- ELO decay (mean reversion during inactivity, applied before snapshot) ---
        _apply_elo_decay(blue_players, elo_map, league, current_date, player_last_played, decay_halflife)
        _apply_elo_decay(red_players,  elo_map, league, current_date, player_last_played, decay_halflife)

        # --- Split reset (one-time pull toward baseline at each new split) ---
        if split_reset_factor is not None:
            cur_split = (g.year, g.split)
            start = _starting_elo(league)
            for p in blue_players + red_players:
                if p in player_last_split and player_last_split[p] != cur_split:
                    curr = elo_map.get(p, start)
                    elo_map[p] = start + (curr - start) * (1.0 - split_reset_factor)

        # --- Days since last played (pre-game snapshot) ---
        def _days_since(players):
            dates = [player_last_played.get(p) for p in players if p in player_last_played]
            if not dates:
                return float('nan')
            return (current_date - max(dates)).days

        blue_days_since = _days_since(blue_players)
        red_days_since  = _days_since(red_players)
        days_since_diff = (blue_days_since - red_days_since
                           if not (np.isnan(blue_days_since) or np.isnan(red_days_since))
                           else float('nan'))

        # --- Series score (pre-game) ---
        series_key = (tuple(sorted([blue_team, red_team])), g.split, g.year, league, g.playoffs)
        if g.game == 1:
            series_record[series_key] = {blue_team: 0, red_team: 0}
        sr = series_record.get(series_key, {})
        series_score = sr.get(blue_team, 0) - sr.get(red_team, 0)

        # --- First pick (blue=1 means blue team has first pick) ---
        fp = getattr(g, 'blue_team_firstPick', None)
        blue_first_pick = int(fp) if fp is not None and not pd.isna(fp) else 1  # default 1 (pre-2026)

        # --- Pre-game features (snapshot BEFORE this game) ---
        start = _starting_elo(league)
        blue_role_elos = [elo_map.get(p, start) for p in blue_players]
        red_role_elos  = [elo_map.get(p, start) for p in red_players]

        blue_elo = float(np.mean(blue_role_elos))
        red_elo  = float(np.mean(red_role_elos))

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

        role_diffs = {
            pos: blue_role_elos[i] - red_role_elos[i]
            for i, pos in enumerate(POSITIONS)
        }

        # Rolling objective / margin-of-victory features (exponentially weighted)
        STAT_KEYS = ['first_blood', 'first_dragon', 'first_tower',
                     'kill_diff', 'game_len', 'dragons', 'barons']
        def stat_diff(key):
            b = _rolling_exp(team_stats[blue_team][key])
            r = _rolling_exp(team_stats[red_team][key])
            return b - r if not (np.isnan(b) or np.isnan(r)) else float('nan')

        # Exponentially weighted rolling win rate
        blue_rwr_exp = _rolling_exp(team_history[blue_team])
        red_rwr_exp  = _rolling_exp(team_history[red_team])
        rwr_exp_diff = blue_rwr_exp - red_rwr_exp if not (np.isnan(blue_rwr_exp) or np.isnan(red_rwr_exp)) else float('nan')

        # Outperformance vs market implied (uniform + exp weighted)
        # Return NaN if no odds update in the last OUTPERF_N games (stale history)
        def _outperf_or_nan(team):
            if team_outperf_staleness[team] >= OUTPERF_N:
                return float('nan'), float('nan')
            return _rolling_outperf(team_outperf[team]), _rolling_exp(team_outperf[team], n=OUTPERF_N, min_obs=3)

        blue_outperf,     blue_outperf_exp = _outperf_or_nan(blue_team)
        red_outperf,      red_outperf_exp  = _outperf_or_nan(red_team)
        outperf_diff     = blue_outperf - red_outperf if not (np.isnan(blue_outperf) or np.isnan(red_outperf)) else float('nan')
        outperf_exp_diff = blue_outperf_exp - red_outperf_exp if not (np.isnan(blue_outperf_exp) or np.isnan(red_outperf_exp)) else float('nan')

        # Outperformance vs ELO-implied (uniform + exp weighted)
        elo_implied_blue  = _expected(blue_elo, red_elo)
        blue_outperf_elo  = _rolling_outperf(team_outperf_elo[blue_team])
        red_outperf_elo   = _rolling_outperf(team_outperf_elo[red_team])
        outperf_elo_diff  = blue_outperf_elo - red_outperf_elo if not (np.isnan(blue_outperf_elo) or np.isnan(red_outperf_elo)) else float('nan')
        blue_op_elo_exp   = _rolling_exp(team_outperf_elo[blue_team], n=OUTPERF_N, min_obs=3)
        red_op_elo_exp    = _rolling_exp(team_outperf_elo[red_team],  n=OUTPERF_N, min_obs=3)
        outperf_elo_exp_diff = blue_op_elo_exp - red_op_elo_exp if not (np.isnan(blue_op_elo_exp) or np.isnan(red_op_elo_exp)) else float('nan')

        # Rolling team GD@20
        blue_gd20_avg = _rolling_gd15(team_gd20[blue_team])
        red_gd20_avg  = _rolling_gd15(team_gd20[red_team])
        gd20_diff     = blue_gd20_avg - red_gd20_avg if not (np.isnan(blue_gd20_avg) or np.isnan(red_gd20_avg)) else float('nan')

        # Rolling GD@15 per player — uniform and exp weighted
        blue_gd15_vals     = [_rolling_gd15(player_gd15[p]) for p in blue_players]
        red_gd15_vals      = [_rolling_gd15(player_gd15[p]) for p in red_players]
        blue_gd15_avg      = float(np.nanmean(blue_gd15_vals)) if any(not np.isnan(v) for v in blue_gd15_vals) else float('nan')
        red_gd15_avg       = float(np.nanmean(red_gd15_vals))  if any(not np.isnan(v) for v in red_gd15_vals)  else float('nan')
        gd15_diff          = blue_gd15_avg - red_gd15_avg if not (np.isnan(blue_gd15_avg) or np.isnan(red_gd15_avg)) else float('nan')

        blue_gd15_exp_vals = [_rolling_exp(player_gd15[p], n=GD15_ROLL, min_obs=2) for p in blue_players]
        red_gd15_exp_vals  = [_rolling_exp(player_gd15[p], n=GD15_ROLL, min_obs=2) for p in red_players]
        blue_gd15_exp      = float(np.nanmean(blue_gd15_exp_vals)) if any(not np.isnan(v) for v in blue_gd15_exp_vals) else float('nan')
        red_gd15_exp       = float(np.nanmean(red_gd15_exp_vals))  if any(not np.isnan(v) for v in red_gd15_exp_vals)  else float('nan')
        gd15_exp_diff      = blue_gd15_exp - red_gd15_exp if not (np.isnan(blue_gd15_exp) or np.isnan(red_gd15_exp)) else float('nan')

        # Per-role GD@15 diffs
        role_gd15_diffs = {}
        for i, pos in enumerate(POSITIONS):
            b = blue_gd15_vals[i]
            r = red_gd15_vals[i]
            role_gd15_diffs[f'{pos}_gd15_diff'] = b - r if not (np.isnan(b) or np.isnan(r)) else float('nan')

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
            'blue_elo':             blue_elo,
            'red_elo':              red_elo,
            'elo_diff':             blue_elo - red_elo,
            'elo_diff_signed_sq':   (blue_elo - red_elo) * abs(blue_elo - red_elo),

            # Per-role ELO diffs (blue minus red)
            **{f'{pos}_elo_diff': role_diffs[pos] for pos in POSITIONS},

            # Rolling win rate
            'blue_rwr':        blue_rwr,
            'red_rwr':         red_rwr,
            'rwr_diff':        blue_rwr - red_rwr if not (pd.isna(blue_rwr) or pd.isna(red_rwr)) else np.nan,

            # Head-to-head
            'h2h_wr':          h2h_wr,

            # Rolling team GD@20 (early game macro form, last 5 games)
            'gd20_diff':       gd20_diff,

            # Rolling GD@15 per player (laning form, last 5 games)
            'gd15_diff':       gd15_diff,
            **role_gd15_diffs,

            # Outperformance vs market implied (uniform + exp weighted)
            'outperf_diff':         outperf_diff,
            'outperf_exp_diff':     outperf_exp_diff,

            # Outperformance vs ELO-implied (uniform + exp weighted)
            'outperf_elo_diff':     outperf_elo_diff,
            'outperf_elo_exp_diff': outperf_elo_exp_diff,

            # Exponentially weighted rolling win rate diff
            'rwr_exp_diff':         rwr_exp_diff,

            # GD@15 exp weighted
            'gd15_exp_diff':        gd15_exp_diff,

            # Rolling objective / margin-of-victory diffs (exp weighted)
            **{f'{k}_diff': stat_diff(k) for k in STAT_KEYS},

            # Inactivity / rest
            'blue_days_since': blue_days_since,
            'red_days_since':  red_days_since,
            'days_since_diff': days_since_diff,

            # Draft / series context
            'blue_first_pick': blue_first_pick,
            'series_score':    series_score,

            # Market (may be NaN for games without odds)
            'q_blue_win':      g.q_blue_win,

            # Target
            'blue_win':        blue_win,
        })

        # --- Update state AFTER recording pre-game snapshot ---
        _update_players(blue_players, elo_map, league, float(blue_win),     float(red_elo))
        _update_players(red_players,  elo_map, league, float(1 - blue_win), float(blue_elo))

        # Update last-played date and split for decay/reset tracking
        for p in blue_players + red_players:
            player_last_played[p] = current_date
            player_last_split[p]  = (g.year, g.split)

        team_history[blue_team].append(blue_win)
        team_history[red_team].append(1 - blue_win)

        # Update series record
        if series_key not in series_record:
            series_record[series_key] = {blue_team: 0, red_team: 0}
        series_record[series_key][blue_team] = series_record[series_key].get(blue_team, 0) + blue_win
        series_record[series_key][red_team]  = series_record[series_key].get(red_team, 0) + (1 - blue_win)

        # H2H stored from perspective of pair[0]
        if pair[0] == blue_team:
            h2h[pair].append(blue_win)
        else:
            h2h[pair].append(1 - blue_win)

        # Update team GD@20 histories
        raw_gd20 = getattr(g, 'blue_team_golddiffat20', None)
        if raw_gd20 is not None and not pd.isna(raw_gd20):
            val20 = float(raw_gd20)
            team_gd20[blue_team].append(val20)
            team_gd20[red_team].append(-val20)

        # Update player GD@15 histories (blue player gets positive value, red gets negative)
        for i, pos in enumerate(POSITIONS):
            raw = getattr(g, f'blue_{pos}_golddiffat15', None)
            if raw is not None and not pd.isna(raw):
                val = float(raw)
                player_gd15[blue_players[i]].append(val)
                player_gd15[red_players[i]].append(-val)

        # Update outperformance histories (only when market odds available)
        q = getattr(g, 'q_blue_win', None)
        if q is not None and not pd.isna(q):
            team_outperf[blue_team].append(blue_win - float(q))
            team_outperf[red_team].append((1 - blue_win) - (1 - float(q)))
            team_outperf_staleness[blue_team] = 0
            team_outperf_staleness[red_team]  = 0
        else:
            team_outperf_staleness[blue_team] += 1
            team_outperf_staleness[red_team]  += 1

        # Update ELO-implied outperformance (every game)
        team_outperf_elo[blue_team].append(blue_win - elo_implied_blue)
        team_outperf_elo[red_team].append((1 - blue_win) - (1 - elo_implied_blue))

        # Update objective / margin stats
        def _fval(col):
            v = getattr(g, col, None)
            return float(v) if v is not None and not pd.isna(v) else None

        fb  = _fval('blue_team_firstblood')
        fd  = _fval('blue_team_firstdragon')
        ft  = _fval('blue_team_firsttower')
        bk  = _fval('blue_team_kills')
        rk  = _fval('red_team_kills')
        gl  = _fval('gamelength')
        bd  = _fval('blue_team_dragons')
        rd  = _fval('red_team_dragons')
        bb  = _fval('blue_team_barons')
        rb  = _fval('red_team_barons')
        kd  = (bk - rk) if bk is not None and rk is not None else None

        blue_vals = {
            'first_blood':  fb,
            'first_dragon': fd,
            'first_tower':  ft,
            'kill_diff':    kd,
            'game_len':     gl,
            'dragons':      bd,
            'barons':       bb,
        }
        red_vals = {
            'first_blood':  (1 - fb) if fb is not None else None,
            'first_dragon': (1 - fd) if fd is not None else None,
            'first_tower':  (1 - ft) if ft is not None else None,
            'kill_diff':    (-kd) if kd is not None else None,
            'game_len':     gl,
            'dragons':      rd,
            'barons':       rb,
        }
        for key in STAT_KEYS:
            if blue_vals[key] is not None:
                team_stats[blue_team][key].append(blue_vals[key])
            if red_vals[key] is not None:
                team_stats[red_team][key].append(red_vals[key])

    features = pd.DataFrame(rows)

    # Filter to major leagues for modeling
    features_major = features[features['league'].isin(MAJOR_LEAGUES)].copy()

    features.to_csv(PROCESSED_DIR / 'features_all.csv', index=False)
    features_major.to_csv(PROCESSED_DIR / 'features.csv', index=False)

    # Save ELO state and last-known roster for future game prediction
    import json
    elo_state = {
        'elo_map': elo_map,
        'player_last_split': {k: list(v) for k, v in player_last_split.items()},
    }
    with open(PROCESSED_DIR / 'elo_state.json', 'w') as f:
        json.dump(elo_state, f)

    # Save most recent 5-man lineup per team (for upcoming game roster lookup)
    roster_map: dict[str, list[str]] = {}
    for g in features.itertuples(index=False):
        bp = [g.blue_team]  # placeholder — actual players not in features
        roster_map[g.blue_team] = getattr(g, 'blue_team', None)
        roster_map[g.red_team]  = getattr(g, 'red_team', None)

    # Build from raw data instead
    raw = pd.read_csv(PROCESSED_DIR / 'games_with_odds.csv', low_memory=False)
    raw['date'] = pd.to_datetime(raw['date'], utc=True)
    raw = raw.sort_values('date')
    roster_rows = []
    for _, g in raw.iterrows():
        bp = [g.get(f'blue_{p}_playername') for p in POSITIONS]
        rp = [g.get(f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp):
            continue
        roster_rows.append({'team': str(g['blue_team_teamname']), 'players': bp, 'date': str(g['date'])})
        roster_rows.append({'team': str(g['red_team_teamname']),  'players': rp, 'date': str(g['date'])})

    # Keep latest roster per team
    latest: dict[str, dict] = {}
    for row in roster_rows:
        latest[row['team']] = row
    with open(PROCESSED_DIR / 'roster_state.json', 'w') as f:
        json.dump({t: r['players'] for t, r in latest.items()}, f, indent=2)

    print(f"All leagues:    {len(features):,} games")
    print(f"Major leagues:  {len(features_major):,} games")
    print(f"\nFeature columns: {list(features_major.columns)}")
    print(f"\nMissing values:\n{features_major.isna().sum()}")

    return features_major


if __name__ == '__main__':
    build_features()
