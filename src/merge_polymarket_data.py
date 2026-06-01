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
    """Normalize a team name for join keys — drop case + diacritics + all non-alphanumerics,
    then apply known PM/OE aliases.

    Handles OE 'BNK FEARX' vs Polymarket 'BNK FearX' (case),
    'Nongshim RedForce' vs 'Nongshim Red Force' (whitespace),
    OE 'LØS' vs Polymarket 'LOS' (Scandinavian Ø → O, not dropped),
    and known PM-only-tweaks (PM 'T1 Academy' vs OE 'T1 Esports Academy', etc.)."""
    import unicodedata
    s = str(s).lower()
    s = s.replace('ø', 'o').replace('ł', 'l').replace('æ', 'ae').replace('œ', 'oe')
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r'[^a-z0-9]', '', s)
    # Known PM ↔ OE alias collapses. Both sides normalize to the same canonical
    # key so the merge picks them up. Add a row here when the drift checker
    # flags a real same-team-different-name mismatch.
    aliases = {
        # PM 'T1 Academy' vs OE 'T1 Esports Academy'
        't1academy':         't1esportsacademy',
        # PM 'PCIFIC' vs OE 'PCIFIC Esports'
        'pcific':            'pcificesports',
        # PM 'UCAM Esports Club' vs OE 'UCAM Esports'
        'ucamesportsclub':   'ucamesports',
        # PM 'Senshi Esports Club' vs OE 'Senshi eSports'
        'senshiesportsclub': 'senshiesports',
        # PM 'The Otter Side' vs OE 'Otter Side'
        'theotterside':      'otterside',
        # PM 'Orbit Anonymo' vs OE 'Anonymo Esports' (sponsor prefix only on PM)
        'orbitanonymo':      'anonymoesports',
        # PM 'BIG' vs OE 'Berlin International Gaming' (BIG is the acronym)
        'big':               'berlininternationalgaming',
        # PM 'FURIA Esports' vs OE 'FURIA' (CBLOL — OE uses the short form)
        'furiaesports':      'furia',
        # PM 'NRG Esports' vs OE 'NRG' (NACL — OE uses the short form)
        'nrgesports':        'nrg',
    }
    return aliases.get(s, s)


def _team_pair_key(blue: str, red: str) -> tuple:
    """Team-pair-only key for JOINING OE games to Polymarket snapshots.
    Polymarket's match_date is the market RESOLUTION timestamp (often
    midnight of the next UTC day for late-EU matches), so we cannot
    match on calendar day. We rely on the pregame temporal cutoff inside
    `_pick_snapshots` to associate the right snapshots."""
    return tuple(sorted([_norm_team(blue), _norm_team(red)]))


