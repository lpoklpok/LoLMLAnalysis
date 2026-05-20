"""
feature_engineering.py
Builds a pre-game feature matrix from games_with_odds.csv.

ELO is computed globally across all leagues (so players carry ELO when
they switch leagues), then the output is filtered to LEC/LPL/LCK for
model training.

Supports incremental mode (default): on subsequent runs only processes
games newer than the last checkpoint, saving a ~10x speedup on the
daily pipeline.

Output: data/processed/features.csv
"""

import json
import os
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd

PROCESSED_DIR   = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'
CHECKPOINT_PATH = PROCESSED_DIR / 'fe_checkpoint.json'

# Canonical team names — normalise rebrands so H2H history stays continuous
_TEAM_NORM: dict[str, str] = {
    'DRX':          'Kiwoom DRX',   # rebranded for 2026 LCK season
    'MAD Lions KOI': 'Movistar KOI', # rebranded for 2025 LEC season
}

def _norm_team(name: str) -> str:
    return _TEAM_NORM.get(name, name)

MAJOR_LEAGUES = {'LEC', 'LPL', 'LCK'}

# ELO constants
K_FACTOR       = 48
ELO_SCALE      = 400
SERIES_K_ALPHA      = float(os.environ.get('SERIES_K_ALPHA',      '0.3'))  # dampen K for all games in 2025+ (major leagues run bo3/bo5, so all games are intra-series)
PATCH_RESET_FACTOR  = float(os.environ.get('PATCH_RESET_FACTOR',  '0.0'))  # fraction of ELO deviation reset on patch change
TRANSFER_RESET_FACTOR = float(os.environ.get('TRANSFER_RESET_FACTOR', '0.0'))  # fraction of ELO deviation reset on team transfer

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
                    actual: float, opp_avg: float, k_scale: float = 1.0) -> None:
    start = _starting_elo(league)
    for p in players:
        r = elo_map.get(p, start)
        e = _expected(r, opp_avg)
        elo_map[p] = r + K_FACTOR * k_scale * (actual - e)


# ---------------------------------------------------------------------------
# Rolling win-rate helpers
# ---------------------------------------------------------------------------

def _rolling_winrate(history: list[int], n: int = 10) -> float:
    """Win rate over last n games; NaN if fewer than 3 games played."""
    if len(history) < 3:
        return float('nan')
    recent = history[-n:]
    return sum(recent) / len(recent)


def _player_h2h_wr(blue_p: str, red_p: str, pos: str,
                   player_h2h: dict, prior: int = 5) -> float:
    """Bayesian-shrunk win rate for blue_p vs red_p at position pos.

    Key is canonical (alphabetically sorted) pair so the dict is symmetric.
    Prior=5 means an unseen matchup starts at 0.5 and needs several games
    to deviate meaningfully (avoids extreme values from 1 or 2 data points).
    """
    p0, p1 = (blue_p, red_p) if blue_p <= red_p else (red_p, blue_p)
    key = (p0, p1, pos)
    hist = player_h2h[key]
    n = len(hist)
    wins_p0 = sum(hist)
    wins_blue = wins_p0 if p0 == blue_p else n - wins_p0
    return (wins_blue + prior * 0.5) / (n + prior)


# ---------------------------------------------------------------------------
# Checkpoint serialisation
# ---------------------------------------------------------------------------

class _NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        return super().default(obj)


def _save_checkpoint(
        elo_map, player_last_played, player_last_split, player_last_patch, player_last_team,
        team_history, h2h, player_gd15, team_gd20,
        team_outperf, team_outperf_elo, team_outperf_staleness,
        team_stats, series_record, roster_state, last_processed_date,
        player_h2h):

    def ts(v):
        return v.isoformat() if hasattr(v, 'isoformat') else str(v)

    checkpoint = {
        'last_processed_date':    ts(last_processed_date),
        'elo_map':                elo_map,
        'player_last_played':     {p: ts(v) for p, v in player_last_played.items()},
        'player_last_split':      {k: list(v) for k, v in player_last_split.items()},
        'player_last_patch':      dict(player_last_patch),
        'player_last_team':       dict(player_last_team),
        'team_history':           dict(team_history),
        'h2h':                    {'|||'.join(k): v for k, v in h2h.items()},
        'player_gd15':            dict(player_gd15),
        'team_gd20':              dict(team_gd20),
        'team_outperf':           dict(team_outperf),
        'team_outperf_elo':       dict(team_outperf_elo),
        'team_outperf_staleness': dict(team_outperf_staleness),
        'team_stats':             {t: dict(d) for t, d in team_stats.items()},
        'series_record': {
            json.dumps([list(k[0])] + list(k[1:]), cls=_NumpyEncoder): v
            for k, v in series_record.items()
        },
        'roster_state': roster_state,
        'player_h2h': {'|||'.join(k): v for k, v in player_h2h.items()},
    }
    with open(CHECKPOINT_PATH, 'w') as f:
        json.dump(checkpoint, f, cls=_NumpyEncoder)


