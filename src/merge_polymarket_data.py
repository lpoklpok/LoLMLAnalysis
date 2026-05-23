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
import re
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

def _norm_team(s) -> str:
    """Normalize a team name for join keys — drop case + all non-alphanumerics.
    Handles OE 'BNK FEARX' vs Polymarket 'BNK FearX' (case), and
    'Nongshim RedForce' vs 'Nongshim Red Force' (whitespace). """
    return re.sub(r'[^a-z0-9]', '', str(s).lower())


def _series_key(blue: str, red: str) -> tuple:
    """Stable team-pair key for joining OE games to Polymarket snapshots.
    Team names are normalized (lowercased, non-alphanumerics stripped) so
    OE and Polymarket variants match.

    NOTE: we deliberately do NOT include the calendar day. Polymarket's
    `match_date` is the market RESOLUTION timestamp, which for late-EU
    matches is midnight-of-the-next-UTC-day, while OE's `date` is the
    actual game start time. Including date_day in the key would prevent
    the join for any LEC/LCS late evening match. We rely instead on the
    pregame temporal cutoff inside `_pick_snapshots` (and the staleness
    cap below) to associate snapshots to the right series."""
    return tuple(sorted([_norm_team(blue), _norm_team(red)]))


PREGAME_BUFFER = pd.Timedelta(minutes=10)
SNAPSHOT_STALENESS_CAP = pd.Timedelta(days=14)


def _pick_snapshots(snaps: pd.DataFrame, first_game_ts: pd.Timestamp) -> dict[str, dict]:
    """From a per-matchup slice of snapshots, take the latest snapshot of each
    market_type that occurred BEFORE (first_game_ts − 10 min) — excluding the
    draft phase, where champion picks have already started leaking information.
    Snapshots older than 14 days before game time are ignored (would belong to
    a prior series between the same teams).
    Returns {market_type: {prob_for_team1, team1, team2}}."""
    cutoff = first_game_ts - PREGAME_BUFFER
    lower  = first_game_ts - SNAPSHOT_STALENESS_CAP
    before = snaps[(snaps['snapshot_time_ts'] < cutoff) & (snaps['snapshot_time_ts'] >= lower)]
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
    """outcome1_mid is from team1's perspective; flip if team1 ≠ blue.
    Uses the same _norm_team normalization as _series_key so case/whitespace
    differences (OE 'BNK FEARX' vs Polymarket 'BNK FearX') don't flip wrong."""
    if _norm_team(snap_team1) == _norm_team(blue):
        return prob_team1
    return 1 - prob_team1


# ── Main merge ──────────────────────────────────────────────────────────────

