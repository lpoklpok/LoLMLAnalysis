"""
merge_data.py
Joins OraclesElixir game-level data with OddsPortal series-level odds.

Outputs
-------
data/processed/series_with_odds.csv  – one row per series, with odds attached
data/processed/games_with_odds.csv   – one row per game, with series odds + per-game q
"""

import os
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import brentq

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'
ODDS_DIR      = Path(os.path.dirname(__file__)) / '..' / 'data' / 'odds'

ODDS_LEAGUES = ['LCK', 'LEC', 'LCS', 'LPL']

# Teams where OE and OddsPortal use different names.
# Both sides map to a single canonical form used only for matching.
_NORM_MAP = {
    'DRX':               'KRX',
    'Kiwoom DRX':        'KRX',
    'MAD Lions KOI':     'Movistar KOI',
    'FlyQuest':          'FlyQuest',
    'FlyQuest eSports':  'FlyQuest',
    'Team Heretics':     'Heretics',
    'Team Vitality':     'Vitality',
    'LYON':              'Lyon Gaming',
    'NRG':               'NRG Esports',
    'ThunderTalk Gaming': 'TT Gaming',
}


def _norm(name: str) -> str:
    return _NORM_MAP.get(name, name)


def _pair_key(t1: str, t2: str) -> str:
    """Sorted, canonical team-pair string for join keys."""
    return '|'.join(sorted([_norm(t1), _norm(t2)]))


# ---------------------------------------------------------------------------
# BO3/BO5 series-win-probability functions and per-game q back-solver
# ---------------------------------------------------------------------------

def _series_prob_bo3(q: float) -> float:
    """P(win BO3 series) given per-game win prob q."""
    return 3 * q ** 2 - 2 * q ** 3


def _series_prob_bo5(q: float) -> float:
    """P(win BO5 series) given per-game win prob q."""
    return q ** 3 * (10 - 15 * q + 6 * q ** 2)


def _back_solve_q(series_prob: float, fmt: str) -> float:
    """Return per-game win prob q given a series win probability and format."""
    if fmt == 'BO1':
        return series_prob
    fn = _series_prob_bo3 if fmt == 'BO3' else _series_prob_bo5
    try:
        return brentq(lambda q: fn(q) - series_prob, 1e-6, 1 - 1e-6)
    except ValueError:
        return np.nan


def _infer_format(score1: int, score2: int) -> str:
    """Infer series format from final scores."""
    mx = max(score1, score2)
    if mx == 1:
        return 'BO1'
    if mx == 2:
        return 'BO3'
    return 'BO5'


# ---------------------------------------------------------------------------
# Step 1 – aggregate OE individual games → series rows
# ---------------------------------------------------------------------------

def _build_oe_series(games: pd.DataFrame) -> pd.DataFrame:
    """
    Collapse per-game OE rows into per-series rows for the 4 major leagues.

    LPL gameids share a prefix (e.g. 10665-10665_game_1 → 10665-10665).
    LCK/LEC/LCS assign a unique gameid per game, so we group by
    (league, date_day, normalised team pair).
    """
    g = games[games['league'].isin(ODDS_LEAGUES)].copy()
    g['date_day'] = pd.to_datetime(g['date']).dt.normalize()

    # ---- LPL: prefix-based series ----
    lpl = g[g['league'] == 'LPL'].copy()
    lpl['series_id'] = lpl['gameid'].str.rsplit('_game_', n=1).str[0]

    # ---- LCK / LEC / LCS: group by (league, date_day, team pair) ----
    other = g[g['league'] != 'LPL'].copy()
    other['_pair'] = other.apply(
        lambda r: _pair_key(r['blue_team_teamname'], r['red_team_teamname']), axis=1
    )
    other['series_id'] = (
        other['league'] + '_'
        + other['date_day'].dt.strftime('%Y%m%d') + '_'
        + other['_pair']
    )

    combined = pd.concat([lpl, other], ignore_index=True)

    def _agg_series(grp):
        grp = grp.sort_values('game')
        g1 = grp.iloc[0]
        blue = g1['blue_team_teamname']
        red  = g1['red_team_teamname']

        # Count wins per team (blue_team_result == 1 means blue won)
        blue_wins = grp['blue_team_result'].sum()
        red_wins  = len(grp) - blue_wins

        if blue_wins >= red_wins:
            winner, loser = blue, red
            w_wins, l_wins = int(blue_wins), int(red_wins)
        else:
            winner, loser = red, blue
            w_wins, l_wins = int(red_wins), int(blue_wins)

        return pd.Series({
            'league':      g1['league'],
            'year':        int(g1['year']),
            'date_day':    g1['date_day'].date(),
            'blue_team':   blue,
            'red_team':    red,
            'oe_winner':   winner,
            'oe_loser':    loser,
            'oe_score':    f'{w_wins}-{l_wins}',
            'oe_w_wins':   w_wins,
            'oe_l_wins':   l_wins,
            'num_games':   len(grp),
            'pair_key':    _pair_key(blue, red),
        })

    series = combined.groupby('series_id', sort=False).apply(
        _agg_series, include_groups=False
    ).reset_index()
    series['date_day'] = pd.to_datetime(series['date_day'])
    print(f"OE series built: {len(series):,} series across {ODDS_LEAGUES}")
    return series, combined[['gameid', 'series_id']]