def _load_checkpoint():
    if not CHECKPOINT_PATH.exists():
        return None
    with open(CHECKPOINT_PATH) as f:
        c = json.load(f)

    elo_map            = c['elo_map']
    player_last_played = {p: pd.Timestamp(v) for p, v in c['player_last_played'].items()}
    player_last_split  = {k: tuple(v) for k, v in c['player_last_split'].items()}
    player_last_patch  = c.get('player_last_patch', {})
    player_last_team   = c.get('player_last_team',  {})
    team_history       = defaultdict(list, {k: list(v) for k, v in c['team_history'].items()})
    h2h                = defaultdict(list, {tuple(k.split('|||')): list(v) for k, v in c['h2h'].items()})
    player_gd15        = defaultdict(list, {k: list(v) for k, v in c['player_gd15'].items()})
    team_gd20          = defaultdict(list, {k: list(v) for k, v in c['team_gd20'].items()})
    team_outperf       = defaultdict(list, {k: list(v) for k, v in c['team_outperf'].items()})
    team_outperf_elo   = defaultdict(list, {k: list(v) for k, v in c['team_outperf_elo'].items()})
    team_outperf_staleness = defaultdict(int, c['team_outperf_staleness'])

    team_stats: dict = defaultdict(lambda: defaultdict(list))
    for t, d in c['team_stats'].items():
        team_stats[t] = defaultdict(list, {k: list(v) for k, v in d.items()})

    series_record: dict = {}
    for s, v in c['series_record'].items():
        parts = json.loads(s)
        key = (tuple(parts[0]),) + tuple(parts[1:])
        series_record[key] = v

    roster_state = c.get('roster_state', {})

    player_h2h: dict = defaultdict(list)
    for s, v in c.get('player_h2h', {}).items():
        parts = s.split('|||')
        key = (parts[0], parts[1], parts[2])
        player_h2h[key] = list(v)

    last_date = pd.Timestamp(c['last_processed_date'])
    if last_date.tzinfo is None:
        last_date = last_date.tz_localize('UTC')

    return (last_date, elo_map, player_last_played, player_last_split, player_last_patch, player_last_team,
            team_history, h2h, player_gd15, team_gd20, team_outperf,
            team_outperf_elo, team_outperf_staleness, team_stats, series_record,
            roster_state, player_h2h)


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


_ODDS_COLS = [
    'odd1_decimal', 'odd2_decimal',
    'implied_prob1_vigfree', 'implied_prob2_vigfree',
    'format', 'score_match', 'q_blue_win',
]


def _patch_odds_columns() -> None:
    """Re-join odds columns from games_with_odds.csv into features files."""
    gwo_path = PROCESSED_DIR / 'games_with_odds.csv'
    gwo = pd.read_csv(gwo_path, low_memory=False, usecols=['gameid'] + _ODDS_COLS)
    for path in [PROCESSED_DIR / 'features_all.csv', PROCESSED_DIR / 'features.csv']:
        if not path.exists():
            continue
        feat = pd.read_csv(path, low_memory=False)
        feat = feat.drop(columns=[c for c in _ODDS_COLS if c in feat.columns])
        feat = feat.merge(gwo, on='gameid', how='left')
        feat.to_csv(path, index=False)
    n = gwo['q_blue_win'].notna().sum()
    print(f"Odds patch applied: {n:,} games now have odds.")


