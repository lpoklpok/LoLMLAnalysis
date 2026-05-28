"""
compare_in_game_20.py
Comparison sweep: pre-draft, post-draft, +gd15, +gd20, +both, +interactions,
+XGB. Goal: find the lowest walk-forward log loss for major leagues using
pre-game features + draft (champion) features + in-game gold diff at 20.

Once the best variant is identified, modify upload_game_features.py to
emit it as `model_pred_in_game_20`.
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
FILL  = {f: 0.0 for f in PROD + CHAMP + ['actual_gd15_diff', 'actual_gd20_diff',
                                          'gd20_x_elo', 'gd20_x_gd15']}
FILL['h2h_wr'] = 0.5; FILL['playoffs'] = 0

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


def add_draft(df):
    df = df.copy()
    df['_day']  = df['date'].dt.date
    df['_pair'] = df.apply(lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1)
    df = df.sort_values(['_day','league','_pair','game']).reset_index(drop=True)
    sh = df.groupby(['_day','league','_pair'])['blue_win'].shift(1)
    df['draft_advantage'] = sh.map(lambda x: 0 if pd.isna(x) else (-1 if x==1 else 1)).astype(int)
    return df


def adj(lo, df):
    a = lo.copy()
    g2 = ((df['game'] == 2) & (df['year'] >= 2025)).values
    a[g2] = ALPHA_G2 * a[g2] + BETA_DA * df['draft_advantage'].values[g2]
    po = df['playoffs'].values == 1
    if po.any():
        bp = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['blue_team']])
        rp = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['red_team']])
        a[po] += (bp - rp)[po]
    yrs = df['year'].values
    for team, (fy, b) in COACHING_ADJ.items():
        active = yrs >= fy
        a[(df['blue_team'].values == team) & active] += b
        a[(df['red_team'].values  == team) & active] -= b
    return a


def fit_lr(train, eval_df, features):
    m = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(train[features].fillna(FILL), train['blue_win'].values)
    s, lr = m.named_steps['s'], m.named_steps['lr']
    lo = s.transform(eval_df[features].fillna(FILL)) @ lr.coef_.ravel() + lr.intercept_[0]
    return 1.0 / (1.0 + np.exp(-adj(lo, eval_df)))


def fit_xgb(train, eval_df, features):
    if xgb is None:
        return None
    m = xgb.XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.04,
                          min_child_weight=15, subsample=0.85, colsample_bytree=0.8,
                          reg_lambda=2.0, objective='binary:logistic',
                          tree_method='hist', verbosity=0, random_state=42)
    m.fit(train[features].fillna(FILL), train['blue_win'].values)
    return m.predict_proba(eval_df[features].fillna(FILL))[:, 1]


def main():
    df = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    ch = pd.read_csv(PROCESSED / 'champ_features.csv', low_memory=False)
    df = df.merge(ch, on='gameid', how='left')
    gw = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False,
                       usecols=['gameid', 'blue_team_golddiffat15', 'blue_team_golddiffat20'])
    df = df.merge(gw, on='gameid', how='left')
    df['actual_gd15_diff'] = df['blue_team_golddiffat15']
    df['actual_gd20_diff'] = df['blue_team_golddiffat20']
    # Interaction features
    df['gd20_x_elo']  = df['actual_gd20_diff'] * (df['elo_diff'] / 100)  # rescale
    df['gd20_x_gd15'] = df['actual_gd20_diff'] * (df['actual_gd15_diff'] / 100)
    df = add_draft(df)

    sub = df[df['league'].isin(MAJOR)].copy()
    sub = sub[sub['actual_gd20_diff'].notna()].copy()  # only games that hit 20 min
    print(f'Major-league games with gd20 observed: {len(sub):,}')
    print(f'  blue_win rate: {sub["blue_win"].mean():.3f}')

    variants = [
        ('A_pre_draft',         PROD),
        ('B_post_draft',        PROD + CHAMP),
        ('C_in_game_15',        PROD + CHAMP + ['actual_gd15_diff']),
        ('D_in_game_20',        PROD + CHAMP + ['actual_gd20_diff']),
        ('E_in_game_15+20',     PROD + CHAMP + ['actual_gd15_diff','actual_gd20_diff']),
        ('F_+gd20_x_elo',       PROD + CHAMP + ['actual_gd20_diff','gd20_x_elo']),
        ('G_+gd20_x_gd15',      PROD + CHAMP + ['actual_gd15_diff','actual_gd20_diff','gd20_x_gd15']),
        ('H_kitchen_sink',      PROD + CHAMP + ['actual_gd15_diff','actual_gd20_diff','gd20_x_elo','gd20_x_gd15']),
    ]

    train = sub[sub['year'].isin([2024, 2025])]
    eval_df = sub[sub['year'] == 2026].copy()
    eval_df['month'] = eval_df['date'].dt.to_period('M')
    months = sorted(eval_df['month'].unique())
    print(f'  train n={len(train):,}, eval n={len(eval_df):,}, months={len(months)}')

    rows = []
    for label, features in variants:
        per_month_ll = []
        weights = []
        for m in months:
            in_mo  = eval_df[eval_df['month'] == m]
            before = eval_df[eval_df['month'] < m]
            train_set = pd.concat([train, before], ignore_index=True)
            if len(in_mo) < 3:
                continue
            try:
                p = fit_lr(train_set, in_mo, features)
                per_month_ll.append(log_loss(in_mo['blue_win'].values, np.clip(p, 1e-6, 1-1e-6)))
                weights.append(len(in_mo))
            except ValueError:
                continue
        weighted_ll = np.average(per_month_ll, weights=weights) if per_month_ll else float('nan')
        rows.append({'variant': label, 'features': len(features), 'log_loss': weighted_ll})

    # Also try XGBoost on best LR feature set
    if xgb is not None:
        for label, features in [('I_xgb_E',         PROD + CHAMP + ['actual_gd15_diff','actual_gd20_diff']),
                                 ('J_xgb_kitchen',   PROD + CHAMP + ['actual_gd15_diff','actual_gd20_diff','gd20_x_elo','gd20_x_gd15']),
                                 ('K_xgb_only_gd20', PROD + ['actual_gd20_diff'])]:
            per_month_ll, weights = [], []
            for m in months:
                in_mo  = eval_df[eval_df['month'] == m]
                before = eval_df[eval_df['month'] < m]
                train_set = pd.concat([train, before], ignore_index=True)
                if len(in_mo) < 3: continue
                try:
                    p = fit_xgb(train_set, in_mo, features)
                    if p is None: continue
                    per_month_ll.append(log_loss(in_mo['blue_win'].values, np.clip(p, 1e-6, 1-1e-6)))
                    weights.append(len(in_mo))
                except ValueError:
                    continue
            weighted_ll = np.average(per_month_ll, weights=weights) if per_month_ll else float('nan')
            rows.append({'variant': label, 'features': len(features), 'log_loss': weighted_ll})

    out = pd.DataFrame(rows).sort_values('log_loss')
    print('\n=== Walk-forward weighted log loss (major leagues) ===')
    print(out.to_string(index=False, float_format=lambda v: f'{v:.4f}'))
    base = out[out['variant'] == 'A_pre_draft']['log_loss'].iloc[0]
    out['vs_pre_draft_%'] = (out['log_loss'] - base) / base * 100
    print('\n=== Improvement vs pre-draft baseline ===')
    print(out[['variant', 'log_loss', 'vs_pre_draft_%']].to_string(index=False,
                                                                     float_format=lambda v: f'{v:+.2f}'))


if __name__ == '__main__':
    main()
