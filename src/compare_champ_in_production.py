"""
compare_champ_in_production.py
Apples-to-apples test: does adding the 4 champion-level features improve
your PRODUCTION model (LR + post-hoc adjustments)?

Production model:
  features = ['elo_diff','rwr_diff','h2h_wr','playoffs','gd15_diff','outperf_diff']
  + StandardScaler + LogisticRegression
  + G2 draft-advantage adjustment (alpha * logodds + beta * draft_advantage on G2 in 2025+)
  + per-team playoff adjustment (TEAM_PO_ADJ)
  + coaching adjustment (COACHING_ADJ)

This script trains BOTH variants — production-as-is, and production+4 champ
features — with walk-forward CV per month of 2026, reporting log loss.
"""
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

PROCESSED = Path(__file__).resolve().parent.parent / 'data' / 'processed'
MAJOR = ['LCK', 'LPL', 'LEC', 'LCS']

FEATS_PROD = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FEATS_CHAMP_ADD = [
    'avg_player_champ_familiarity_diff',
    'avg_player_champ_wr_diff',
    'avg_champ_meta_wr_diff',
    'roster_stability_diff',
]
FILL = {
    'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5,
    'playoffs': 0, 'gd15_diff': 0.0, 'outperf_diff': 0.0,
    'avg_player_champ_familiarity_diff': 0.0,
    'avg_player_champ_wr_diff':           0.0,
    'avg_champ_meta_wr_diff':             0.0,
    'roster_stability_diff':              0.0,
}

ALPHA_G2 = 0.8970
BETA_DA  = 0.0929

TEAM_PO_ADJ = {
    'G2 Esports': 0.4172, 'FunPlus Phoenix': 0.3159, 'Bilibili Gaming': 0.2242,
    'T1': 0.2068, 'KT Rolster': 0.1991, 'Weibo Gaming': 0.1234,
    'BNK FEARX': 0.1069, "Anyone's Legend": 0.0801, 'Team BDS': 0.0612,
    'Karmine Corp': 0.0416, 'Hanwha Life Esports': -0.0616, 'Team WE': -0.0757,
    'Top Esports': -0.0927, 'Dplus Kia': -0.0968, 'JD Gaming': -0.1238,
    'Invictus Gaming': -0.1406, 'Gen.G': -0.1510, 'Movistar KOI': -0.1518,
    'Team Heretics': -0.3450, 'ThunderTalk Gaming': -0.3521,
    'Ninjas in Pyjamas': -0.3548, 'EDward Gaming': -0.3743,
    'Team Vitality': -0.4237, 'Fnatic': -0.4427, 'GiantX': -0.4491,
    'Nongshim RedForce': -0.6670,
}
COACHING_ADJ = {'Karmine Corp': (2026, 0.3695)}


def add_meta(df):
    """Match upload_game_features.py: build draft_advantage column from
    chronological per-team-pair series ordering."""
    df = df.copy()
    df['date']      = pd.to_datetime(df['date'], utc=True)
    df['_day']      = df['date'].dt.date
    df['_pair']     = df.apply(
        lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1)
    df = df.sort_values(['_day', 'league', '_pair', 'game']).reset_index(drop=True)
    shifted = df.groupby(['_day', 'league', '_pair'])['blue_win'].shift(1)
    df['draft_advantage'] = shifted.map(
        lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)).astype(int)
    return df


def predict_with_adjustments(model, df, features):
    """Same exact post-hoc pipeline as upload_game_features.py."""
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(df[features].fillna(FILL))
    logodds = X_sc @ lr.coef_.ravel() + lr.intercept_[0]
    logodds = logodds.copy()
    # G2 alpha/beta on games in 2025+
    g2_mask = ((df['game'] == 2) & (df['year'] >= 2025)).values
    logodds[g2_mask] = (ALPHA_G2 * logodds[g2_mask]
                        + BETA_DA * df['draft_advantage'].values[g2_mask])
    # Playoff per-team
    po_mask = df['playoffs'].values == 1
    if po_mask.any():
        blue_po = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['blue_team']])
        red_po  = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['red_team']])
        logodds[po_mask] += (blue_po - red_po)[po_mask]
    # Coaching
    years = df['year'].values
    for team, (from_year, bonus) in COACHING_ADJ.items():
        active = years >= from_year
        logodds[(df['blue_team'].values == team) & active] += bonus
        logodds[(df['red_team'].values  == team) & active] -= bonus
    return 1.0 / (1.0 + np.exp(-logodds))


def fit_pipeline(train, features):
    m = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(train[features].fillna(FILL), train['blue_win'].values)
    return m


def walk_forward_compare(df, features_prod, features_champ, leagues_label):
    print(f'\n=== {leagues_label} ===')
    train_base = df[df['year'].isin([2024, 2025])]
    eval_df    = df[df['year'] == 2026].copy()
    eval_df['month'] = eval_df['date'].dt.to_period('M')
    months = sorted(eval_df['month'].unique())

    rows = []
    for m in months:
        in_month  = eval_df[eval_df['month'] == m]
        before_m  = eval_df[eval_df['month'] < m]
        train_set = pd.concat([train_base, before_m], ignore_index=True)
        if len(in_month) == 0: continue
        # Production-as-is
        m_prod = fit_pipeline(train_set, features_prod)
        p_prod = predict_with_adjustments(m_prod, in_month, features_prod)
        # Production + champion
        m_champ = fit_pipeline(train_set, features_champ)
        p_champ = predict_with_adjustments(m_champ, in_month, features_champ)
        y = in_month['blue_win'].values
        ll_prod  = log_loss(y, np.clip(p_prod, 1e-6, 1-1e-6))
        ll_champ = log_loss(y, np.clip(p_champ, 1e-6, 1-1e-6))
        rows.append({'month': str(m), 'n': len(in_month),
                     'prod_ll': ll_prod, 'champ_ll': ll_champ,
                     'delta': ll_champ - ll_prod})
    out = pd.DataFrame(rows)
    print(out.to_string(index=False, float_format=lambda v: f'{v:.4f}'))
    wp = (out['prod_ll']  * out['n']).sum() / out['n'].sum()
    wc = (out['champ_ll'] * out['n']).sum() / out['n'].sum()
    delta = (wc - wp) / wp * 100
    print(f'\nWeighted log loss across {out["n"].sum()} games:')
    print(f'  PRODUCTION (6 feats + adj):       {wp:.4f}')
    print(f'  PRODUCTION + 4 CHAMP feats + adj: {wc:.4f}')
    sign = '−' if delta < 0 else '+'
    print(f'  Δ = {sign}{abs(delta):.2f}%  ({"BETTER" if delta < 0 else "WORSE"})')


def main():
    df = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    ch = pd.read_csv(PROCESSED / 'champ_features.csv', low_memory=False)
    df = df.merge(ch, on='gameid', how='left')
    df = add_meta(df)
    print(f'Loaded {len(df):,} games')

    feats_prod  = FEATS_PROD
    feats_champ = FEATS_PROD + FEATS_CHAMP_ADD

    df_major = df[df['league'].isin(MAJOR)].copy()
    walk_forward_compare(df_major, feats_prod, feats_champ, 'MAJOR LEAGUES')
    walk_forward_compare(df,        feats_prod, feats_champ, 'ALL LEAGUES')


if __name__ == '__main__':
    main()
