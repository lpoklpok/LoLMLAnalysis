"""
compare_in_game.py
Walk-forward log-loss comparison of three model variants:
  1) PRE_DRAFT   — production features (no champion info, no in-game info)
  2) POST_DRAFT  — + champion features (known after picks/bans)
  3) IN_GAME_15  — + actual gold-diff-at-15 from THIS game (live betting)

All three go through identical G2/playoff/coaching post-hoc adjustments.

The IN_GAME_15 model uses `blue_team_golddiffat15` from games_with_odds.csv
— i.e., the actual gold diff observed in the live game at minute 15.
That's a single-game observation, not a rolling average.
"""
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

PROCESSED = Path(__file__).resolve().parent.parent / 'data' / 'processed'
MAJOR     = ['LCK', 'LPL', 'LEC', 'LCS']

FEATS_PROD  = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FEATS_CHAMP = ['avg_champ_meta_wr_diff', 'avg_player_champ_wr_diff', 'roster_stability_diff']
FEATS_LIVE  = ['actual_gd15_diff']   # blue_team_golddiffat15

FILL = {
    'elo_diff': 0., 'rwr_diff': 0., 'h2h_wr': 0.5, 'playoffs': 0,
    'gd15_diff': 0., 'outperf_diff': 0.,
    'avg_champ_meta_wr_diff': 0., 'avg_player_champ_wr_diff': 0., 'roster_stability_diff': 0.,
    'actual_gd15_diff': 0.,
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


def add_draft_advantage(df):
    df = df.copy()
    df['_day']  = df['date'].dt.date
    df['_pair'] = df.apply(lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1)
    df = df.sort_values(['_day', 'league', '_pair', 'game']).reset_index(drop=True)
    shifted = df.groupby(['_day', 'league', '_pair'])['blue_win'].shift(1)
    df['draft_advantage'] = shifted.map(lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)).astype(int)
    return df


def apply_adjustments(logodds, df):
    adj = logodds.copy()
    g2_mask = ((df['game'] == 2) & (df['year'] >= 2025)).values
    adj[g2_mask] = ALPHA_G2 * adj[g2_mask] + BETA_DA * df['draft_advantage'].values[g2_mask]
    po_mask = df['playoffs'].values == 1
    if po_mask.any():
        bp = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['blue_team']])
        rp = np.array([TEAM_PO_ADJ.get(t, 0.0) for t in df['red_team']])
        adj[po_mask] += (bp - rp)[po_mask]
    yrs = df['year'].values
    for team, (from_year, bonus) in COACHING_ADJ.items():
        active = yrs >= from_year
        adj[(df['blue_team'].values == team) & active] += bonus
        adj[(df['red_team'].values  == team) & active] -= bonus
    return adj


def fit_predict(train, eval_df, features):
    m = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(train[features].fillna(FILL), train['blue_win'].values)
    s, lr = m.named_steps['s'], m.named_steps['lr']
    lo = s.transform(eval_df[features].fillna(FILL)) @ lr.coef_.ravel() + lr.intercept_[0]
    lo = apply_adjustments(lo, eval_df)
    return 1.0 / (1.0 + np.exp(-lo))


def main():
    df = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    ch = pd.read_csv(PROCESSED / 'champ_features.csv', low_memory=False)
    df = df.merge(ch, on='gameid', how='left')
    # Pull actual in-game gold-at-15 from games_with_odds.csv
    gw = pd.read_csv(PROCESSED / 'games_with_odds.csv', low_memory=False,
                       usecols=['gameid', 'blue_team_golddiffat15'])
    df = df.merge(gw, on='gameid', how='left')
    df['actual_gd15_diff'] = df['blue_team_golddiffat15']
    df = add_draft_advantage(df)
    print(f'Loaded {len(df):,} games. Non-null actual_gd15: {df["actual_gd15_diff"].notna().sum():,}')

    for label, sub in [('MAJOR LEAGUES (LCK/LPL/LEC/LCS)',
                        df[df['league'].isin(MAJOR)]),
                       ('MAJOR + TOURNAMENTS',
                        df[df['league'].isin(MAJOR + ['LTA','LTA N','LTA S','WLDs','MSI','EWC','FST'])])]:
        print(f'\n{"="*70}\n{label}\n{"="*70}')

        # Only evaluate games where actual_gd15 is populated (drops a few)
        sub = sub[sub['actual_gd15_diff'].notna()].copy()
        train = sub[sub['year'].isin([2024, 2025])]
        eval_df = sub[sub['year'] == 2026].copy()
        print(f'  train n={len(train):,}, eval n={len(eval_df):,}')

        eval_df['month'] = eval_df['date'].dt.to_period('M')
        months = sorted(eval_df['month'].unique())

        rows = []
        for m in months:
            in_mo  = eval_df[eval_df['month'] == m]
            before = eval_df[eval_df['month'] < m]
            train_set = pd.concat([train, before], ignore_index=True)
            if len(in_mo) < 2: continue
            y = in_mo['blue_win'].values
            try:
                p_pre  = fit_predict(train_set, in_mo, FEATS_PROD)
                p_post = fit_predict(train_set, in_mo, FEATS_PROD + FEATS_CHAMP)
                p_live = fit_predict(train_set, in_mo, FEATS_PROD + FEATS_CHAMP + FEATS_LIVE)
                rows.append({
                    'month': str(m), 'n': len(in_mo),
                    'pre':   log_loss(y, np.clip(p_pre,  1e-6, 1-1e-6)),
                    'post':  log_loss(y, np.clip(p_post, 1e-6, 1-1e-6)),
                    'live':  log_loss(y, np.clip(p_live, 1e-6, 1-1e-6)),
                })
            except ValueError:
                continue

        out = pd.DataFrame(rows)
        out['post_vs_pre']  = out['post'] - out['pre']
        out['live_vs_post'] = out['live'] - out['post']
        out['live_vs_pre']  = out['live'] - out['pre']
        print(out.to_string(index=False, float_format=lambda v: f'{v:.4f}'))

        def wmean(col):
            return (out[col] * out['n']).sum() / out['n'].sum()
        wp, wpo, wl = wmean('pre'), wmean('post'), wmean('live')
        print(f'\n  Weighted log loss across {out["n"].sum()} games:')
        print(f'    PRE_DRAFT      (PROD)              {wp:.4f}')
        print(f'    POST_DRAFT     (+ champ feats)     {wpo:.4f}  ({(wpo-wp)/wp*100:+.2f}%)')
        print(f'    IN_GAME_15     (+ actual gd@15)    {wl:.4f}  ({(wl-wp)/wp*100:+.2f}% vs pre, {(wl-wpo)/wpo*100:+.2f}% vs post)')


if __name__ == '__main__':
    main()
