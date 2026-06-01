"""Glicko-2 (player+team) + gd15 + team-PO-adj logistic regression.

Ports the LoLModelLab final winner (exp_team_po_adj_lr.py) to the production
data layout (games.csv with blue_/red_ schema). Walks chronologically through
all games, fits LR on 2022-2025, predicts on 2026+, writes per-gameid
predictions to data/processed/glicko_predictions.csv.

`upload_game_features.py` picks that CSV up and writes a `glicko_pred` column
to Supabase `game_features`. The /games explorer reads it as a second model
column.
"""
from __future__ import annotations

import math
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

ROOT       = Path(__file__).resolve().parent.parent
PROCESSED  = ROOT / 'data' / 'processed'
GAMES_CSV  = PROCESSED / 'games.csv'
OUTPUT_CSV = PROCESSED / 'glicko_predictions.csv'

POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']
SCALE = 173.7178
EPS = 1e-6

PLAYER_INIT_RD    = 250.0
PLAYER_INIT_SIGMA = 0.06
PLAYER_TAU        = 0.5
TEAM_INIT_RD      = 350.0
TEAM_INIT_SIGMA   = 0.06
TEAM_TAU          = 0.5

ROLL_N = 10; MIN_OBS_ROLL = 3
ALPHA_G2 = 0.897; G2_FROM_YEAR = 2025
TRAIN_YEARS = {2022, 2023, 2024, 2025}
MIN_PO_GAMES = 25; LR_C = 0.1

_ELO_TIER = {
    'LCK': 1620, 'LPL': 1620, 'LEC': 1500,
    'LCS': 1380, 'LTA': 1380, 'LTA N': 1380, 'LTA S': 1380, 'LLA': 1380,
    'VCS': 1260, 'PCS': 1260, 'LJL': 1260, 'CBLOL': 1260, 'LCP': 1260, 'LCO': 1260,
    'WLDs': 1500, 'MSI': 1500, 'EWC': 1500, 'FST': 1500,
}
def starting_elo(l): return _ELO_TIER.get(l, 1260)


def to_g2(r, rd): return (r - 1500.0)/SCALE, rd/SCALE
def from_g2(mu, phi): return mu*SCALE + 1500.0, phi*SCALE
def g(phi): return 1.0 / math.sqrt(1.0 + 3.0*phi*phi/(math.pi*math.pi))
def E(mu, mu_j, phi_j):
    x = -g(phi_j) * (mu - mu_j)
    if x > 30: return 1e-13
    if x < -30: return 1 - 1e-13
    return 1.0 / (1.0 + math.exp(x))


def _vol(sigma, phi, v, delta, tau):
    a = math.log(sigma*sigma)
    def f(x):
        ex = math.exp(x)
        return ex*(delta*delta - phi*phi - v - ex)/(2.0*(phi*phi+v+ex)**2) - (x-a)/(tau*tau)
    A = a
    if delta*delta > phi*phi + v: B = math.log(delta*delta - phi*phi - v)
    else:
        k = 1
        while f(a - k*tau) < 0:
            k += 1
            if k > 100: break
        B = a - k*tau
    fA, fB = f(A), f(B)
    for _ in range(100):
        if abs(B - A) <= EPS: break
        C = A + (A - B)*fA/(fB - fA); fC = f(C)
        if fC*fB <= 0: A, fA = B, fB
        else: fA /= 2.0
        B, fB = C, fC
    return math.exp(A/2.0)


def upd(r, rd, sigma, opp_r, opp_rd, score, tau):
    mu, phi = to_g2(r, rd); om, op_ = to_g2(opp_r, opp_rd)
    e = E(mu, om, op_); gphi = g(op_)
    v = 1.0/(gphi*gphi*e*(1.0-e)); di = gphi*(score-e); delta = v*di
    new_sigma = _vol(sigma, phi, v, delta, tau)
    phi_star = math.sqrt(phi*phi + new_sigma*new_sigma)
    new_phi = 1.0/math.sqrt(1.0/(phi_star*phi_star) + 1.0/v)
    return from_g2(mu + new_phi*new_phi*di, new_phi) + (new_sigma,)


