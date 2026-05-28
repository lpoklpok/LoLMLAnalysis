"""
compare_in_game_full.py
Throws everything observable by minute 20 at the model:
  - All pre-game features (PROD + CHAMP)
  - Gold/XP/CS diffs at 10, 15, 20
  - Kills / Deaths / Assists at 20 (signed diff)
  - Per-role gold diffs at 20
  - First-blood / first-dragon / first-tower / first-midtower / first-herald
    / first-to-three-towers (each as +1/-1/0)

Sweeps LR with various L2 strengths + LASSO + XGB. Reports walk-forward
log loss on major leagues.
"""
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    import xgboost as xgb
except ImportError:
    xgb = None

PROCESSED = Path(__file__).resolve().parent.parent / 'data' / 'processed'
MAJOR = ['LCK', 'LPL', 'LEC', 'LCS']

PROD  = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
CHAMP = ['avg_champ_meta_wr_diff', 'avg_player_champ_wr_diff', 'roster_stability_diff']

# In-game observables by minute 20
LIVE = [
    # Gold diffs
    'actual_gd10_diff', 'actual_gd15_diff', 'actual_gd20_diff',
    # XP diffs
    'xp10_diff', 'xp15_diff', 'xp20_diff',
    # CS diffs
    'cs10_diff', 'cs15_diff', 'cs20_diff',
    # KDA at 20
    'kills20_diff', 'deaths20_diff', 'assists20_diff',
    # Per-role gold @ 20
    'top_gd20', 'jng_gd20', 'mid_gd20', 'bot_gd20', 'sup_gd20',
    # First-X flags (+1 blue, -1 red, 0 neither)
    'firstblood', 'firstdragon', 'firsttower', 'firstmidtower',
    'firstherald', 'firsttothreetowers',
]

ALPHA_G2, BETA_DA = 0.8970, 0.0929
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


def first_x_flag(blue_val, red_val):
    """{blue=1 → +1, red=1 → -1, neither → 0}. Treats NaN as 0."""
    if pd.isna(blue_val) or pd.isna(red_val):
        return 0.0
    if blue_val == 1: return 1.0
    if red_val  == 1: return -1.0
    return 0.0


def build_df():
    df = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    ch = pd.read_csv(PROCESSED / 'champ_features.csv', low_memory=False)
    df = df.merge(ch, on='gameid', how='left')

    gw_cols = [
        'gameid',
        'blue_team_golddiffat10','blue_team_golddiffat15','blue_team_golddiffat20',
        'blue_team_xpdiffat10','blue_team_xpdiffat15','blue_team_xpdiffat20',
        'blue_team_csdiffat10','blue_team_csdiffat15','blue_team_csdiffat20',
        'blue_team_killsat20','red_team_killsat20',
        'blue_team_deathsat20','red_team_deathsat20',
        'blue_team_assistsat20','red_team_assistsat20',
        'blue_top_golddiffat20','blue_jng_golddiffat20','blue_mid_golddiffat20',
        'blue_bot_golddiffat20','blue_sup_golddiffat20',
        'blue_team_firstblood','red_team_firstblood',
        'blue_team_firstdragon','red_team_firstdragon',
        'blue_team_firsttower','red_team_firsttower',
        'blue_team_firstmidtower','red_team_firstmidtower',
        'blue_team_firstherald','red_team_firstherald',
        'blue_team_firsttothreetowers','red_team_firsttothreetowers',
    ]
    gw = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False, usecols=gw_cols)
    df = df.merge(gw, on='gameid', how='left')

    # Build the LIVE features
    df['actual_gd10_diff'] = df['blue_team_golddiffat10']
    df['actual_gd15_diff'] = df['blue_team_golddiffat15']
    df['actual_gd20_diff'] = df['blue_team_golddiffat20']
    df['xp10_diff']        = df['blue_team_xpdiffat10']
    df['xp15_diff']        = df['blue_team_xpdiffat15']
    df['xp20_diff']        = df['blue_team_xpdiffat20']
    df['cs10_diff']        = df['blue_team_csdiffat10']
    df['cs15_diff']        = df['blue_team_csdiffat15']
    df['cs20_diff']        = df['blue_team_csdiffat20']
    df['kills20_diff']     = df['blue_team_killsat20']   - df['red_team_killsat20']
    df['deaths20_diff']    = df['blue_team_deathsat20']  - df['red_team_deathsat20']
    df['assists20_diff']   = df['blue_team_assistsat20'] - df['red_team_assistsat20']
    df['top_gd20']         = df['blue_top_golddiffat20']
    df['jng_gd20']         = df['blue_jng_golddiffat20']
    df['mid_gd20']         = df['blue_mid_golddiffat20']
    df['bot_gd20']         = df['blue_bot_golddiffat20']
    df['sup_gd20']         = df['blue_sup_golddiffat20']
    for name in ['firstblood','firstdragon','firsttower','firstmidtower','firstherald','firsttothreetowers']:
        df[name] = df.apply(
            lambda r: first_x_flag(r.get(f'blue_team_{name}'), r.get(f'red_team_{name}')),
            axis=1)

    # Draft advantage
    df['_day']  = df['date'].dt.date
    df['_pair'] = df.apply(lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1)
    df = df.sort_values(['_day','league','_pair','game']).reset_index(drop=True)
    sh = df.groupby(['_day','league','_pair'])['blue_win'].shift(1)
    df['draft_advantage'] = sh.map(lambda x: 0 if pd.isna(x) else (-1 if x==1 else 1)).astype(int)
    return df


