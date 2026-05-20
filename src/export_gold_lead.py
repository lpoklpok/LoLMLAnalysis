"""
export_gold_lead.py
Exports gold-lead win rates to web/public/gold_lead.json.

Usage:
    python src/export_gold_lead.py
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
OUT       = ROOT / 'web' / 'public' / 'gold_lead.json'

MAJOR_LEAGUES = {'LCK', 'LEC', 'LCS', 'LPL'}
GOLD_STEP     = 500
GOLD_EDGES    = list(range(0, 10001, 500))  # 0, 500, 1000, ..., 10000 then 10000+

FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FILL  = {'elo_diff': 0., 'rwr_diff': 0., 'h2h_wr': 0.5,
         'playoffs': 0, 'gd15_diff': 0., 'outperf_diff': 0.}

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


def _bucket_label(lo: int, hi: int | None) -> str:
    return f'{lo:,}+' if hi is None else f'{lo:,}–{hi:,}'


def compute_model_preds(df: pd.DataFrame) -> pd.DataFrame:
    """Train on 2024-2025, apply to all rows. Identical pipeline to upload_game_features.py."""
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
    Win rate of the gold-leading team, split by that team's pre-game model
    probability (10% buckets) and their gold lead magnitude (500g buckets).
    Uses model_pred (blue win probability from logistic regression).
    """
    cols = [diff_col, 'blue_team_result', 'model_pred']
    sub = df[cols].dropna()
    sub = sub[sub[diff_col] != 0].copy()

    # model_pred is always blue's probability; flip for leading team when red is ahead
    sub['leading_prob'] = np.where(
        sub[diff_col] > 0, sub['model_pred'], 1 - sub['model_pred']
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


def objective_wrs(df: pd.DataFrame) -> dict:
    """Win rate when a team gets 4+ dragons or first baron (side-agnostic)."""
    out: dict = {}

    # 4+ dragons: two team-game rows per game (blue + red)
    drag = df[['blue_team_dragons', 'red_team_dragons', 'blue_team_result']].dropna()
    blue_drag_4 = drag[drag['blue_team_dragons'] >= 4]
    red_drag_4  = drag[drag['red_team_dragons']  >= 4]
    n_drag = len(blue_drag_4) + len(red_drag_4)
    wins_drag = int(blue_drag_4['blue_team_result'].sum()) + int((1 - red_drag_4['blue_team_result']).sum())
    out['dragons_4plus'] = {
        'n':        n_drag,
        'wins':     wins_drag,
        'win_rate': round(wins_drag / n_drag, 4) if n_drag else None,
    }

    # First baron
    bar = df[['blue_team_firstbaron', 'red_team_firstbaron', 'blue_team_result']].dropna()
    blue_fb = bar[bar['blue_team_firstbaron'] == 1]
    red_fb  = bar[bar['red_team_firstbaron']  == 1]
    n_bar = len(blue_fb) + len(red_fb)
    wins_bar = int(blue_fb['blue_team_result'].sum()) + int((1 - red_fb['blue_team_result']).sum())
    out['first_baron'] = {
        'n':        n_bar,
        'wins':     wins_bar,
        'win_rate': round(wins_bar / n_bar, 4) if n_bar else None,
    }

    return out


def prob_x_objective(df: pd.DataFrame) -> dict:
    """
    Win rate of a team that secured the objective, bucketed by that team's
    pre-game model probability (10% buckets). Pools blue + red team-game rows.
    """
    base_cols = ['blue_team_result', 'model_pred',
                 'blue_team_dragons', 'red_team_dragons',
                 'blue_team_firstbaron', 'red_team_firstbaron']
    sub = df[base_cols].copy()

    def _pool(cond_blue: pd.Series, cond_red: pd.Series) -> pd.DataFrame:
        # blue-perspective rows where blue secured the objective
        b = sub[cond_blue & sub['model_pred'].notna() & sub['blue_team_result'].notna()].copy()
        b['team_prob'] = b['model_pred']
        b['team_won']  = b['blue_team_result']
        # red-perspective rows where red secured the objective
        r = sub[cond_red & sub['model_pred'].notna() & sub['blue_team_result'].notna()].copy()
        r['team_prob'] = 1 - r['model_pred']
        r['team_won']  = 1 - r['blue_team_result']
        return pd.concat([b[['team_prob', 'team_won']], r[['team_prob', 'team_won']]], ignore_index=True)

    def _bucket(pooled: pd.DataFrame) -> list[dict]:
        rows = []
        prob_edges = [i / 10 for i in range(11)]
        for j in range(len(prob_edges) - 1):
            p_lo, p_hi = prob_edges[j], prob_edges[j + 1]
            chunk = pooled[(pooled['team_prob'] >= p_lo) & (pooled['team_prob'] < p_hi)]
            n = len(chunk)
            if n < 3:
                continue
            rows.append({
                'prob_bucket': f'{int(p_lo * 100)}–{int(p_hi * 100)}%',
                'prob_lo':     p_lo,
                'prob_hi':     p_hi,
                'n':           int(n),
                'wins':        int(chunk['team_won'].sum()),
                'win_rate':    round(float(chunk['team_won'].mean()), 4),
            })
        return rows

    drag_pool = _pool(sub['blue_team_dragons'] >= 4, sub['red_team_dragons'] >= 4)
    bar_pool  = _pool(sub['blue_team_firstbaron'] == 1, sub['red_team_firstbaron'] == 1)

    return {
        'dragons_4plus': _bucket(drag_pool),
        'first_baron':   _bucket(bar_pool),
    }


def compute_set(df: pd.DataFrame, times: dict) -> dict:
    return {
        'gold_lead':        {t: gold_lead_wr(df, col)   for t, col in times.items()},
        'prob_x_gold':      {t: prob_x_gold_wr(df, col) for t, col in times.items()},
        'objectives':       objective_wrs(df),
        'prob_x_objective': prob_x_objective(df),
    }


def main():
    print('Loading features_all.csv and computing model predictions…')
    feats = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    feats = compute_model_preds(feats)
    feats2026 = feats[feats['year'] == 2026][['gameid', 'model_pred']].copy()
    print(f'  2026 model predictions: {len(feats2026)}')

    print('Loading games_with_odds.csv…')
    games = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False)
    games2026 = games[games['year'] == 2026].copy()

    df = games2026.merge(feats2026, on='gameid', how='left')
    matched = df['model_pred'].notna().sum()
    print(f'  2026 games: {len(df)}, matched model predictions: {matched}')

    df_major = df[df['league'].isin(MAJOR_LEAGUES)].copy()
    print(f'  major: {len(df_major)}')

    times = {
        '10': 'blue_team_golddiffat10',
        '15': 'blue_team_golddiffat15',
        '20': 'blue_team_golddiffat20',
    }

    print('Computing all-leagues…')
    data_all   = compute_set(df,       times)
    print('Computing major-leagues…')
    data_major = compute_set(df_major, times)

    out = {
        'generated':        datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'year':             2026,
        'gold_step':        GOLD_STEP,
        'gold_lead':        {'all': data_all['gold_lead'],        'major': data_major['gold_lead']},
        'prob_x_gold':      {'all': data_all['prob_x_gold'],      'major': data_major['prob_x_gold']},
        'objectives':       {'all': data_all['objectives'],       'major': data_major['objectives']},
        'prob_x_objective': {'all': data_all['prob_x_objective'], 'major': data_major['prob_x_objective']},
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    size_kb = OUT.stat().st_size // 1024
    print(f'Wrote {OUT} ({size_kb} KB)')


if __name__ == '__main__':
    main()