def merge_polymarket_odds(games: pd.DataFrame, snaps: pd.DataFrame) -> pd.DataFrame:
    """Add poly_blue_win_prob and poly_source columns to games (in-place return)."""
    games = games.copy()
    if 'best_of' not in games.columns:
        # Fall back: infer best_of per series from max(game) observed.
        # gameid format is "{series_id}-{series_id}_game_{N}", so the series_id
        # is everything up to the "_game_N" suffix.
        series_id = games['gameid'].astype(str).str.replace(r'_game_\d+$', '', regex=True)
        max_game = games.groupby(series_id)['game'].transform('max')
        games['best_of'] = np.where(max_game <= 1, 1, np.where(max_game <= 3, 3, 5))

    games['_date_ts']  = pd.to_datetime(games['date'], errors='coerce', utc=True)
    games['_date_day'] = games['_date_ts'].dt.strftime('%Y-%m-%d')
    games['_series_key'] = games.apply(
        lambda r: _series_key(r['blue_team_teamname'], r['red_team_teamname']),
        axis=1
    )

    # Preprocess snapshots
    snaps = snaps.copy()
    snaps['snapshot_time_ts'] = pd.to_datetime(snaps['snapshot_time'], errors='coerce', utc=True)
    snaps['_series_key']      = snaps.apply(
        lambda r: _series_key(r['team1'], r['team2']),
        axis=1
    )

    # NOTE: must build a per-gameid map then assign — using positional list
    # assignment via `games['poly_blue_win_prob'] = list` is order-dependent
    # on groupby traversal and silently misaligns rows.
    prob_by_gameid: dict[str, float | None] = {}
    source_by_gameid: dict[str, str | None] = {}

    # Debug counters
    snap_keys = set(snaps['_series_key'].unique())
    earliest_snap = snaps['snapshot_time_ts'].min()
    print(f'  diag: {len(snap_keys):,} unique series keys in snapshots; earliest snapshot at {earliest_snap}')

    # Diagnostic: print 5 sample snapshot keys + 5 OE series keys from May 22 to compare
    print('  diag: sample SNAPSHOT keys (5):')
    for k in list(snap_keys)[:5]:
        print(f'    {k}')
    games_recent = games[games['_date_day'] >= '2026-05-21']
    print(f'  diag: OE games on/after 2026-05-21: {len(games_recent):,}')
    # Show the latest OE date and any G2-vs-KC entries for explicit visibility
    if not games_recent.empty:
        max_dt = games_recent['_date_ts'].max()
        print(f'  diag: max OE date in pulled file: {max_dt}')
    if 'league' in games.columns:
        league_counts = games_recent['league'].value_counts().head(10)
        print('  diag: top leagues in recent OE games:')
        for lg, ct in league_counts.items():
            print(f'    {lg}: {ct}')
    bk = games['blue_team_teamname'].astype(str)
    rk = games['red_team_teamname'].astype(str)
    g2kc = games[((bk.str.contains('G2', case=False, na=False) & rk.str.contains('Karmine', case=False, na=False)) |
                   (rk.str.contains('G2', case=False, na=False) & bk.str.contains('Karmine', case=False, na=False))) &
                  (games['_date_day'] >= '2026-05-20')]
    print(f"  diag: G2-vs-KC OE games >=May 20 in pulled file: {len(g2kc)}")
    for _, r in g2kc.iterrows():
        print(f"    {r['gameid']} {r['_date_ts']} {r['blue_team_teamname']} vs {r['red_team_teamname']}")
    print('  diag: sample OE series keys (recent, 5):')
    seen = set()
    for k in games_recent['_series_key']:
        if k in seen: continue
        seen.add(k)
        print(f'    {k}')
        if len(seen) >= 5: break
    print(f'  diag: intersection of snapshot/OE-recent keys: {len(snap_keys & seen)}')
    n_series = 0; n_series_with_any_snap = 0; n_series_with_pregame_snap = 0; n_series_merged = 0
    sample_miss_no_snap: list = []
    sample_miss_snap_post: list = []

    # Process series at a time
    for series_key, series_games in games.groupby('_series_key'):
        n_series += 1
        first_game_ts = series_games['_date_ts'].min()
        series_snaps  = snaps[snaps['_series_key'] == series_key]
        if not series_snaps.empty: n_series_with_any_snap += 1
        picked        = _pick_snapshots(series_snaps, first_game_ts) if not series_snaps.empty else {}
        if picked: n_series_with_pregame_snap += 1
        # Sample recent missed matchups for diagnostics
        if not picked and first_game_ts is not None and first_game_ts >= pd.Timestamp('2026-05-21', tz='UTC'):
            if not series_snaps.empty:
                # We have snapshots but all are post-game-start
                if len(sample_miss_snap_post) < 6:
                    sample_miss_snap_post.append((series_key, str(first_game_ts), len(series_snaps)))
            else:
                if len(sample_miss_no_snap) < 6:
                    sample_miss_no_snap.append((series_key, str(first_game_ts)))
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
                    p = blue_prob_of('game_1_winner')
                    source = 'game_1_winner' if p is not None else None
                elif gnum == 2:
                    p = blue_prob_of('game_2_winner')
                    source = 'game_2_winner' if p is not None else None
                elif gnum == 3:
                    p_s  = blue_prob_of('match_winner')
                    p_g1 = blue_prob_of('game_1_winner')
                    p_g2 = blue_prob_of('game_2_winner')
                    if p_s is not None and p_g1 is not None and p_g2 is not None:
                        p = bo3_g3_prob(p_s, p_g1, p_g2)
                        source = 'derived_g3'
            elif bo == 5:
                if gnum == 1:
                    p = blue_prob_of('game_1_winner')
                    source = 'game_1_winner' if p is not None else None
                elif gnum == 2:
                    p = blue_prob_of('game_2_winner')
                    source = 'game_2_winner' if p is not None else None
                elif gnum == 3:
                    p = blue_prob_of('game_3_winner')
                    source = 'game_3_winner' if p is not None else None
                elif gnum == 4:
                    p = blue_prob_of('game_4_winner')
                    source = 'game_4_winner' if p is not None else None
                elif gnum == 5:
                    p_s  = blue_prob_of('match_winner')
                    p_g1 = blue_prob_of('game_1_winner')
                    p_g2 = blue_prob_of('game_2_winner')
                    p_g3 = blue_prob_of('game_3_winner')
                    p_g4 = blue_prob_of('game_4_winner')
                    if None not in (p_s, p_g1, p_g2, p_g3, p_g4):
                        p = bo5_g5_prob(p_s, p_g1, p_g2, p_g3, p_g4)
                        source = 'derived_g5'

            gid = g['gameid']
            prob_by_gameid[gid]   = None if p is None else round(float(p), 4)
            source_by_gameid[gid] = source
            if p is not None:
                n_series_merged += 1

    print(f'  diag: {n_series:,} OE series total')
    print(f'  diag:   {n_series_with_any_snap:,} have at least 1 snapshot (any time)')
    print(f'  diag:   {n_series_with_pregame_snap:,} have a snapshot BEFORE first-game time')
    if sample_miss_no_snap:
        print(f'  diag: recent series with NO snapshot match (likely team-name or date mismatch):')
        for k, t in sample_miss_no_snap: print(f'    {k}  first_game={t}')
    if sample_miss_snap_post:
        print(f'  diag: recent series with snapshots that all post-date first game:')
        for k, t, n in sample_miss_snap_post: print(f'    {k}  first_game={t}  n_snaps={n}')
    # Map by gameid (NOT positional assignment — see comment above)
    games['poly_blue_win_prob'] = games['gameid'].map(prob_by_gameid)
    games['poly_source']        = games['gameid'].map(source_by_gameid)

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