def _oe_series_key(blue: str, red: str, date_day: str) -> tuple:
    """Team-pair + date_day key for GROUPING OE rows into a physical
    series (so a bo5 played in one day stays together as one series,
    and that team-pair's match from 6 months ago is a separate series)."""
    return (date_day, tuple(sorted([_norm_team(blue), _norm_team(red)])))


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
    """Add poly_blue_win_prob and poly_source columns to games (in-place return).

    Performance: snapshots only exist from when the snapshot worker was
    deployed (2026-05-22 onward). We only need to recompute poly_* for games
    whose date is within the snapshot window — about 1% of the 100k+ rows.
    Pre-snapshot rows keep their existing values (NaN or whatever a prior
    run wrote).
    """
    games = games.copy()
    # Preserve existing poly columns; we'll only overwrite recent rows.
    existing_prob   = games['poly_blue_win_prob'] if 'poly_blue_win_prob' in games.columns else pd.Series(pd.NA, index=games.index)
    existing_source = games['poly_source']        if 'poly_source'        in games.columns else pd.Series(pd.NA, index=games.index)

    # Filter the work set: games newer than (earliest snapshot - 1 day).
    games['_date_ts'] = pd.to_datetime(games['date'], errors='coerce', utc=True)
    earliest_snap_ts = pd.to_datetime(snaps['snapshot_time'], errors='coerce', utc=True).min()
    if pd.notna(earliest_snap_ts):
        cutoff = earliest_snap_ts - pd.Timedelta(days=1)
        recent_mask = games['_date_ts'] >= cutoff
        print(f'  performance: processing {recent_mask.sum():,} games newer than {cutoff.date()} '
              f'(skipping {(~recent_mask).sum():,} older rows)')
        # Subset the work, but stash the original index so we can re-merge.
        work = games[recent_mask].copy()
    else:
        work = games.copy()
        recent_mask = pd.Series(True, index=games.index)

    if 'best_of' not in work.columns:
        # Fall back: infer best_of per series from max(game) observed.
        series_id = work['gameid'].astype(str).str.replace(r'_game_\d+$', '', regex=True)
        max_game = work.groupby(series_id)['game'].transform('max')
        work['best_of'] = np.where(max_game <= 1, 1, np.where(max_game <= 3, 3, 5))

    # _date_ts already set above for filtering; just derive _date_day on work.
    work['_date_day'] = work['_date_ts'].dt.strftime('%Y-%m-%d')
    work['_oe_series_key'] = work.apply(
        lambda r: _oe_series_key(r['blue_team_teamname'], r['red_team_teamname'], r['_date_day']),
        axis=1
    )
    work['_pair_key'] = work.apply(
        lambda r: _team_pair_key(r['blue_team_teamname'], r['red_team_teamname']),
        axis=1
    )

    # Preprocess snapshots — only need the team-pair key (we join on this)
    snaps = snaps.copy()
    snaps['snapshot_time_ts'] = pd.to_datetime(snaps['snapshot_time'], errors='coerce', utc=True)
    snaps['_pair_key']        = snaps.apply(
        lambda r: _team_pair_key(r['team1'], r['team2']),
        axis=1
    )

    # NOTE: must build a per-gameid map then assign — using positional list
    # assignment via `games['poly_blue_win_prob'] = list` is order-dependent
    # on groupby traversal and silently misaligns rows.
    prob_by_gameid: dict[str, float | None] = {}
    source_by_gameid: dict[str, str | None] = {}

    n_series = n_series_merged = 0
    # Iterate each OE physical series (team-pair + same calendar day).
    for series_key, series_games in work.groupby('_oe_series_key'):
        n_series += 1
        first_game_ts = series_games['_date_ts'].min()
        pair_key      = series_games['_pair_key'].iloc[0]
        series_snaps  = snaps[snaps['_pair_key'] == pair_key]
        picked        = _pick_snapshots(series_snaps, first_game_ts) if not series_snaps.empty else {}
        # Derive best_of preferring Polymarket's submarkets (game_N_winner
        # markets that exist). A 3-0 Bo5 sweep would otherwise be misclassified
        # as a Bo3 by OE's max(game) alone, and we'd back-solve G3 from series
        # + G1 + G2 instead of using Polymarket's real game_3_winner market.
        if 'game_4_winner' in picked or 'game_5_winner' in picked:
            bo = 5
        elif 'game_3_winner' in picked:
            # Polymarket exposes game_3 but not game_4 → Bo3 with derived g3.
            # But if game_3_winner is present *as a direct market*, we want bo=5
            # behavior so we use it directly. Heuristic: Bo3s don't carry a
            # game_3_winner market (no need — series price covers it); Bo5s do.
            bo = 5
        elif 'game_2_winner' in picked:
            bo = 3
        else:
            max_game = int(series_games['game'].max())
            bo = 1 if max_game <= 1 else (3 if max_game <= 3 else 5)

        # Convert each picked market to blue-team probability for this series
        # (blue side can swap mid-series so we look up per-game)
        for _, g in series_games.iterrows():
            blue = g['blue_team_teamname']
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
                    # Polymarket's game_4_winner is illiquid/unreliable — reuse
                    # game_3_winner as the Game 4 probability proxy.
                    p = blue_prob_of('game_3_winner')
                    source = 'game_3_winner_for_g4' if p is not None else None
                elif gnum == 5:
                    p_s  = blue_prob_of('match_winner')
                    p_g1 = blue_prob_of('game_1_winner')
                    p_g2 = blue_prob_of('game_2_winner')
                    p_g3 = blue_prob_of('game_3_winner')
                    # Use game_3_winner as the Game 4 probability proxy (same
                    # reason as gnum==4 above), then back-solve for Game 5.
                    p_g4 = blue_prob_of('game_3_winner')
                    if None not in (p_s, p_g1, p_g2, p_g3, p_g4):
                        p = bo5_g5_prob(p_s, p_g1, p_g2, p_g3, p_g4)
                        source = 'derived_g5_g3proxy'

            gid = g['gameid']
            prob_by_gameid[gid]   = None if p is None else round(float(p), 4)
            source_by_gameid[gid] = source
            if p is not None:
                n_series_merged += 1

    print(f'  merge: {n_series:,} recent series processed, {n_series_merged:,} game-fills written')

    # Build the new poly columns from the recent work, then COALESCE onto
    # the existing values so pre-snapshot-era rows keep whatever was already
    # there (NaN on first run, persisted values on subsequent runs).
    new_prob   = games['gameid'].map(prob_by_gameid)
    new_source = games['gameid'].map(source_by_gameid)
    games['poly_blue_win_prob'] = new_prob.where(new_prob.notna(), existing_prob)
    games['poly_source']        = new_source.where(new_source.notna(), existing_source)

    games = games.drop(columns=['_date_ts'])
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
