"""Side-by-side backtest: ELO (production-style) vs Glicko-2 as pure
win-probability predictors.

Walks games_with_odds.csv chronologically, maintains both rating systems'
state per player, and at each game produces a prediction with each system
BEFORE updating it. Reports log loss + Brier per league, per year, and
overall on a 2024+ out-of-sample window (earlier games "warm up" the
ratings).

The point isn't to beat the production model — that adds many features
on top of ELO via logistic regression. This is a head-to-head comparison
of the underlying rating systems' raw predictive power.

Usage:
  python src/backtest_glicko2.py
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd

from feature_engineering import (
    POSITIONS, _starting_elo, K_FACTOR, ELO_SCALE, SERIES_K_ALPHA,
)
import glicko2 as g2

ROOT = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
GAMES_CSV = PROCESSED / 'games_with_odds.csv'

# Skip results from this year and earlier when computing metrics — they're
# the warm-up window so the ratings have something to work with.
WARMUP_THROUGH_YEAR = 2023


# ── ELO predictor + updater (matches feature_engineering._update_players) ──

def elo_predict_update(blue_players, red_players, elo_map, league, year, blue_win):
    start = _starting_elo(league)
    blue_elos = [elo_map.get(p, start) for p in blue_players]
    red_elos  = [elo_map.get(p, start) for p in red_players]
    blue_avg = sum(blue_elos) / 5
    red_avg  = sum(red_elos)  / 5
    # Team-vs-team prediction (matches what the LR model uses as the elo_diff feature)
    pred = 1.0 / (1.0 + 10 ** ((red_avg - blue_avg) / ELO_SCALE))
    k_scale = SERIES_K_ALPHA if year >= 2025 else 1.0
    # Per-player update using individual vs opposing team avg (matches prod)
    for p, e in zip(blue_players, blue_elos):
        exp_i = 1.0 / (1.0 + 10 ** ((red_avg - e) / ELO_SCALE))
        elo_map[p] = e + K_FACTOR * k_scale * (blue_win - exp_i)
    for p, e in zip(red_players, red_elos):
        exp_i = 1.0 / (1.0 + 10 ** ((blue_avg - e) / ELO_SCALE))
        elo_map[p] = e + K_FACTOR * k_scale * ((1 - blue_win) - exp_i)
    return pred


# ── Glicko-2 predictor + updater ───────────────────────────────────────────

def glicko_get(p: str, league: str, gmap: dict) -> tuple[float, float, float]:
    if p in gmap: return gmap[p]
    return (_starting_elo(league), g2.DEFAULT_RD, g2.DEFAULT_SIGMA)


def glicko_predict_update(blue_players, red_players, gmap, league, blue_win):
    blue_state = [glicko_get(p, league, gmap) for p in blue_players]
    red_state  = [glicko_get(p, league, gmap) for p in red_players]
    blue_r_avg = sum(s[0] for s in blue_state) / 5
    red_r_avg  = sum(s[0] for s in red_state)  / 5
    # Pooled team RD (sqrt of avg variance — independent players approx)
    blue_rd_avg = math.sqrt(sum(s[1] ** 2 for s in blue_state) / 5)
    red_rd_avg  = math.sqrt(sum(s[1] ** 2 for s in red_state)  / 5)

    # Prediction: team blue beating team red, with combined uncertainty
    mu_b, phi_b = g2.to_g2(blue_r_avg, blue_rd_avg)
    mu_r, phi_r = g2.to_g2(red_r_avg,  red_rd_avg)
    combined_phi = math.sqrt(phi_b ** 2 + phi_r ** 2)
    pred = g2.E(mu_b, mu_r, combined_phi)

    # Update each player against the opposing team's avg (matches Elo logic)
    for p, (r, rd, sigma) in zip(blue_players, blue_state):
        gmap[p] = g2.update(r, rd, sigma, [(red_r_avg, red_rd_avg, float(blue_win))])
    for p, (r, rd, sigma) in zip(red_players, red_state):
        gmap[p] = g2.update(r, rd, sigma, [(blue_r_avg, blue_rd_avg, float(1 - blue_win))])
    return pred


# ── Metrics ────────────────────────────────────────────────────────────────

def metrics(df: pd.DataFrame, label: str) -> None:
    if len(df) == 0:
        print(f'\n--- {label}: 0 games ---'); return
    y = df['blue_win'].values
    el = np.clip(df['elo_pred'].values, 1e-6, 1 - 1e-6)
    gl = np.clip(df['glicko_pred'].values, 1e-6, 1 - 1e-6)
    elo_ll = -(y * np.log(el) + (1 - y) * np.log(1 - el)).mean()
    glk_ll = -(y * np.log(gl) + (1 - y) * np.log(1 - gl)).mean()
    elo_br = ((el - y) ** 2).mean()
    glk_br = ((gl - y) ** 2).mean()
    delta_ll = (elo_ll - glk_ll) / elo_ll * 100   # +ve = Glicko better
    delta_br = (elo_br - glk_br) / elo_br * 100
    arrow_ll = '↓' if delta_ll > 0 else '↑'
    print(f'\n=== {label} ({len(df):,} games) ===')
    print(f'  ELO     LL: {elo_ll:.4f}   Brier: {elo_br:.4f}')
    print(f'  Glicko2 LL: {glk_ll:.4f}   Brier: {glk_br:.4f}')
    print(f'  Glicko2 vs ELO: LL {arrow_ll} {abs(delta_ll):+.2f}%   Brier {abs(delta_br):+.2f}%')


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    print(f'Loading {GAMES_CSV.name}...')
    df = pd.read_csv(GAMES_CSV, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df = df.sort_values('date').reset_index(drop=True)
    print(f'  {len(df):,} games, {df.year.min()}-{df.year.max()}')

    elo_map: dict[str, float] = {}
    glicko_map: dict[str, tuple[float, float, float]] = {}
    rows: list[dict] = []

    for g_row in df.itertuples(index=False):
        bp = [getattr(g_row, f'blue_{p}_playername') for p in POSITIONS]
        rp = [getattr(g_row, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bp + rp): continue
        bw = g_row.blue_team_result
        if pd.isna(bw): continue
        bw = int(bw)
        league = str(g_row.league)
        year   = int(g_row.year)

        elo_pred = elo_predict_update(bp, rp, elo_map, league, year, bw)
        glk_pred = glicko_predict_update(bp, rp, glicko_map, league, bw)

        rows.append({
            'date':        g_row.date,
            'year':        year,
            'league':      league,
            'blue_win':    bw,
            'elo_pred':    elo_pred,
            'glicko_pred': glk_pred,
        })

    out = pd.DataFrame(rows)
    out_path = PROCESSED / 'glicko_backtest.csv'
    out.to_csv(out_path, index=False)
    print(f'\nWrote {out_path.name} ({len(out):,} rows)')

    # OOS = year > warmup
    oos = out[out['year'] > WARMUP_THROUGH_YEAR]
    print(f'\n=== Warmup: {len(out) - len(oos):,} games (≤{WARMUP_THROUGH_YEAR})  '
          f'OOS: {len(oos):,} games (>{WARMUP_THROUGH_YEAR}) ===')

    metrics(oos, 'OOS overall')

    # By year
    for y in sorted(oos.year.unique()):
        metrics(oos[oos.year == y], f'OOS {y}')

    # By major league
    print('\n=== By major league (all OOS years) ===')
    for lg in ['LCK', 'LPL', 'LEC', 'LCS']:
        sub = oos[oos.league == lg]
        if len(sub) < 100: continue
        metrics(sub, f'OOS {lg}')

    # By tier-2 / others
    minor = oos[~oos.league.isin(['LCK','LPL','LEC','LCS'])]
    if len(minor) > 100:
        metrics(minor, 'OOS non-major')

    # Rating spread snapshot at end of run
    if glicko_map:
        rds = [v[1] for v in glicko_map.values()]
        rs  = [v[0] for v in glicko_map.values()]
        print(f'\nGlicko-2 final state across {len(glicko_map)} players:')
        print(f'  rating:   median {np.median(rs):.0f}  p10 {np.percentile(rs,10):.0f}  p90 {np.percentile(rs,90):.0f}')
        print(f'  RD:       median {np.median(rds):.1f}  p10 {np.percentile(rds,10):.1f}  p90 {np.percentile(rds,90):.1f}')


if __name__ == '__main__':
    main()