def build_features(records):
    """Walk games chronologically. Emit per-game features using state BEFORE
    each game, then update state with the result.

    Note: blue/red side alternates within a series. team-state is keyed by
    team-name (not side), so a team's rating carries between blue and red
    games correctly."""
    p_state, t_state = {}, {}
    gd15 = defaultdict(lambda: deque(maxlen=ROLL_N))
    rows = []
    for (gameid, year, blue_team, red_team, blue_players, red_players,
         blue_won, gd15_blue, gd15_red, league, playoffs, gnum) in records:
        p_init = (starting_elo(league), PLAYER_INIT_RD, PLAYER_INIT_SIGMA)
        t_init = (starting_elo(league), TEAM_INIT_RD,   TEAM_INIT_SIGMA)
        s1pl = [p_state.get(p, p_init) for p in blue_players]
        s2pl = [p_state.get(p, p_init) for p in red_players]
        s1tm = t_state.get(blue_team, t_init); s2tm = t_state.get(red_team, t_init)
        m1p = [to_g2(r, rd)[0] for (r,rd,_) in s1pl]; ph1p = [to_g2(r, rd)[1] for (r,rd,_) in s1pl]
        m2p = [to_g2(r, rd)[0] for (r,rd,_) in s2pl]; ph2p = [to_g2(r, rd)[1] for (r,rd,_) in s2pl]
        mu1p = sum(m1p)/5; mu2p = sum(m2p)/5
        phi1p = math.sqrt(sum(p*p for p in ph1p)/5); phi2p = math.sqrt(sum(p*p for p in ph2p)/5)
        mu1t, phi1t = to_g2(s1tm[0], s1tm[1]); mu2t, phi2t = to_g2(s2tm[0], s2tm[1])
        w1p, w1t = 1.0/(phi1p**2), 1.0/(phi1t**2); w2p, w2t = 1.0/(phi2p**2), 1.0/(phi2t**2)
        mu_blue = (w1p*mu1p + w1t*mu1t)/(w1p+w1t)
        mu_red  = (w2p*mu2p + w2t*mu2t)/(w2p+w2t)

        rows.append({
            'gameid': gameid, 'year': year, 'league': league, 'playoffs': int(playoffs),
            'game': int(gnum) if not pd.isna(gnum) else 1,
            'blue_team': blue_team, 'red_team': red_team, 'actual': blue_won,
            'glicko_diff': mu_blue - mu_red,
            'gd15_diff': ((sum(gd15[blue_team])/len(gd15[blue_team])) if len(gd15[blue_team])>=MIN_OBS_ROLL else 0.0)
                       - ((sum(gd15[red_team])/len(gd15[red_team])) if len(gd15[red_team])>=MIN_OBS_ROLL else 0.0),
        })

        # Update state (only if game has a known result)
        if blue_won is None: continue
        r2t, rd2t = from_g2(mu_red, 1.0/math.sqrt(w2p+w2t))
        r1t, rd1t = from_g2(mu_blue, 1.0/math.sqrt(w1p+w1t))
        for p, (r, rd, s) in zip(blue_players, s1pl):
            p_state[p] = upd(r, rd, s, r2t, rd2t, float(blue_won), PLAYER_TAU)
        for p, (r, rd, s) in zip(red_players, s2pl):
            p_state[p] = upd(r, rd, s, r1t, rd1t, float(1-blue_won), PLAYER_TAU)
        t_state[blue_team] = upd(s1tm[0], s1tm[1], s1tm[2], r2t, rd2t, float(blue_won), TEAM_TAU)
        t_state[red_team]  = upd(s2tm[0], s2tm[1], s2tm[2], r1t, rd1t, float(1-blue_won), TEAM_TAU)
        if not pd.isna(gd15_blue): gd15[blue_team].append(float(gd15_blue))
        if not pd.isna(gd15_red):  gd15[red_team].append(float(gd15_red))
    return pd.DataFrame(rows)


