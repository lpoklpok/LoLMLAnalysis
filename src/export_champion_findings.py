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

ALPHA_G2 = 0.8970
BETA_DA  = 0.0929

TEAM_PO_ADJ = {
    'G2 Esports':          0.4172,
    'FunPlus Phoenix':     0.3159,
    'Bilibili Gaming':     0.2242,
    'T1':                  0.2068,
    'KT Rolster':          0.1991,
    'Weibo Gaming':        0.1234,
    'BNK FEARX':           0.1069,
    "Anyone's Legend":     0.0801,
    'Team BDS':            0.0612,
    'Karmine Corp':        0.0416,
    'Hanwha Life Esports': -0.0616,
    'Team WE':             -0.0757,
    'Top Esports':         -0.0927,
    'Dplus Kia':           -0.0968,
    'JD Gaming':           -0.1238,
    'Invictus Gaming':     -0.1406,
    'Gen.G':               -0.1510,
    'Movistar KOI':        -0.1518,
    'Team Heretics':       -0.3450,
    'ThunderTalk Gaming':  -0.3521,
    'Ninjas in Pyjamas':   -0.3548,
    'EDward Gaming':       -0.3743,
    'Team Vitality':       -0.4237,
    'Fnatic':              -0.4427,
    'GiantX':              -0.4491,
    'Nongshim RedForce':   -0.6670,
}

COACHING_ADJ = {
    'Karmine Corp': (2026, 0.3695),
}


def compute_model_preds(df: pd.DataFrame) -> pd.DataFrame:
    """Train on 2024-2025, apply with G2/playoff/coaching adjustments. Matches upload_game_features.py."""
    df = df.copy()
    df['date'] = pd.to_datetime(df['date'], utc=True)
    df['_date_day'] = df['date'].dt.date
    df['_team_key'] = df.apply(
        lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1
    )
    df = df.sort_values(['_date_day', 'league', '_team_key', 'game']).reset_index(drop=True)
    shifted = df.groupby(['_date_day', 'league', '_team_key'])['blue_win'].shift(1)
    df['draft_advantage'] = shifted.map(
        lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)
    ).astype(int)

    train = df[df['year'].isin([2024, 2025])]
    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(train[FEATS].fillna(FILL), train['blue_win'].values)

    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(df[FEATS].fillna(FILL))
    logodds = X_sc @ lr.coef_.ravel() + lr.intercept_[0]
    logodds_adj = logodds.copy()

    g2_mask = ((df['game'] == 2) & (df['year'] >= 2025)).values
    logodds_adj[g2_mask] = (ALPHA_G2 * logodds[g2_mask]
                            + BETA_DA * df['draft_advantage'].values[g2_mask])

    po_mask = df['playoffs'].values == 1
    if po_mask.any():
        blue_po = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['blue_team']])
        red_po  = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['red_team']])
        logodds_adj[po_mask] += (blue_po - red_po)[po_mask]

    years = df['year'].values
    for team, (from_year, bonus) in COACHING_ADJ.items():
        active = years >= from_year
        logodds_adj[(df['blue_team'].values == team) & active] += bonus
        logodds_adj[(df['red_team'].values  == team) & active] -= bonus

    df['model_pred'] = 1 / (1 + np.exp(-logodds_adj))
    return df

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
MIN_FIRSTPICK       = 10
MIN_FIRSTPICK_MAJOR = 5
MIN_FLEX            = 20
MIN_FLEX_MAJOR      = 10
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
    return pd.DataFrame(records, columns=['champion', 'position', 'expected', 'won'])


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
    return pd.DataFrame(records, columns=['champ', 'opp', 'position', 'expected', 'won'])


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
    return pd.DataFrame(records, columns=['champA', 'champB', 'expected', 'won'])


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


def _aggregate_flex(merged: pd.DataFrame, min_games: int) -> list:
    """Per-champion role distribution and flex percentage.
    flex_pct = 1 - (games in most-common role / total games played)."""
    records = []
    for pos in POS_MAP:
        for side_col in (f'blue_{pos}_champion', f'red_{pos}_champion'):
            sub = merged[[side_col]].rename(columns={side_col: 'champion'})
            sub = sub.dropna(subset=['champion'])
            sub['position'] = pos
            records.append(sub)
    rdf = pd.concat(records, ignore_index=True)
    if rdf.empty:
        return []
    role_cols = list(POS_MAP.keys())
    pivot = rdf.groupby(['champion', 'position']).size().unstack(fill_value=0)
    for rc in role_cols:
        if rc not in pivot.columns:
            pivot[rc] = 0
    pivot = pivot[role_cols]
    pivot['total'] = pivot[role_cols].sum(axis=1)
    pivot = pivot[pivot['total'] >= min_games].copy()
    pivot['primary_share'] = pivot[role_cols].max(axis=1) / pivot['total']
    pivot['flex_pct']      = 1 - pivot['primary_share']
    pivot['primary_role']  = pivot[role_cols].idxmax(axis=1)
    pivot = pivot.sort_values(['flex_pct', 'total'], ascending=[False, False])
    out = []
    for champ, r in pivot.iterrows():
        total = int(r['total'])
        out.append({
            'champion': champ,
            'games':    total,
            'primary_role': r['primary_role'],
            'flex_pct':     round(float(r['flex_pct']), 4),
            'roles': {rc: int(r[rc]) for rc in role_cols},
        })
    return out