def adj(lo, df):
    a = lo.copy()
    g2 = ((df['game']==2) & (df['year']>=2025)).values
    a[g2] = ALPHA_G2 * a[g2] + BETA_DA * df['draft_advantage'].values[g2]
    po = df['playoffs'].values == 1
    if po.any():
        bp = np.array([TEAM_PO_ADJ.get(t,0.0) for t in df['blue_team']])
        rp = np.array([TEAM_PO_ADJ.get(t,0.0) for t in df['red_team']])
        a[po] += (bp-rp)[po]
    yrs = df['year'].values
    for team,(fy,b) in COACHING_ADJ.items():
        active = yrs>=fy
        a[(df['blue_team'].values==team)&active] += b
        a[(df['red_team'].values ==team)&active] -= b
    return a


def fit_lr(train, eval_df, features, C=1.0, penalty='l2'):
    fill = {f: 0.0 for f in features}
    fill['h2h_wr'] = 0.5
    fill['playoffs'] = 0
    solver = 'liblinear' if penalty == 'l1' else 'lbfgs'
    m = Pipeline([('s', StandardScaler()),
                  ('lr', LogisticRegression(max_iter=2000, C=C, penalty=penalty, solver=solver))])
    m.fit(train[features].fillna(fill), train['blue_win'].values)
    s,lr = m.named_steps['s'], m.named_steps['lr']
    lo = s.transform(eval_df[features].fillna(fill)) @ lr.coef_.ravel() + lr.intercept_[0]
    return 1.0/(1.0+np.exp(-adj(lo, eval_df))), m


def fit_xgb(train, eval_df, features, depth=3, n_estimators=300, min_child_weight=15):
    if xgb is None: return None, None
    fill = {f: 0.0 for f in features}
    fill['h2h_wr'] = 0.5; fill['playoffs'] = 0
    m = xgb.XGBClassifier(n_estimators=n_estimators, max_depth=depth,
                          learning_rate=0.04, min_child_weight=min_child_weight,
                          subsample=0.85, colsample_bytree=0.8, reg_lambda=2.0,
                          tree_method='hist', verbosity=0, random_state=42,
                          objective='binary:logistic')
    m.fit(train[features].fillna(fill), train['blue_win'].values)
    p = m.predict_proba(eval_df[features].fillna(fill))[:,1]
    return p, m


def main():
    df = build_df()
    sub = df[df['league'].isin(MAJOR)].copy()
    sub = sub[sub['actual_gd20_diff'].notna()].copy()
    print(f'Major-league games with gd20 observed: {len(sub):,}')

    train = sub[sub['year'].isin([2024, 2025])]
    eval_df = sub[sub['year'] == 2026].copy()
    eval_df['month'] = eval_df['date'].dt.to_period('M')
    months = sorted(eval_df['month'].unique())
    print(f'  train n={len(train):,}, eval n={len(eval_df):,}')

    def run_variant(label, features, fitter):
        per_month, weights = [], []
        for m in months:
            in_mo = eval_df[eval_df['month'] == m]
            before = eval_df[eval_df['month'] < m]
            train_set = pd.concat([train, before], ignore_index=True)
            if len(in_mo) < 3: continue
            try:
                p, _ = fitter(train_set, in_mo, features)
                per_month.append(log_loss(in_mo['blue_win'].values, np.clip(p, 1e-6, 1-1e-6)))
                weights.append(len(in_mo))
            except ValueError:
                continue
        return np.average(per_month, weights=weights) if per_month else float('nan')

    PCG     = PROD + CHAMP                          # post-draft baseline
    PCG_BEST = PROD + CHAMP + ['actual_gd15_diff','actual_gd20_diff']  # previous best

    sweeps = [
        ('LR_pre',                        PROD,                                  lambda t,e,f: fit_lr(t,e,f, C=1.0)),
        ('LR_post',                       PCG,                                   lambda t,e,f: fit_lr(t,e,f, C=1.0)),
        ('LR_prev_best(C=1)',             PCG_BEST,                              lambda t,e,f: fit_lr(t,e,f, C=1.0)),
        ('LR_ALL(C=1)',                   PCG + LIVE,                            lambda t,e,f: fit_lr(t,e,f, C=1.0)),
        ('LR_ALL(C=0.3)',                 PCG + LIVE,                            lambda t,e,f: fit_lr(t,e,f, C=0.3)),
        ('LR_ALL(C=0.1)',                 PCG + LIVE,                            lambda t,e,f: fit_lr(t,e,f, C=0.1)),
        ('LR_ALL_L1(C=0.3)',              PCG + LIVE,                            lambda t,e,f: fit_lr(t,e,f, C=0.3, penalty='l1')),
        ('LR_ALL_L1(C=0.1)',              PCG + LIVE,                            lambda t,e,f: fit_lr(t,e,f, C=0.1, penalty='l1')),
        ('XGB_ALL_d3',                    PCG + LIVE,                            lambda t,e,f: fit_xgb(t,e,f, depth=3, n_estimators=400, min_child_weight=20)),
        ('XGB_ALL_d4',                    PCG + LIVE,                            lambda t,e,f: fit_xgb(t,e,f, depth=4, n_estimators=400, min_child_weight=15)),
        ('XGB_LIVE_only',                 PROD + LIVE,                           lambda t,e,f: fit_xgb(t,e,f, depth=3, n_estimators=400, min_child_weight=20)),
    ]
    rows = []
    for label, feats, fitter in sweeps:
        ll = run_variant(label, feats, fitter)
        rows.append({'variant': label, 'n_feats': len(feats), 'log_loss': ll})

    out = pd.DataFrame(rows).sort_values('log_loss')
    base = out[out['variant'] == 'LR_pre']['log_loss'].iloc[0]
    out['vs_pre_%'] = (out['log_loss'] - base) / base * 100
    print('\n=== Walk-forward weighted log loss (major leagues) ===')
    print(out.to_string(index=False, float_format=lambda v: f'{v:.4f}'))


if __name__ == '__main__':
    main()