def main():
    print(f'Loading {GAMES_CSV.name}...')
    df = pd.read_csv(GAMES_CSV, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True, errors='coerce')
    df = df[df['date'].notna()].sort_values('date').reset_index(drop=True)
    df['year'] = df['date'].dt.year

    records = []
    for g_ in df.itertuples(index=False):
        bps = [getattr(g_, f'blue_{p}_playername') for p in POSITIONS]
        rps = [getattr(g_, f'red_{p}_playername')  for p in POSITIONS]
        if any(pd.isna(x) for x in bps + rps): continue
        gameid = str(g_.gameid)
        blue_team = str(g_.blue_team_teamname); red_team = str(g_.red_team_teamname)
        blue_won = (int(g_.blue_team_result) if not pd.isna(g_.blue_team_result) else None)
        gd_b = getattr(g_, 'blue_team_golddiffat15', None)
        gd_r = getattr(g_, 'red_team_golddiffat15', None)
        records.append((gameid, g_.year, blue_team, red_team, bps, rps, blue_won,
                        gd_b, gd_r, str(g_.league), getattr(g_, 'playoffs', 0),
                        getattr(g_, 'game', 1)))
    print(f'records: {len(records):,}')

    feats = build_features(records)
    print(f'features built: {len(feats):,} rows')

    # Per-team playoff adjustment (only from 2022-2025 training period)
    train_mask = feats['year'].isin(TRAIN_YEARS) & feats['actual'].notna()
    po_train = feats[train_mask & (feats['playoffs'] == 1)]
    counts = defaultdict(int)
    for _, r in po_train.iterrows(): counts[r['blue_team']] += 1; counts[r['red_team']] += 1
    eligible = sorted([t for t, n in counts.items() if n >= MIN_PO_GAMES])
    print(f'eligible playoff teams (≥{MIN_PO_GAMES} train games): {len(eligible)}')

    for t in eligible: feats[f'po_{t}'] = 0.0
    po_idx = feats['playoffs'] == 1
    for i, r in feats[po_idx].iterrows():
        if r['blue_team'] in eligible: feats.at[i, f'po_{r["blue_team"]}'] = 1.0
        if r['red_team']  in eligible: feats.at[i, f'po_{r["red_team"]}']  = -1.0

    all_cols = ['glicko_diff', 'gd15_diff'] + [f'po_{t}' for t in eligible]

    # Train LR on 2022-2025 games where we have a result
    train_idx = train_mask.values
    X_tr = feats.loc[train_idx, all_cols].values.astype(float)
    y_tr = feats.loc[train_idx, 'actual'].values.astype(int)
    sc = StandardScaler(with_mean=True, with_std=False).fit(X_tr)
    lr = LogisticRegression(C=LR_C, max_iter=10000, solver='lbfgs').fit(sc.transform(X_tr), y_tr)
    print(f'trained on {train_idx.sum():,} games')

    # Predict for ALL games (training period included — they'll be in-sample)
    X = feats[all_cols].values.astype(float)
    logit = lr.decision_function(sc.transform(X))
    # G2 alpha damp: game-2 of a series, 2025+
    m = (feats['game'] == 2) & (feats['year'] >= G2_FROM_YEAR)
    logit = logit.copy(); logit[m.values] *= ALPHA_G2
    feats['glicko_pred'] = 1.0 / (1.0 + np.exp(-logit))

    # Save just gameid + glicko_pred
    out = feats[['gameid', 'glicko_pred']].copy()
    out['glicko_pred'] = out['glicko_pred'].round(6)
    out.to_csv(OUTPUT_CSV, index=False)
    print(f'wrote {len(out):,} rows → {OUTPUT_CSV}')


if __name__ == '__main__':
    main()