# ---------------------------------------------------------------------------
# Step 2 – normalise odds and join
# ---------------------------------------------------------------------------

def _prepare_odds(odds: pd.DataFrame) -> pd.DataFrame:
    o = odds.copy()
    o['norm_team1'] = o['team1'].map(_norm)
    o['norm_team2'] = o['team2'].map(_norm)
    o['pair_key']   = o.apply(lambda r: _pair_key(r['team1'], r['team2']), axis=1)
    o['date_day']   = pd.to_datetime(o['match_date'])
    return o


def _merge_series(oe_series: pd.DataFrame, odds: pd.DataFrame) -> pd.DataFrame:
    odds_prep = _prepare_odds(odds)

    # Primary join on exact date
    merged = oe_series.merge(
        odds_prep,
        on=['league', 'year', 'date_day', 'pair_key'],
        how='left',
    )

    # Secondary join with OE date shifted -1 day for leagues where OE timestamps
    # are in UTC/KST and games are played in Western timezones (LCS, LEC)
    unmatched_mask = merged['odd1_decimal'].isna()
    if unmatched_mask.any():
        unmatched = oe_series[unmatched_mask.values].copy()
        unmatched['date_day'] = unmatched['date_day'] - pd.Timedelta(days=1)
        fallback = unmatched.merge(
            odds_prep,
            on=['league', 'year', 'date_day', 'pair_key'],
            how='inner',
        )
        fallback['date_day'] = fallback['date_day'] + pd.Timedelta(days=1)  # restore
        if len(fallback):
            odds_cols_fb = [c for c in fallback.columns if c not in oe_series.columns or c == 'series_id']
            fallback_indexed = fallback.set_index('series_id')[
                [c for c in fallback.columns if c not in oe_series.columns]
            ]
            merged_indexed = merged.set_index('series_id')
            merged_indexed.update(fallback_indexed)
            merged = merged_indexed.reset_index()

    n_total   = len(merged)
    n_matched = merged['odd1_decimal'].notna().sum()
    print(f"Series matched: {n_matched:,} / {n_total:,} "
          f"({100 * n_matched / n_total:.1f}%)")

    # Add a flag for which OE team corresponds to odds team1
    merged['blue_is_team1'] = merged.apply(
        lambda r: _norm(r['blue_team']) == r['norm_team1']
                  if pd.notna(r.get('norm_team1')) else np.nan,
        axis=1
    )

    # Infer format from odds scores
    merged['format'] = merged.apply(
        lambda r: _infer_format(int(r['score1']), int(r['score2']))
        if pd.notna(r.get('score1')) else np.nan,
        axis=1
    )

    # Back-solve per-game q for each team relative to team1 in odds
    def _compute_q(row):
        if pd.isna(row.get('implied_prob1_vigfree')) or pd.isna(row.get('format')):
            return np.nan, np.nan
        q1 = _back_solve_q(row['implied_prob1_vigfree'], row['format'])
        q2 = 1.0 - q1 if not np.isnan(q1) else np.nan
        return q1, q2

    merged[['q_team1', 'q_team2']] = merged.apply(
        _compute_q, axis=1, result_type='expand'
    )

    # Express per-game q from blue team's perspective
    merged['q_blue_win'] = merged.apply(
        lambda r: r['q_team1'] if r.get('blue_is_team1') else r['q_team2']
        if pd.notna(r.get('blue_is_team1')) else np.nan,
        axis=1
    )

    # Flag rows where OE game count doesn't match odds score total
    # (can happen when a BO3 spans two UTC calendar days or rare data gaps)
    merged['score_match'] = merged.apply(
        lambda r: (r['oe_w_wins'] + r['oe_l_wins']) == (r['score1'] + r['score2'])
        if pd.notna(r.get('score1')) else np.nan,
        axis=1
    )
    n_mismatch = int((merged['score_match'] == False).sum())
    if n_mismatch:
        print(f"  ({n_mismatch} series with score mismatch flagged — "
              f"likely BO3s spanning two UTC days)")

    return merged


