"""Proper grid search for the adaptive K hyperparameters before integration:
  N            window length (games)
  λ            K multiplier sensitivity
  SCALE        surprise-score denominator

Reports the top configs by OOS log loss (2024-2026 stitched together as
warmup + eval). For the picked config we then split by year so we can see
whether the win is uniform or year-specific.

Run after compare_adaptive_k.py confirmed the mechanism works qualitatively.
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


def run_pass(games_records: list[tuple], N: int, lam: float, scale: float,
             min_obs: int = 3) -> list[dict]:
    """Walk parsed games once. games_records is a list of pre-extracted tuples
    to avoid pandas getattr overhead inside the loop."""
    elo_map: dict[str, float] = {}
    residuals: dict[str, deque] = defaultdict(lambda: deque(maxlen=N))
    out = []

    for rec in games_records:
        (year, league, bp, rp, b_team, r_team, bw) = rec

        start = _starting_elo(league)
        b_avg = (elo_map.get(bp[0], start) + elo_map.get(bp[1], start) + elo_map.get(bp[2], start)
                 + elo_map.get(bp[3], start) + elo_map.get(bp[4], start)) / 5
        r_avg = (elo_map.get(rp[0], start) + elo_map.get(rp[1], start) + elo_map.get(rp[2], start)
                 + elo_map.get(rp[3], start) + elo_map.get(rp[4], start)) / 5
        pred  = 1.0 / (1.0 + 10 ** ((r_avg - b_avg) / ELO_SCALE))

        # Pre-game surprise
        b_xs = residuals[b_team]
        r_xs = residuals[r_team]
        s_blue = abs(sum(b_xs) / len(b_xs)) if len(b_xs) >= min_obs else 0.0
        s_red  = abs(sum(r_xs) / len(r_xs)) if len(r_xs) >= min_obs else 0.0

        k_eff  = K_FACTOR * (SERIES_K_ALPHA if year >= 2025 else 1.0)
        k_blue = k_eff * (1.0 + lam * (s_blue / scale))
        k_red  = k_eff * (1.0 + lam * (s_red  / scale))

        for p in bp:
            e = elo_map.get(p, start)
            exp_i = 1.0 / (1.0 + 10 ** ((r_avg - e) / ELO_SCALE))
            elo_map[p] = e + k_blue * (bw - exp_i)
        for p in rp:
            e = elo_map.get(p, start)
            exp_i = 1.0 / (1.0 + 10 ** ((b_avg - e) / ELO_SCALE))
            elo_map[p] = e + k_red * ((1 - bw) - exp_i)

        residuals[b_team].append(bw - pred)
        residuals[r_team].append((1 - bw) - (1 - pred))

        out.append((year, bw, pred))

    return out


def ll_brier(arr: list[tuple]) -> tuple[float, float]:
    y  = np.array([r[1] for r in arr])
    p  = np.clip(np.array([r[2] for r in arr]), 1e-6, 1 - 1e-6)
    ll = -(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()
    br = ((p - y) ** 2).mean()
    return ll, br


def main():
    print(f'Loading {GAMES_CSV.name}...')
    df = pd.read_csv(GAMES_CSV, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)

    # Pre-extract tuples to skip pandas overhead inside the hot loop
    print('Pre-parsing rows...')
    recs = []
    for g in df.itertuples(index=False):
        bp = [getattr(g, f'blue_{p}_playername') for p in POSITIONS]
        rp = [getattr(g, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp): continue
        bw = g.blue_team_result
        if pd.isna(bw): continue
        recs.append((int(g.year), str(g.league), bp, rp,
                     str(g.blue_team_teamname), str(g.red_team_teamname), int(bw)))
    print(f'  {len(recs):,} valid games')

    # Grid
    N_GRID     = [5, 8, 10, 12, 15, 20]
    LAM_GRID   = [0.0, 0.25, 0.5, 0.75, 1.0, 1.25]
    SCALE_GRID = [0.06, 0.10, 0.15, 0.20]

    results = []
    total = len(N_GRID) * len(LAM_GRID) * len(SCALE_GRID)
    print(f'\nSweeping {total} configs...')
    for N in N_GRID:
        for lam in LAM_GRID:
            for scale in SCALE_GRID:
                out = run_pass(recs, N=N, lam=lam, scale=scale)
                oos = [r for r in out if r[0] > WARMUP_YEAR]
                ll, br = ll_brier(oos)
                results.append({'N': N, 'lambda': lam, 'scale': scale,
                                'OOS_LL': ll, 'OOS_Brier': br, 'games': len(oos)})

    grid = pd.DataFrame(results).sort_values('OOS_LL').reset_index(drop=True)

    # Reference: fixed-K (any λ=0 entry — they're identical regardless of N/scale)
    base = grid[grid['lambda'] == 0.0]['OOS_LL'].iloc[0]
    grid['Δ%'] = (base - grid['OOS_LL']) / base * 100

    print(f'\nFixed-K baseline OOS LL: {base:.4f}\n')
    print('=== Top 10 configs ===')
    print(grid.head(10).to_string(index=False, float_format=lambda x: f'{x:.4f}'))

    print('\n=== Worst 5 configs (sanity) ===')
    print(grid.tail(5).to_string(index=False, float_format=lambda x: f'{x:.4f}'))

    # Year breakdown for best config
    best = grid.iloc[0]
    print(f'\n=== Best config: N={int(best["N"])}, λ={best["lambda"]}, scale={best["scale"]} ===')
    print(f'  OOS LL: {best["OOS_LL"]:.4f}  (+{best["Δ%"]:.2f}% vs fixed K)')
    out_best  = run_pass(recs, N=int(best['N']), lam=best['lambda'], scale=best['scale'])
    out_fixed = run_pass(recs, N=int(best['N']), lam=0.0,            scale=best['scale'])
    print(f'  By year:')
    for y in [2024, 2025, 2026]:
        sub_best  = [r for r in out_best  if r[0] == y]
        sub_fixed = [r for r in out_fixed if r[0] == y]
        if len(sub_best) < 50: continue
        ll_a, _ = ll_brier(sub_best)
        ll_b, _ = ll_brier(sub_fixed)
        diff = (ll_b - ll_a) / ll_b * 100
        sign = '↓' if diff > 0 else '↑'
        print(f'    {y}: adaptive {ll_a:.4f}   fixed {ll_b:.4f}   {sign} {abs(diff):+.2f}%  ({len(sub_best):,} games)')


if __name__ == '__main__':
    main()
