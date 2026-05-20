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

MIN_GAMES           = 10
MIN_GAMES_MAJOR     = 5
MIN_MATCHUP         = 5
MIN_MATCHUP_MAJOR   = 3
MIN_SYNERGY         = 8
MIN_SYNERGY_MAJOR   = 5
MAJOR_LEAGUES       = {'LCK', 'LEC', 'LCS', 'LPL'}


def _filter(merged: pd.DataFrame, league_filter: set | None) -> pd.DataFrame:
    if league_filter is not None:
        return merged[merged['league'].isin(league_filter)].copy()
    return merged


def _build_individual_records(merged: pd.DataFrame) -> pd.DataFrame:
    records = []
    for pos, (bc, rc) in POS_MAP.items():
        for _, row in merged.iterrows():
            pred = row['model_pred']; result = row['blue_team_result']
            if pd.isna(pred) or pd.isna(result): continue
            if pd.notna(row.get(bc)):
                records.append({'champion': row[bc], 'position': pos, 'expected': pred, 'won': int(result)})
            if pd.notna(row.get(rc)):
                records.append({'champion': row[rc], 'position': pos, 'expected': 1 - pred, 'won': 1 - int(result)})
    return pd.DataFrame(records)


def _aggregate_individual(df: pd.DataFrame, min_games: int) -> dict:
    agg = df.groupby(['champion', 'position']).agg(
        games=('won', 'count'), actual=('won', 'mean'), expected=('expected', 'mean')
    ).reset_index()
    agg['outperf'] = agg['actual'] - agg['expected']
    agg = agg[agg['games'] >= min_games]
    by_pos: dict = {}
    for pos in POS_MAP:
        sub = agg[agg['position'] == pos].sort_values('outperf', ascending=False)
        by_pos[pos] = [
            {'champion': r['champion'], 'games': int(r['games']),
             'actual': round(float(r['actual']), 4), 'expected': round(float(r['expected']), 4),
             'outperf': round(float(r['outperf']), 4)}
            for _, r in sub.iterrows()
        ]
    return by_pos


def _build_matchup_records(merged: pd.DataFrame) -> pd.DataFrame:
    """One row per (champ, opponent, position) — champ is always on blue side perspective."""
    records = []
    for pos, (bc, rc) in POS_MAP.items():
        for _, row in merged.iterrows():
            pred = row['model_pred']; result = row['blue_team_result']
            if pd.isna(pred) or pd.isna(result): continue
            bc_val = row.get(bc); rc_val = row.get(rc)
            if pd.isna(bc_val) or pd.isna(rc_val): continue
            # canonical pair: sort alphabetically so (A,B) == (B,A)
            if bc_val <= rc_val:
                champ, opp, exp, won = bc_val, rc_val, pred, int(result)
            else:
                champ, opp, exp, won = rc_val, bc_val, 1 - pred, 1 - int(result)
            records.append({'champ': champ, 'opp': opp, 'position': pos, 'expected': exp, 'won': won})
    return pd.DataFrame(records)


def _aggregate_matchups(df: pd.DataFrame, min_games: int) -> dict:
    agg = df.groupby(['champ', 'opp', 'position']).agg(
        games=('won', 'count'), actual=('won', 'mean'), expected=('expected', 'mean')
    ).reset_index()
    agg['outperf'] = agg['actual'] - agg['expected']
    agg = agg[agg['games'] >= min_games]
    by_pos: dict = {}
    for pos in POS_MAP:
        sub = agg[agg['position'] == pos].sort_values('outperf', ascending=False)
        by_pos[pos] = [
            {'champ': r['champ'], 'opp': r['opp'], 'games': int(r['games']),
             'actual': round(float(r['actual']), 4), 'expected': round(float(r['expected']), 4),
             'outperf': round(float(r['outperf']), 4)}
            for _, r in sub.iterrows()
        ]
    return by_pos


def _build_synergy_records(merged: pd.DataFrame) -> pd.DataFrame:
    """One row per same-team champion pair per game."""
    positions = list(POS_MAP.keys())
    records = []
    for _, row in merged.iterrows():
        pred = row['model_pred']; result = row['blue_team_result']
        if pd.isna(pred) or pd.isna(result): continue
        for side, exp, won in [('blue', pred, int(result)), ('red', 1 - pred, 1 - int(result))]:
            champs = [row.get(f'{side}_{pos}_champion') for pos in positions]
            champs = [c for c in champs if pd.notna(c)]
            for i in range(len(champs)):
                for j in range(i + 1, len(champs)):
                    a, b = (champs[i], champs[j]) if champs[i] <= champs[j] else (champs[j], champs[i])
                    records.append({'champA': a, 'champB': b, 'expected': exp, 'won': won})
    return pd.DataFrame(records)


def _aggregate_synergies(df: pd.DataFrame, min_games: int) -> list:
    agg = df.groupby(['champA', 'champB']).agg(
        games=('won', 'count'), actual=('won', 'mean'), expected=('expected', 'mean')
    ).reset_index()
    agg['outperf'] = agg['actual'] - agg['expected']
    agg = agg[agg['games'] >= min_games].sort_values('outperf', ascending=False)
    return [
        {'champA': r['champA'], 'champB': r['champB'], 'games': int(r['games']),
         'actual': round(float(r['actual']), 4), 'expected': round(float(r['expected']), 4),
         'outperf': round(float(r['outperf']), 4)}
        for _, r in agg.iterrows()
    ]


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

    m_all   = _filter(merged, None)
    m_major = _filter(merged, MAJOR_LEAGUES)

    print("Individual champion performance…")
    by_position       = _aggregate_individual(_build_individual_records(m_all),   MIN_GAMES)
    by_position_major = _aggregate_individual(_build_individual_records(m_major), MIN_GAMES_MAJOR)

    print("Matchup deltas…")
    matchups       = _aggregate_matchups(_build_matchup_records(m_all),   MIN_MATCHUP)
    matchups_major = _aggregate_matchups(_build_matchup_records(m_major), MIN_MATCHUP_MAJOR)

    print("Synergy deltas…")
    synergies       = _aggregate_synergies(_build_synergy_records(m_all),   MIN_SYNERGY)
    synergies_major = _aggregate_synergies(_build_synergy_records(m_major), MIN_SYNERGY_MAJOR)

    print(f"  synergies: {len(synergies)} all / {len(synergies_major)} major")
    for pos in POS_MAP:
        print(f"  {pos}: {len(by_position[pos])} champs, {len(matchups[pos])} matchups all "
              f"/ {len(by_position_major[pos])} champs, {len(matchups_major[pos])} matchups major")

    out = {
        'generated':          datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'year':               2026,
        'min_games':          MIN_GAMES,
        'min_games_major':    MIN_GAMES_MAJOR,
        'by_position':        by_position,
        'by_position_major':  by_position_major,
        'matchups':           matchups,
        'matchups_major':     matchups_major,
        'synergies':          synergies,
        'synergies_major':    synergies_major,
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f"Wrote {OUT}")


if __name__ == '__main__':
    main()
