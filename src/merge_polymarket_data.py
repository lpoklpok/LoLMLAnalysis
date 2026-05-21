"""
merge_polymarket_data.py
Joins per-game Polymarket implied probabilities onto games_with_odds.csv.

For each OE series (group of games with the same teams on the same day):
  1. Find the Polymarket snapshot rows for that matchup
  2. Keep snapshots taken BEFORE the first game of the series began
  3. For each market_type, pick the snapshot closest in time to first game start
  4. Derive per-game implied probabilities:
       Bo1 -> game 1 uses match_winner
       Bo3 -> game 1 uses game_1_winner
              game 2 uses game_2_winner
              game 3 derived from (match_winner, game_1, game_2)
       Bo5 -> games 1-4 use game_N_winner directly
              game 5 derived from (match_winner, g1..g4)
  5. Attach to every game row as poly_blue_win_prob + poly_source

The Fly worker (PolymarketSnapshots) populates the snapshot CSV. This script
is a no-op if the CSV doesn't exist yet — safe to wire into the daily pipeline
before the worker is deployed.

Output: in-place rewrite of data/processed/games_with_odds.csv with two new columns.
"""
import sys
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

ROOT       = Path(__file__).resolve().parent.parent
PROCESSED  = ROOT / 'data' / 'processed'
GAMES_CSV  = PROCESSED / 'games_with_odds.csv'
SNAPSHOT_CSV = PROCESSED / 'polymarket_submarket_snapshots.csv'


# ── Series-probability math ─────────────────────────────────────────────────

def bo3_g3_prob(p_series: float, p_g1: float, p_g2: float) -> float | None:
    """Solve for P(g3) such that P(series) = P(g1)*P(g2) + P(g3)*(P(g1)+P(g2)-2*P(g1)*P(g2))."""
    denom = p_g1 + p_g2 - 2 * p_g1 * p_g2
    if abs(denom) < 1e-9:
        return None
    p = (p_series - p_g1 * p_g2) / denom
    return max(0.0, min(1.0, p))


def bo5_series_prob(ps: list[float]) -> float:
    """P(team wins best-of-5) given independent per-game probabilities ps[0..4]."""
    total = 0.0
    for k in (3, 4, 5):
        for win_set in combinations(range(5), k):
            prob = 1.0
            for i in range(5):
                prob *= ps[i] if i in win_set else (1 - ps[i])
            total += prob
    return total


def bo5_g5_prob(p_series: float, p1: float, p2: float, p3: float, p4: float,
                iters: int = 50) -> float:
    """Bisect for P(g5) such that bo5_series_prob equals p_series."""
    lo, hi = 0.0, 1.0
    for _ in range(iters):
        mid = (lo + hi) / 2
        if bo5_series_prob([p1, p2, p3, p4, mid]) < p_series:
            lo = mid
        else:
            hi = mid
    return mid


# ── Snapshot lookup ─────────────────────────────────────────────────────────

def _series_key(blue: str, red: str, date_day: str) -> tuple:
    """Stable team-pair key for joining OE games to Polymarket snapshots."""
    return (date_day, tuple(sorted([str(blue).strip(), str(red).strip()])))


def _pick_snapshots(snaps: pd.DataFrame, first_game_ts: pd.Timestamp) -> dict[str, dict]:
    """From a per-matchup slice of snapshots, take the latest snapshot of each market_type
    that occurred BEFORE first_game_ts. Returns {market_type: {prob_for_team1, team1, team2}}."""
    before = snaps[snaps['snapshot_time_ts'] < first_game_ts]
    if before.empty:
        return {}
    # For each market_type, pick max snapshot_time row
    by_type = (before.sort_values('snapshot_time_ts')
                       .groupby('market_type', as_index=False).tail(1))
    out = {}
    for _, r in by_type.iterrows():
        out[r['market_type']] = {
            'prob_team1': float(r['outcome1_mid']),
            'team1':       str(r['team1']),
            'team2':       str(r['team2']),
        }
    return out


def _blue_prob_from_team1(prob_team1: float, snap_team1: str, blue: str) -> float:
    """outcome1_mid is from team1's perspective; flip if team1 ≠ blue."""
    if str(snap_team1).strip().lower() == str(blue).strip().lower():
        return prob_team1
    return 1 - prob_team1


# ── Main merge ──────────────────────────────────────────────────────────────

