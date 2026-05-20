"""
export_champion_findings.py
Computes per-champion outperformance vs model predictions for 2026
and writes web/public/champion_findings.json.
"""

import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
OUT       = ROOT / 'web' / 'public' / 'champion_findings.json'

FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FILL  = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5,
         'playoffs': 0, 'gd15_diff': 0.0, 'outperf_diff': 0.0}

POS_MAP = {
    'top': ('blue_top_champion', 'red_top_champion'),
    'jng': ('blue_jng_champion', 'red_jng_champion'),
    'mid': ('blue_mid_champion', 'red_mid_champion'),
    'bot': ('blue_bot_champion', 'red_bot_champion'),
    'sup': ('blue_sup_champion', 'red_sup_champion'),
}

MIN_GAMES        = 10
MIN_GAMES_MAJOR  = 5
MAJOR_LEAGUES    = {'LCK', 'LEC', 'LCS', 'LPL'}


def _build_records(merged: pd.DataFrame, league_filter: set | None) -> pd.DataFrame:
    if league_filter is not None:
        merged = merged[merged['league'].isin(league_filter)]

    records = []
    for pos, (bc, rc) in POS_MAP.items():
        for _, row in merged.iterrows():
            pred   = row['model_pred']
            result = row['blue_team_result']
            if pd.isna(pred) or pd.isna(result):
                continue
            if pd.notna(row.get(bc)):
                records.append({'champion': row[bc], 'position': pos,
                                'expected': pred, 'won': int(result)})
            if pd.notna(row.get(rc)):
                records.append({'champion': row[rc], 'position': pos,
                                'expected': 1 - pred, 'won': 1 - int(result)})
    return pd.DataFrame(records)


def _aggregate(df: pd.DataFrame, min_games: int) -> dict:
    agg = df.groupby(['champion', 'position']).agg(
        games    = ('won', 'count'),
        actual   = ('won', 'mean'),
        expected = ('expected', 'mean'),
    ).reset_index()
    agg['outperf'] = agg['actual'] - agg['expected']
    agg = agg[agg['games'] >= min_games].copy()

    by_pos: dict = {}
    for pos in POS_MAP:
        sub  = agg[agg['position'] == pos].sort_values('outperf', ascending=False)
        by_pos[pos] = [
            {
                'champion': r['champion'],
                'games':    int(r['games']),
                'actual':   round(float(r['actual']), 4),
                'expected': round(float(r['expected']), 4),
                'outperf':  round(float(r['outperf']), 4),
            }
            for _, r in sub.iterrows()
        ]
    return by_pos


def main():
    print("Loading data…")
    feat = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    gwo  = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False)

    print("Training model on 2024–2025…")
    train = feat[feat['year'].isin([2024, 2025])]
    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(train[FEATS].fillna(FILL), train['blue_win'].values)

    feat26 = feat[feat['year'] == 2026].copy()
    feat26['model_pred'] = model.predict_proba(feat26[FEATS].fillna(FILL))[:, 1]
    print(f"2026 games: {len(feat26)}")

    champ_cols = (
        ['gameid', 'league', 'blue_team_result'] +
        [c for pos in POS_MAP.values() for c in pos]
    )
    gwo26  = gwo[gwo['year'] == 2026][champ_cols].copy()
    merged = feat26[['gameid', 'model_pred']].merge(gwo26, on='gameid', how='inner')

    print("Building all-leagues dataset…")
    df_all   = _build_records(merged, league_filter=None)
    print("Building major-leagues dataset…")
    df_major = _build_records(merged, league_filter=MAJOR_LEAGUES)

    by_position       = _aggregate(df_all,   MIN_GAMES)
    by_position_major = _aggregate(df_major, MIN_GAMES_MAJOR)

    for pos in POS_MAP:
        print(f"  {pos}: {len(by_position[pos])} all / {len(by_position_major[pos])} major")

    out = {
        'generated':          datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'year':               2026,
        'min_games':          MIN_GAMES,
        'min_games_major':    MIN_GAMES_MAJOR,
        'by_position':        by_position,
        'by_position_major':  by_position_major,
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f"Wrote {OUT}")


if __name__ == '__main__':
    main()
