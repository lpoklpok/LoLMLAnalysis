"""
export_gold_lead.py
Exports gold-lead win rates to web/public/gold_lead.json.

Usage:
    python src/export_gold_lead.py
"""

import json
import pandas as pd
from datetime import datetime, timezone
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
OUT       = ROOT / 'web' / 'public' / 'gold_lead.json'

MAJOR_LEAGUES = {'LCK', 'LEC', 'LCS', 'LPL'}
GOLD_STEP     = 500
GOLD_EDGES    = list(range(0, 10001, 500))  # 0, 500, 1000, ..., 10000 then 10000+


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
            'bucket':   _bucket_label(lo, hi),
            'gold_lo':  lo,
            'gold_hi':  hi,
            'n':        int(n),
            'win_rate': round(float(leading_wins.mean()), 4),
        })
    return rows


def prob_x_gold_wr(df: pd.DataFrame, diff_col: str) -> list[dict]:
    """
    Win rate of the gold-leading team, split by that team's pre-game implied
    probability (10% buckets) and their gold lead magnitude (500g buckets).
    Uses the leading team's prob regardless of side.
    """
    cols = [diff_col, 'blue_team_result', 'implied_prob1_vigfree', 'implied_prob2_vigfree', 'blue_is_odds_team1']
    sub = df[cols].dropna()
    sub = sub[sub[diff_col] != 0].copy()

    # blue team's correct pre-game probability (team1/team2 don't always match blue/red)
    sub['blue_prob'] = sub.apply(
        lambda r: r['implied_prob1_vigfree'] if r['blue_is_odds_team1'] else r['implied_prob2_vigfree'],
        axis=1,
    )

    # leading_team_prob: pre-game prob of whichever team has the gold lead
    sub['leading_prob'] = sub.apply(
        lambda r: r['blue_prob'] if r[diff_col] > 0 else 1 - r['blue_prob'],
        axis=1,
    )
    sub['leading_wins'] = (
        ((sub[diff_col] > 0) & (sub['blue_team_result'] == 1)) |
        ((sub[diff_col] < 0) & (sub['blue_team_result'] == 0))
    )

    prob_edges = [i / 10 for i in range(11)]
    result_rows = []

    for j in range(len(prob_edges) - 1):
        p_lo, p_hi = prob_edges[j], prob_edges[j + 1]
        pchunk = sub[(sub['leading_prob'] >= p_lo) & (sub['leading_prob'] < p_hi)]
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
            gold_rows.append({
                'bucket':   _bucket_label(lo, hi),
                'gold_lo':  lo,
                'gold_hi':  hi,
                'n':        int(n),
                'win_rate': round(float(gchunk['leading_wins'].mean()), 4),
            })

        result_rows.append({
            'prob_bucket': f'{int(p_lo * 100)}–{int(p_hi * 100)}%',
            'prob_lo':     p_lo,
            'prob_hi':     p_hi,
            'n':           int(len(pchunk)),
            'overall_wr':  round(float(pchunk['leading_wins'].mean()), 4),
            'gold_buckets': gold_rows,
        })

    return result_rows


def compute_set(df: pd.DataFrame, times: dict) -> dict:
    return {
        'gold_lead':   {t: gold_lead_wr(df, col)     for t, col in times.items()},
        'prob_x_gold': {t: prob_x_gold_wr(df, col)   for t, col in times.items()},
    }


def main():
    print('Loading games_with_odds…')
    df = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False)
    df2026  = df[df['year'] == 2026].copy()
    df_major = df2026[df2026['league'].isin(MAJOR_LEAGUES)].copy()
    print(f'  2026 all: {len(df2026)},  major: {len(df_major)}')

    times = {
        '10': 'blue_team_golddiffat10',
        '15': 'blue_team_golddiffat15',
        '20': 'blue_team_golddiffat20',
    }

    print('Computing all-leagues…')
    data_all   = compute_set(df2026,  times)
    print('Computing major-leagues…')
    data_major = compute_set(df_major, times)

    out = {
        'generated':        datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'year':             2026,
        'gold_step':        GOLD_STEP,
        'gold_lead':        {'all': data_all['gold_lead'],   'major': data_major['gold_lead']},
        'prob_x_gold':      {'all': data_all['prob_x_gold'], 'major': data_major['prob_x_gold']},
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    size_kb = OUT.stat().st_size // 1024
    print(f'Wrote {OUT} ({size_kb} KB)')


if __name__ == '__main__':
    main()