def merge_polymarket_odds(games: pd.DataFrame, snaps: pd.DataFrame) -> pd.DataFrame:
    """Add poly_blue_win_prob and poly_source columns to games (in-place return)."""
    games = games.copy()
    if 'best_of' not in games.columns:
        # Fall back: infer best_of per series from max(game) observed.
        max_game = games.groupby('gameid_series')['game'].transform('max')
        games['best_of'] = np.where(max_game <= 1, 1, np.where(max_game <= 3, 3, 5))

    games['_date_ts']  = pd.to_datetime(games['date'], errors='coerce', utc=True)
    games['_date_day'] = games['_date_ts'].dt.strftime('%Y-%m-%d')
    games['_series_key'] = games.apply(
        lambda r: _series_key(r['blue_team_teamname'], r['red_team_teamname'], r['_date_day']),
        axis=1
    )

    # Preprocess snapshots
    snaps = snaps.copy()
    snaps['snapshot_time_ts'] = pd.to_datetime(snaps['snapshot_time'], errors='coerce', utc=True)
    snaps['_date_day']        = pd.to_datetime(snaps['match_date'], errors='coerce', utc=True).dt.strftime('%Y-%m-%d')
    snaps['_series_key']      = snaps.apply(
        lambda r: _series_key(r['team1'], r['team2'], r['_date_day']),
        axis=1
    )

    poly_probs: list[float | None] = []
    poly_sources: list[str | None] = []

    # Process series at a time
    for series_key, series_games in games.groupby('_series_key'):
        first_game_ts = series_games['_date_ts'].min()
        series_snaps  = snaps[snaps['_series_key'] == series_key]
        picked        = _pick_snapshots(series_snaps, first_game_ts) if not series_snaps.empty else {}
        # Convert each picked market to blue-team probability for this series
        # (blue side can swap mid-series so we look up per-game)
        for _, g in series_games.iterrows():
            blue = g['blue_team_teamname']
            bo   = int(g['best_of'])
            gnum = int(g['game'])

            def blue_prob_of(mt: str) -> float | None:
                row = picked.get(mt)
                if not row: return None
                return _blue_prob_from_team1(row['prob_team1'], row['team1'], blue)

            p, source = None, None
            if bo == 1:
                p = blue_prob_of('match_winner')
                source = 'match_winner' if p is not None else None
            elif bo == 3:
                if gnum == 1:
                    p = blue_prob_of('game_1_winner');  source = 'game_1_winner'
                elif gnum == 2:
                    p = blue_prob_of('game_2_winner');  source = 'game_2_winner'
                elif gnum == 3:
                    p_s  = blue_prob_of('match_winner')
                    p_g1 = blue_prob_of('game_1_winner')
                    p_g2 = blue_prob_of('game_2_winner')
                    if p_s is not None and p_g1 is not None and p_g2 is not None:
                        p = bo3_g3_prob(p_s, p_g1, p_g2)
                        source = 'derived_g3'
            elif bo == 5:
                if   gnum == 1: p = blue_prob_of('game_1_winner'); source = 'game_1_winner'
                elif gnum == 2: p = blue_prob_of('game_2_winner'); source = 'game_2_winner'
                elif gnum == 3: p = blue_prob_of('game_3_winner'); source = 'game_3_winner'
                elif gnum == 4: p = blue_prob_of('game_4_winner'); source = 'game_4_winner'
                elif gnum == 5:
                    p_s  = blue_prob_of('match_winner')
                    p_g1 = blue_prob_of('game_1_winner')
                    p_g2 = blue_prob_of('game_2_winner')
                    p_g3 = blue_prob_of('game_3_winner')
                    p_g4 = blue_prob_of('game_4_winner')
                    if None not in (p_s, p_g1, p_g2, p_g3, p_g4):
                        p = bo5_g5_prob(p_s, p_g1, p_g2, p_g3, p_g4)
                        source = 'derived_g5'

            poly_probs.append(None if p is None else round(float(p), 4))
            poly_sources.append(source)

    games['poly_blue_win_prob'] = poly_probs
    games['poly_source']        = poly_sources

    # Drop the helper columns
    games = games.drop(columns=['_date_ts', '_date_day', '_series_key'])
    return games


def main() -> None:
    if not GAMES_CSV.exists():
        print(f'  {GAMES_CSV.name} not found — nothing to merge into')
        return
    if not SNAPSHOT_CSV.exists():
        print(f'  {SNAPSHOT_CSV.name} not yet populated — skipping polymarket merge')
        return

    print(f'  Loading {GAMES_CSV.name} + {SNAPSHOT_CSV.name}')
    games = pd.read_csv(GAMES_CSV, low_memory=False)
    snaps = pd.read_csv(SNAPSHOT_CSV, low_memory=False)

    n_before = len(games)
    out = merge_polymarket_odds(games, snaps)
    matched = out['poly_blue_win_prob'].notna().sum()
    print(f'  Merged: {matched}/{n_before} games got a polymarket implied prob')
    out.to_csv(GAMES_CSV, index=False)
    print(f'  Wrote {GAMES_CSV.name} ({n_before} rows)')


if __name__ == '__main__':
    main()