# ---------------------------------------------------------------------------
# Step 3 – join series odds back onto individual game rows
# ---------------------------------------------------------------------------

def _attach_to_games(games: pd.DataFrame, game_series_map: pd.DataFrame,
                     series_with_odds: pd.DataFrame) -> pd.DataFrame:
    # Series-level odds columns to carry forward (drop series-level q_blue_win —
    # it was computed for game 1's blue team; we recompute per game below)
    odds_cols = [
        'series_id', 'odd1_decimal', 'odd2_decimal',
        'implied_prob1_vigfree', 'implied_prob2_vigfree',
        'team1', 'team2', 'norm_team1', 'norm_team2',
        'format', 'q_team1', 'q_team2', 'score_match',
    ]

    series_slim = series_with_odds[odds_cols].copy()
    joined = game_series_map.merge(series_slim, on='series_id', how='left')
    result = games.merge(
        joined[['gameid'] + [c for c in odds_cols if c != 'series_id']],
        on='gameid', how='left',
    )

    # Recompute q_blue_win per game: check which odds team is on blue side THIS game
    result['blue_is_odds_team1'] = (
        result['blue_team_teamname'].map(_norm) == result['norm_team1']
    )
    result['q_blue_win'] = np.where(
        result['q_team1'].isna(),
        np.nan,
        np.where(result['blue_is_odds_team1'], result['q_team1'], result['q_team2']),
    )

    n = result['odd1_decimal'].notna().sum()
    print(f"Games with odds attached: {n:,} / {len(result):,} "
          f"({100 * n / len(result):.1f}%)")
    return result


# ---------------------------------------------------------------------------
# LPL BO2 fix
# ---------------------------------------------------------------------------

def _fix_lpl_bo2(df: pd.DataFrame) -> pd.DataFrame:
    """
    LPL regular season uses BO2 format. OE records each game separately with
    game=1, so same-day same-team LPL pairs both appear as game=1 with format=BO1.
    Fix: identify these pairs, re-number them (1 and 2), and set format=BO2.
    """
    df = df.copy()
    df['_date_day'] = pd.to_datetime(df['date']).dt.date
    df['_pair'] = df.apply(
        lambda r: tuple(sorted([r['blue_team_teamname'], r['red_team_teamname']])), axis=1
    )

    lpl = df[(df['league'] == 'LPL') & (df['format'] == 'BO1')].copy()
    dupes = lpl[lpl.duplicated(subset=['_date_day', '_pair'], keep=False)]

    fixed = 0
    for (day, pair), grp in dupes.groupby(['_date_day', '_pair']):
        if len(grp) == 2:
            idx = grp.sort_values('date').index
            df.loc[idx[0], 'game']   = 1
            df.loc[idx[1], 'game']   = 2
            df.loc[idx,    'format'] = 'BO2'
            fixed += 1

    df = df.drop(columns=['_date_day', '_pair'])
    if fixed:
        print(f"Fixed {fixed} LPL BO2 series (relabeled from BO1, renumbered games)")
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run():
    games_path = PROCESSED_DIR / 'games.csv'
    odds_path  = ODDS_DIR / 'odds_all.csv'

    if not games_path.exists():
        raise FileNotFoundError(f"Missing {games_path}. Run combine_data.py first.")
    if not odds_path.exists():
        raise FileNotFoundError(f"Missing {odds_path}. Run PullOddsData.py first.")

    print("Loading data...")
    games = pd.read_csv(games_path, low_memory=False)
    odds  = pd.read_csv(odds_path)

    print("Building OE series...")
    oe_series, game_series_map = _build_oe_series(games)

    print("Merging with odds...")
    series_with_odds = _merge_series(oe_series, odds)

    print("Attaching odds to individual games...")
    games_with_odds = _attach_to_games(games, game_series_map, series_with_odds)

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    series_out = PROCESSED_DIR / 'series_with_odds.csv'
    games_out  = PROCESSED_DIR / 'games_with_odds.csv'

    games_with_odds = _fix_lpl_bo2(games_with_odds)

    series_with_odds.to_csv(series_out, index=False)
    games_with_odds.to_csv(games_out,  index=False)

    print(f"\nSaved:")
    print(f"  {series_out}  ({len(series_with_odds):,} rows, {len(series_with_odds.columns)} cols)")
    print(f"  {games_out}   ({len(games_with_odds):,} rows, {len(games_with_odds.columns)} cols)")
    return series_with_odds, games_with_odds


if __name__ == '__main__':
    run()
