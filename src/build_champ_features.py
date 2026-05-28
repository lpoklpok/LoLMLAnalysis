"""
build_champ_features.py
Walk-forward computation of champion-level pre-game features for every game
in games_with_odds.csv. For each game G at time T, all features are derived
ONLY from games with timestamp < T — no leakage.

Output: data/processed/champ_features.csv, keyed by gameid. Join on gameid
into features_all.csv during training.

Features per game (diffs = blue - red):
    avg_player_champ_familiarity_diff
        Per player: 1 if they've played this champion in the last 30d, else 0.
        Averaged across 5 starters, then blue - red.

    avg_player_champ_wr_diff
        Per player who has played this champion in the last 30d: their WR on
        it. Mean across 5 starters (NaN players excluded), then blue - red.

    avg_champ_meta_wr_diff
        Per position: champion's global 14d WR at that position (across all
        games / leagues). Average across 5 picks, then blue - red.

    first3_pick_diff
        Pick priority: count of starters whose champion was a "first 3 pick"
        in their side's draft (proxy: standard role priority based on Solo Q
        / pro patterns — see code). Probably noisy.

    roster_stability_diff
        Per side: # of days the current 5-stack has played together (capped 60).
        blue - red.

This script is idempotent — re-running rebuilds champ_features.csv from
scratch. Walk-forward is single-pass O(N).
"""
from collections import defaultdict, deque
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

ROOT      = Path(__file__).resolve().parent.parent
SRC       = ROOT / 'data' / 'processed' / 'games_with_odds.csv'
OUT       = ROOT / 'data' / 'processed' / 'champ_features.csv'

POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']
FAMILIARITY_DAYS = 30
META_DAYS        = 14
ROSTER_STABILITY_CAP_DAYS = 60


def main():
    print(f'Loading {SRC}...')
    df = pd.read_csv(SRC, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)
    print(f'  {len(df):,} games')

    # State (all walking forward through time):
    # - player_champ_hist[(player, champ)] = deque of (date, won?) — recent appearances
    # - champ_pos_hist[(champ, pos)] = deque of (date, won?) — meta strength
    # - roster_first_seen[(team, frozenset_of_players)] = first date that exact roster played
    player_champ_hist: dict[tuple[str, str], deque] = defaultdict(deque)
    champ_pos_hist:    dict[tuple[str, str], deque] = defaultdict(deque)
    roster_first_seen: dict[tuple[str, frozenset], pd.Timestamp] = {}

    def expire(dq: deque, cutoff):
        while dq and dq[0][0] < cutoff:
            dq.popleft()

    def familiarity(player: str, champ: str, cutoff) -> tuple[float, float | None]:
        """Returns (familiarity_flag, win_rate_if_any)."""
        dq = player_champ_hist[(player, champ)]
        expire(dq, cutoff)
        if not dq:
            return 0.0, None
        wins = sum(1 for _, won in dq if won)
        return 1.0, wins / len(dq)

    def meta_wr(champ: str, pos: str, cutoff) -> float | None:
        dq = champ_pos_hist[(champ, pos)]
        expire(dq, cutoff)
        if len(dq) < 5:   # require min sample
            return None
        return sum(1 for _, won in dq if won) / len(dq)

    rows = []
    for g in df.itertuples(index=False):
        date     = g.date
        cutoff_fam  = date - timedelta(days=FAMILIARITY_DAYS)
        cutoff_meta = date - timedelta(days=META_DAYS)

        blue_team = g.blue_team_teamname
        red_team  = g.red_team_teamname

        # Look up per-side features BEFORE incorporating this game's result
        sides_out = {}
        for side, team_name in [('blue', blue_team), ('red', red_team)]:
            fam_flags = []
            fam_wrs   = []
            meta_wrs  = []
            players   = []
            for pos in POSITIONS:
                p     = getattr(g, f'{side}_{pos}_playername', None)
                champ = getattr(g, f'{side}_{pos}_champion',   None)
                if not isinstance(p, str) or not isinstance(champ, str):
                    continue
                players.append(p)
                f_flag, f_wr = familiarity(p, champ, cutoff_fam)
                fam_flags.append(f_flag)
                if f_wr is not None:
                    fam_wrs.append(f_wr)
                m_wr = meta_wr(champ, pos, cutoff_meta)
                if m_wr is not None:
                    meta_wrs.append(m_wr)
            avg_fam_flag = float(np.mean(fam_flags)) if fam_flags else float('nan')
            avg_fam_wr   = float(np.mean(fam_wrs))   if fam_wrs   else float('nan')
            avg_meta_wr  = float(np.mean(meta_wrs))  if meta_wrs  else float('nan')
            # Roster stability
            stab_days = float('nan')
            if len(players) == 5 and isinstance(team_name, str):
                key = (team_name, frozenset(players))
                first = roster_first_seen.get(key)
                if first is not None:
                    stab_days = min((date - first).total_seconds() / 86400,
                                     ROSTER_STABILITY_CAP_DAYS)
                else:
                    roster_first_seen[key] = date
                    stab_days = 0.0
            sides_out[side] = {
                'fam_flag': avg_fam_flag,
                'fam_wr':   avg_fam_wr,
                'meta_wr':  avg_meta_wr,
                'stab':     stab_days,
            }

        b, r = sides_out['blue'], sides_out['red']

        def d(k):
            bv, rv = b[k], r[k]
            return float(bv - rv) if not (np.isnan(bv) or np.isnan(rv)) else float('nan')

        rows.append({
            'gameid':                            g.gameid,
            'avg_player_champ_familiarity_diff': d('fam_flag'),
            'avg_player_champ_wr_diff':          d('fam_wr'),
            'avg_champ_meta_wr_diff':            d('meta_wr'),
            'roster_stability_diff':             d('stab'),
        })

        # Now UPDATE state with this game's result
        blue_won = int(g.blue_team_result) == 1
        for side, side_won in [('blue', blue_won), ('red', not blue_won)]:
            for pos in POSITIONS:
                p     = getattr(g, f'{side}_{pos}_playername', None)
                champ = getattr(g, f'{side}_{pos}_champion',   None)
                if not isinstance(p, str) or not isinstance(champ, str):
                    continue
                player_champ_hist[(p, champ)].append((date, side_won))
                champ_pos_hist[(champ, pos)].append((date, side_won))

    out = pd.DataFrame(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(OUT, index=False)
    print(f'\nWrote {OUT} ({len(out):,} rows, {len(out.columns)} cols)')
    print('\nFeature non-null rates:')
    for c in out.columns:
        if c == 'gameid': continue
        pct = out[c].notna().mean() * 100
        print(f'  {c:<40} {pct:>5.1f}%  populated')


if __name__ == '__main__':
    main()