def build_features(decay_halflife: float | None = DECAY_HALFLIFE,
                   split_reset_factor: float | None = None,
                   incremental: bool = True) -> pd.DataFrame:
    """
    decay_halflife:     continuous time-based ELO decay (days). None = off.
    split_reset_factor: one-time fraction of deviation lost at each split
                        boundary (e.g. 0.5 = halve deviation on first game
                        of each new split). None = off.
    incremental:        if True, load checkpoint and process only new games.
    """
    path = PROCESSED_DIR / 'games_with_odds.csv'
    df = pd.read_csv(path, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)

    # Pre-scan: flag games that belong to a multi-game series (bo3/bo5).
    # Done on the full dataset before the incremental split so the lookup is
    # correct even for the first game of a newly-arriving series.
    _ps_blue = df['blue_team_teamname'].apply(lambda x: _norm_team(str(x)))
    _ps_red  = df['red_team_teamname'].apply(lambda x: _norm_team(str(x)))
    _ps_day  = df['date'].dt.date
    _ps_key  = [('|'.join(sorted([b, r]))) for b, r in zip(_ps_blue, _ps_red)]
    _ps_grp  = pd.Series(list(zip(_ps_day, df['league'], _ps_key)))
    _ps_max  = df.groupby([_ps_day, df['league'], _ps_key])['game'].transform('max')
    df['is_series_game'] = (_ps_max > 1).values

    ckpt = _load_checkpoint() if incremental else None
    existing_features_all   = None
    existing_features_major = None
    roster_state: dict[str, list[str]] = {}

    if ckpt is not None:
        (last_date, elo_map, player_last_played, player_last_split, player_last_patch, player_last_team,
         team_history, h2h, player_gd15, team_gd20, team_outperf,
         team_outperf_elo, team_outperf_staleness, team_stats, series_record,
         roster_state, player_h2h) = ckpt

        new_df = df[df['date'] > last_date]
        if new_df.empty:
            gwo_path  = PROCESSED_DIR / 'games_with_odds.csv'
            ckpt_mtime = CHECKPOINT_PATH.stat().st_mtime
            gwo_mtime  = gwo_path.stat().st_mtime if gwo_path.exists() else 0
            if gwo_mtime > ckpt_mtime:
                print(f"No new games, but odds file is newer than checkpoint — patching odds columns.")
                _patch_odds_columns()
                CHECKPOINT_PATH.touch()  # prevent re-patching on next run
            else:
                print(f"No new games since {last_date.date()} — skipping feature engineering.")
            return pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)

        print(f"Incremental: processing {len(new_df)} new games after {last_date.date()}")
        df = new_df.reset_index(drop=True)

        feat_all_path = PROCESSED_DIR / 'features_all.csv'
        feat_path     = PROCESSED_DIR / 'features.csv'
        if feat_all_path.exists():
            existing_features_all = pd.read_csv(feat_all_path, low_memory=False)
            if 'league' not in existing_features_all.columns:
                print("Cached features_all.csv is stale (missing 'league') — forcing full rebuild.")
                existing_features_all = None
        if feat_path.exists():
            existing_features_major = pd.read_csv(feat_path, low_memory=False)
    else:
        elo_map                = {}
        player_last_played     = {}
        player_last_split      = {}
        player_last_patch      = {}
        player_last_team       = {}
        team_history           = defaultdict(list)
        h2h                    = defaultdict(list)
        player_gd15            = defaultdict(list)
        team_gd20              = defaultdict(list)
        team_outperf           = defaultdict(list)
        team_outperf_elo       = defaultdict(list)
        team_outperf_staleness = defaultdict(int)
        team_stats             = defaultdict(lambda: defaultdict(list))
        series_record          = {}
        player_h2h             = defaultdict(list)

    rows: list[dict] = []
    last_processed_date = None

    for g in df.itertuples(index=False):
        blue_players = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        red_players  = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]

        # Skip if any player name is missing
        if any(pd.isna(x) for x in blue_players + red_players):
            continue

        blue_team = _norm_team(str(g.blue_team_teamname))
        red_team  = _norm_team(str(g.red_team_teamname))
        blue_win  = int(g.blue_team_result)

        league       = g.league
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

        # --- Patch reset (pull toward baseline on each patch change) ---
        if PATCH_RESET_FACTOR > 0:
            cur_patch = g.patch
            start = _starting_elo(league)
            for p in blue_players + red_players:
                if p in player_last_patch and player_last_patch[p] != cur_patch:
                    curr = elo_map.get(p, start)
                    elo_map[p] = start + (curr - start) * (1.0 - PATCH_RESET_FACTOR)

        # --- Transfer reset (pull toward baseline when player joins a new team) ---
        if TRANSFER_RESET_FACTOR > 0:
            start = _starting_elo(league)
            for p, team in zip(blue_players + red_players,
                               [blue_team]*5 + [red_team]*5):
                if p in player_last_team and player_last_team[p] != team:
                    curr = elo_map.get(p, start)
                    elo_map[p] = start + (curr - start) * (1.0 - TRANSFER_RESET_FACTOR)

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

        # Player vs player role h2h (Bayesian-shrunk, prior=5 virtual games)
        # role_h2h_wr: mean Bayesian win rate across 5 roles (centered at 0.5)
        # role_h2h_signed_sq: signed square of deviation from 0.5 — near-zero unless
        #   there are many matchups AND an extreme win rate (e.g. Showmaker vs Faker)
        _role_wrs = [
            _player_h2h_wr(blue_players[i], red_players[i], POSITIONS[i], player_h2h)
            for i in range(len(POSITIONS))
        ]
        role_h2h_wr = float(np.mean(_role_wrs))
        _role_devs  = [w - 0.5 for w in _role_wrs]
        role_h2h_signed_sq = float(np.mean([d * abs(d) for d in _role_devs]))

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

            # Head-to-head (team and per-role player matchup)
            'h2h_wr':          h2h_wr,
            'role_h2h_wr':     role_h2h_wr,
            'role_h2h_signed_sq': role_h2h_signed_sq,

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
        k_scale = SERIES_K_ALPHA if (g.year >= 2025) else 1.0
        _update_players(blue_players, elo_map, league, float(blue_win),     float(red_elo), k_scale)
        _update_players(red_players,  elo_map, league, float(1 - blue_win), float(blue_elo), k_scale)

        # Update last-played date and split for decay/reset tracking
        for p, team in zip(blue_players + red_players, [blue_team]*5 + [red_team]*5):
            player_last_played[p] = current_date
            player_last_split[p]  = (g.year, g.split)
            player_last_patch[p]  = g.patch
            player_last_team[p]   = team

        # Update roster state with this game's lineup
        roster_state[blue_team] = blue_players
        roster_state[red_team]  = red_players
        last_processed_date     = current_date

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

        # Update player role h2h (stored from perspective of alphabetically first player)
        for i, pos in enumerate(POSITIONS):
            bp, rp = blue_players[i], red_players[i]
            p0, p1 = (bp, rp) if bp <= rp else (rp, bp)
            key = (p0, p1, pos)
            player_h2h[key].append(blue_win if p0 == bp else 1 - blue_win)

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

    # --- Merge new rows with existing features ---
    new_rows = pd.DataFrame(rows)

    if existing_features_all is not None:
        features_all = pd.concat([existing_features_all, new_rows], ignore_index=True)
    else:
        features_all = new_rows

    new_major        = new_rows[new_rows['league'].isin(MAJOR_LEAGUES)]
    if existing_features_major is not None:
        features_major = pd.concat([existing_features_major, new_major], ignore_index=True)
    else:
        features_major = features_all[features_all['league'].isin(MAJOR_LEAGUES)].copy()

    features_all.to_csv(PROCESSED_DIR / 'features_all.csv', index=False)
    features_major.to_csv(PROCESSED_DIR / 'features.csv', index=False)

    # Always backfill odds from games_with_odds.csv so retroactively-added
    # market odds reach existing rows (only q_blue_win is written inline above).
    _patch_odds_columns()

    # --- Save checkpoint for next incremental run ---
    if last_processed_date is not None:
        _save_checkpoint(
            elo_map, player_last_played, player_last_split, player_last_patch, player_last_team,
            team_history, h2h, player_gd15, team_gd20,
            team_outperf, team_outperf_elo, team_outperf_staleness,
            team_stats, series_record, roster_state, last_processed_date,
            player_h2h)

    # --- Save ELO state for predict_upcoming.py ---
    elo_state = {
        'elo_map':          elo_map,
        'player_last_split': {k: list(v) for k, v in player_last_split.items()},
    }
    with open(PROCESSED_DIR / 'elo_state.json', 'w') as f:
        json.dump(elo_state, f, cls=_NumpyEncoder)

    # --- Save roster state for predict_upcoming.py ---
    with open(PROCESSED_DIR / 'roster_state.json', 'w') as f:
        json.dump(roster_state, f, indent=2)

    # --- Save player h2h state for predict_upcoming.py ---
    player_h2h_out = {
        '|||'.join(k): {'n': len(v), 'wins': int(sum(v))}
        for k, v in player_h2h.items()
    }
    with open(PROCESSED_DIR / 'player_h2h.json', 'w') as f:
        json.dump(player_h2h_out, f, cls=_NumpyEncoder)

    n_new = len(new_rows)
    print(f"New games processed: {n_new:,}")
    print(f"All leagues total:   {len(features_all):,} games")
    print(f"Major leagues total: {len(features_major):,} games")
    print(f"\nFeature columns: {list(features_major.columns)}")
    print(f"\nMissing values:\n{features_major.isna().sum()}")

    return features_major


if __name__ == '__main__':
    build_features()