def _build_firstpick_records(merged: pd.DataFrame) -> pd.DataFrame:
    """One row per game — identifies the first-picked champion, the team that picked it,
    and the role they ended up playing. Implied WR comes from the model from that team's POV."""
    records = []
    for _, row in merged.iterrows():
        pred = row['model_pred']; result = row['blue_team_result']
        if pd.isna(pred) or pd.isna(result): continue
        bfp = row.get('blue_team_firstPick'); rfp = row.get('red_team_firstPick')
        if bfp == 1 and rfp != 1:
            side, champ, exp, won = 'blue', row.get('blue_team_pick1'), pred,     int(result)
        elif rfp == 1 and bfp != 1:
            side, champ, exp, won = 'red',  row.get('red_team_pick1'),  1 - pred, 1 - int(result)
        else:
            continue
        if pd.isna(champ): continue
        role = None
        for pos in POS_MAP:
            if row.get(f'{side}_{pos}_champion') == champ:
                role = pos; break
        if role is None: continue
        records.append({'champion': champ, 'position': role, 'expected': exp, 'won': won})
    return pd.DataFrame(records, columns=['champion', 'position', 'expected', 'won'])


def _aggregate_firstpicks(df: pd.DataFrame, min_games: int) -> dict:
    """Per-role rows for each first-picked champion + overall summary."""
    overall = {
        'games':    int(len(df)),
        'actual':   round(float(df['won'].mean()),      4) if len(df) else None,
        'expected': round(float(df['expected'].mean()), 4) if len(df) else None,
        'outperf':  round(float((df['won'] - df['expected']).mean()), 4) if len(df) else None,
    }
    by_role_overall = {}
    for pos in POS_MAP:
        sub = df[df['position'] == pos]
        by_role_overall[pos] = {
            'games':    int(len(sub)),
            'actual':   round(float(sub['won'].mean()),      4) if len(sub) else None,
            'expected': round(float(sub['expected'].mean()), 4) if len(sub) else None,
            'outperf':  round(float((sub['won'] - sub['expected']).mean()), 4) if len(sub) else None,
        }
    agg = df.groupby(['champion', 'position']).agg(
        games=('won', 'count'), actual=('won', 'mean'), expected=('expected', 'mean')
    ).reset_index()
    agg['outperf'] = agg['actual'] - agg['expected']
    agg = agg[agg['games'] >= min_games]
    by_pos: dict = {}
    for pos in POS_MAP:
        sub = agg[agg['position'] == pos].sort_values('games', ascending=False)
        by_pos[pos] = [
            {'champion': r['champion'], 'games': int(r['games']),
             'actual': round(float(r['actual']), 4), 'expected': round(float(r['expected']), 4),
             'outperf': round(float(r['outperf']), 4)}
            for _, r in sub.iterrows()
        ]
    return {'overall': overall, 'by_role_overall': by_role_overall, 'by_position': by_pos}


def main():
    print("Loading data…")
    feat = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    gwo  = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False)

    print("Training model on 2024–2025 + applying adjustments…")
    feat = compute_model_preds(feat)
    feat26 = feat[feat['year'] == 2026].copy()
    print(f"2026 games: {len(feat26)}")

    champ_cols = (
        ['gameid', 'league', 'blue_team_result',
         'blue_team_firstPick', 'red_team_firstPick',
         'blue_team_pick1', 'red_team_pick1'] +
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

    print("First-pick deltas…")
    first_picks       = _aggregate_firstpicks(_build_firstpick_records(m_all),   MIN_FIRSTPICK)
    first_picks_major = _aggregate_firstpicks(_build_firstpick_records(m_major), MIN_FIRSTPICK_MAJOR)

    print("Flex picks…")
    flex_picks       = _aggregate_flex(m_all,   MIN_FLEX)
    flex_picks_major = _aggregate_flex(m_major, MIN_FLEX_MAJOR)

    print(f"  synergies: {len(synergies)} all / {len(synergies_major)} major")
    for pos in POS_MAP:
        print(f"  {pos}: {len(by_position[pos])} champs, {len(matchups[pos])} matchups all "
              f"/ {len(by_position_major[pos])} champs, {len(matchups_major[pos])} matchups major")
    print(f"  first picks: overall {first_picks['overall']['games']} games "
          f"({first_picks['overall']['actual']} actual vs {first_picks['overall']['expected']} model)")

    out = {
        'generated':          datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'year':               2026,
        'min_games':          MIN_GAMES,
        'min_games_major':    MIN_GAMES_MAJOR,
        'min_firstpick':      MIN_FIRSTPICK,
        'min_firstpick_major': MIN_FIRSTPICK_MAJOR,
        'by_position':        by_position,
        'by_position_major':  by_position_major,
        'matchups':           matchups,
        'matchups_major':     matchups_major,
        'synergies':          synergies,
        'synergies_major':    synergies_major,
        'first_picks':        first_picks,
        'first_picks_major':  first_picks_major,
        'min_flex':           MIN_FLEX,
        'min_flex_major':     MIN_FLEX_MAJOR,
        'flex_picks':         flex_picks,
        'flex_picks_major':   flex_picks_major,
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f"Wrote {OUT}")


if __name__ == '__main__':
    main()
