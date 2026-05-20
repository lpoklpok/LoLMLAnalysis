"""
export_gold_lead.py
Exports gold-lead win rates to web/public/gold_lead.json.

Usage:
    python src/export_gold_lead.py
"""

import json
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
OUT       = ROOT / 'web' / 'public' / 'gold_lead.json'

GOLD_STEP = 500
GOLD_EDGES = [0, 500, 1000, 1500, 2000, 2500]  # last bucket is 2500+


def _bucket_label(lo: int, hi: int | None) -> str:
    return f'{lo:,}+' if hi is None else f'{lo:,}–{hi:,}'


def gold_lead_wr(df: pd.DataFrame, diff_col: str) -> list[dict]:
    """Win rate of the gold-leading team, bucketed by lead magnitude."""
    sub = df[[diff_col, 'blue_team_result']].dropna()
    sub = sub[sub[diff_col] != 0]

    rows = []
    for i, lo in enumerate(GOLD_EDGES):
        hi = GOLD_EDGES[i + 1] if i + 1 < len(GOLD_EDGES) else None
        if hi is None:
            mask = sub[diff_col].abs() >= lo
        else:
            mask = (sub[diff_col].abs() >= lo) & (sub[diff_col].abs() < hi)
        chunk = sub[mask]
        n = len(chunk)
        if n == 0:
            continue
        leading_wins = (
            ((chunk[diff_col] > 0) & (chunk['blue_team_result'] == 1)) |
            ((chunk[diff_col] < 0) & (chunk['blue_team_result'] == 0))
        )
        rows.append({
            'bucket': _bucket_label(lo, hi),
            'gold_lo': lo,
            'gold_hi': hi,
            'n': int(n),
            'win_rate': round(float(leading_wins.mean()), 4),
        })
    return rows


def prob_x_gold_wr(df: pd.DataFrame, diff_col: str) -> list[dict]:
    """
    For each 10%-wide pre-game prob bucket (blue team),
    win rate of the gold-leading team in each 500g gold-lead bucket.
    Only uses games that have odds data.
    """
    sub = df[[diff_col, 'blue_team_result', 'implied_prob1_vigfree']].dropna()
    sub = sub[sub[diff_col] != 0]

    prob_edges = [i / 10 for i in range(11)]
    result_rows = []

    for j in range(len(prob_edges) - 1):
        p_lo, p_hi = prob_edges[j], prob_edges[j + 1]
        pchunk = sub[(sub['implied_prob1_vigfree'] >= p_lo) & (sub['implied_prob1_vigfree'] < p_hi)]
        if len(pchunk) < 3:
            continue

        gold_rows = []
        for i, lo in enumerate(GOLD_EDGES):
            hi = GOLD_EDGES[i + 1] if i + 1 < len(GOLD_EDGES) else None
            if hi is None:
                mask = pchunk[diff_col].abs() >= lo
            else:
                mask = (pchunk[diff_col].abs() >= lo) & (pchunk[diff_col].abs() < hi)
            gchunk = pchunk[mask]
            n = len(gchunk)
            if n == 0:
                continue
            leading_wins = (
                ((gchunk[diff_col] > 0) & (gchunk['blue_team_result'] == 1)) |
                ((gchunk[diff_col] < 0) & (gchunk['blue_team_result'] == 0))
            )
            gold_rows.append({
                'bucket': _bucket_label(lo, hi),
                'gold_lo': lo,
                'gold_hi': hi,
                'n': int(n),
                'win_rate': round(float(leading_wins.mean()), 4),
            })

        # Overall (any lead)
        any_lead = pchunk[pchunk[diff_col] != 0]
        n_total = len(pchunk)
        leading_wins_all = (
            ((any_lead[diff_col] > 0) & (any_lead['blue_team_result'] == 1)) |
            ((any_lead[diff_col] < 0) & (any_lead['blue_team_result'] == 0))
        )
        result_rows.append({
            'prob_bucket': f'{int(p_lo * 100)}–{int(p_hi * 100)}%',
            'prob_lo': p_lo,
            'prob_hi': p_hi,
            'n': int(n_total),
            'overall_wr': round(float(leading_wins_all.mean()) if len(any_lead) > 0 else 0.0, 4),
            'gold_buckets': gold_rows,
        })

    return result_rows


def main():
    print('Loading games_with_odds…')
    df = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False)
    df2026 = df[df['year'] == 2026].copy()
    print(f'  2026 rows: {len(df2026)}, with odds: {df2026["implied_prob1_vigfree"].notna().sum()}')

    times = {
        '10': 'blue_team_golddiffat10',
        '15': 'blue_team_golddiffat15',
        '20': 'blue_team_golddiffat20',
    }

    print('Computing gold-lead win rates…')
    gold_lead: dict = {}
    for t, col in times.items():
        gold_lead[t] = gold_lead_wr(df2026, col)
        total = sum(r['n'] for r in gold_lead[t])
        print(f'  @{t}: {total} games')

    print('Computing pre-game prob × gold matrices…')
    prob_x_gold: dict = {}
    for t, col in times.items():
        prob_x_gold[t] = prob_x_gold_wr(df2026, col)
        total = sum(r['n'] for r in prob_x_gold[t])
        print(f'  @{t}: {total} games with odds, {len(prob_x_gold[t])} prob buckets')

    out = {
        'generated':   datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'year':        2026,
        'gold_step':   GOLD_STEP,
        'gold_lead':   gold_lead,
        'prob_x_gold': prob_x_gold,
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    size_kb = OUT.stat().st_size // 1024
    print(f'Wrote {OUT} ({size_kb} KB)')


if __name__ == '__main__':
    main()
