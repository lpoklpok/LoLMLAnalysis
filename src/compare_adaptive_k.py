"""Adaptive K experiment: track a per-team "surprise score" (rolling abs mean
residual vs ELO-implied probability over last N games). When a team's surprise
is high, boost K so their ELO updates faster. When it normalizes, K returns
to baseline.

  surprise_T = |mean(actual_T_won − elo_implied_T)| over last N games
  K_T        = K_base · (1 + λ · surprise_T / scale)

Equivalent in spirit to Glicko-2's σ volatility, but stays inside the ELO
framework you already have.

Sweeps λ and N, compares pure-rating predictions (no LR) on log loss + Brier
across the same OOS window as compare_glicko_lr.
"""
from __future__ import annotations

from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd

from feature_engineering import POSITIONS, _starting_elo, K_FACTOR, ELO_SCALE, SERIES_K_ALPHA

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
GAMES_CSV = PROCESSED / 'games_with_odds.csv'

WARMUP_YEAR = 2023
SURPRISE_SCALE = 0.10   # |surprise| = 0.10 doubles K when λ=1


def k_scale_year(year: int) -> float:
    """Production rule: 0.3 for 2025+, 1.0 otherwise."""
    return SERIES_K_ALPHA if year >= 2025 else 1.0


def run_one(games: pd.DataFrame, *, N: int, lam: float, min_obs: int = 3) -> pd.DataFrame:
    """One pass through games with the given (N, λ). Returns per-game predictions."""
    elo_map: dict[str, float] = {}
    residuals: dict[str, deque] = defaultdict(lambda: deque(maxlen=N))
    out = []

    for g in games.itertuples(index=False):
        bp = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        rp = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp): continue
        bw = g.blue_team_result
        if pd.isna(bw): continue
        bw = int(bw)
        league = str(g.league)
        year   = int(g.year)
        b_team = str(g.blue_team_teamname)
        r_team = str(g.red_team_teamname)

        # Pre-game state
        start = _starting_elo(league)
        b_avg = sum(elo_map.get(p, start) for p in bp) / 5
        r_avg = sum(elo_map.get(p, start) for p in rp) / 5
        pred  = 1.0 / (1.0 + 10 ** ((r_avg - b_avg) / ELO_SCALE))

        # Pre-game surprise per team (absolute mean residual)
        def surprise(team: str) -> float:
            xs = list(residuals[team])
            if len(xs) < min_obs: return 0.0
            return abs(sum(xs) / len(xs))

        s_blue = surprise(b_team)
        s_red  = surprise(r_team)

        k_eff = K_FACTOR * k_scale_year(year)
        k_blue = k_eff * (1.0 + lam * (s_blue / SURPRISE_SCALE))
        k_red  = k_eff * (1.0 + lam * (s_red  / SURPRISE_SCALE))

        # Update per player (individual vs opposing team avg, same as production)
        for p in bp:
            e = elo_map.get(p, start)
            exp_i = 1.0 / (1.0 + 10 ** ((r_avg - e) / ELO_SCALE))
            elo_map[p] = e + k_blue * (bw - exp_i)
        for p in rp:
            e = elo_map.get(p, start)
            exp_i = 1.0 / (1.0 + 10 ** ((b_avg - e) / ELO_SCALE))
            elo_map[p] = e + k_red * ((1 - bw) - exp_i)

        # Append residuals AFTER recording so this game's residual lands in the
        # NEXT game's surprise window
        residuals[b_team].append(bw - pred)
        residuals[r_team].append((1 - bw) - (1 - pred))

        out.append({
            'date':     g.date,
            'year':     year,
            'league':   league,
            'blue_win': bw,
            'pred':     pred,
            's_blue':   s_blue,
            's_red':    s_red,
            'k_blue':   k_blue,
            'k_red':    k_red,
        })

    return pd.DataFrame(out)


def metrics(df: pd.DataFrame) -> tuple[float, float]:
    p = np.clip(df['pred'].values, 1e-6, 1 - 1e-6)
    y = df['blue_win'].values
    ll = -(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()
    br = ((p - y) ** 2).mean()
    return ll, br


def main():
    print(f'Loading {GAMES_CSV.name}...')
    df = pd.read_csv(GAMES_CSV, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)
    print(f'  {len(df):,} games')

    # Sweep λ and N
    sweeps = []
    for N in [10, 5]:
        for lam in [0.0, 0.5, 1.0, 1.5, 2.0, 3.0]:
            res = run_one(df, N=N, lam=lam)
            oos = res[res['year'] > WARMUP_YEAR]
            ll_oos, br_oos = metrics(oos)
            sweeps.append({'N': N, 'lambda': lam, 'OOS LL': ll_oos, 'OOS Brier': br_oos,
                           'games': len(oos)})
            print(f'  N={N}  λ={lam:.1f}  →  LL {ll_oos:.4f}   Brier {br_oos:.4f}')

    # Pretty-print baseline diffs
    print('\n=== Summary (vs λ=0, i.e. fixed K baseline) ===')
    grid = pd.DataFrame(sweeps)
    for N in grid['N'].unique():
        sub = grid[grid['N'] == N].sort_values('lambda')
        base_ll = sub[sub['lambda'] == 0.0]['OOS LL'].iloc[0]
        print(f'\n  N={N}-game window')
        for _, row in sub.iterrows():
            diff = (base_ll - row['OOS LL']) / base_ll * 100  # +ve = adaptive better
            sign = '↓' if diff > 0 else '↑'
            print(f'    λ={row["lambda"]:.1f}:  LL {row["OOS LL"]:.4f}   '
                  f'vs fixed-K: {sign} {abs(diff):+.2f}%')

    # By year breakdown for the best config
    print('\n=== Best config by year ===')
    best = grid.sort_values('OOS LL').iloc[0]
    print(f'  Best: N={int(best["N"])}, λ={best["lambda"]}')
    res = run_one(df, N=int(best['N']), lam=float(best['lambda']))
    for y in [2024, 2025, 2026]:
        sub = res[res['year'] == y]
        if len(sub) < 50: continue
        ll, br = metrics(sub)
        print(f'    {y}: LL {ll:.4f}  Brier {br:.4f}  ({len(sub):,} games)')
    # And vs fixed K for the same years
    print('  Fixed K (λ=0) for reference:')
    res_base = run_one(df, N=int(best['N']), lam=0.0)
    for y in [2024, 2025, 2026]:
        sub = res_base[res_base['year'] == y]
        if len(sub) < 50: continue
        ll, br = metrics(sub)
        print(f'    {y}: LL {ll:.4f}  Brier {br:.4f}')


if __name__ == '__main__':
    main()
