"""
export_model_params.py

Exports model parameters and per-team stats to web/public/model_params.json
so the series probability calculator can run entirely client-side.

Usage:
    python src/export_model_params.py
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
OUT       = ROOT / 'web' / 'public' / 'model_params.json'

FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FILL  = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5,
         'playoffs': 0, 'gd15_diff': 0.0, 'outperf_diff': 0.0}

ALPHA_G2 = 0.8970
BETA_DA  = 0.0929

_ELO_TIER = {
    'LCK': 1620, 'LPL': 1620, 'LEC': 1500,
    'LCS': 1380, 'LTA': 1380, 'LTA N': 1380, 'LTA S': 1380, 'LCKC': 1380,
}

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

GD15_ROLL  = 5
OUTPERF_N  = 5
POSITIONS  = ['top', 'jng', 'mid', 'bot', 'sup']


def _starting_elo(league: str) -> float:
    return _ELO_TIER.get(league, 1260)


def train_model(features: pd.DataFrame) -> Pipeline:
    train   = features[features['year'].isin([2024, 2025])]
    X_train = train[FEATS].fillna(FILL)
    y_train = train['blue_win'].values
    model   = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(X_train, y_train)
    return model


def _team_rwr(team: str, features: pd.DataFrame) -> float | None:
    mask = (features['blue_team'] == team) | (features['red_team'] == team)
    rows = features[mask].dropna(subset=['blue_rwr', 'red_rwr'])
    if rows.empty:
        return None
    last = rows.iloc[-1]
    return float(last['blue_rwr']) if last['blue_team'] == team else float(last['red_rwr'])


def _team_gd15(players: list, player_gd15: dict) -> float | None:
    vals = []
    for p in players:
        hist = player_gd15.get(p, [])
        if len(hist) >= 2:
            vals.append(float(np.mean(hist[-GD15_ROLL:])))
    return float(np.nanmean(vals)) if vals else None


def _team_outperf(team: str, team_outperf: dict, staleness: dict) -> float | None:
    if staleness.get(team, 0) >= OUTPERF_N:
        return None
    hist = team_outperf.get(team, [])
    if len(hist) < 3:
        return None
    return float(np.mean(hist[-OUTPERF_N:]))


def _team_elo(team: str, elo_map: dict, roster_state: dict, league_hint: str = 'LCK') -> float | None:
    players = roster_state.get(team)
    if not players:
        return None
    start = _starting_elo(league_hint)
    elos  = [elo_map.get(p, start) for p in players]
    return round(float(np.mean(elos)), 1)


def _matchup_h2h_wr(t1: str, t2: str, features: pd.DataFrame) -> float | None:
    mask = (
        ((features['blue_team'] == t1) & (features['red_team'] == t2)) |
        ((features['blue_team'] == t2) & (features['red_team'] == t1))
    )
    rows = features[mask].dropna(subset=['h2h_wr'])
    if len(rows) < 2:
        return None
    last = rows.iloc[-1]
    if last['blue_team'] == t1:
        return round(float(last['h2h_wr']), 4)
    return round(1.0 - float(last['h2h_wr']), 4)


def _team_league(team: str, features: pd.DataFrame) -> str:
    mask = (features['blue_team'] == team) | (features['red_team'] == team)
    rows = features[mask].dropna(subset=['league'])
    if rows.empty:
        return 'LCK'
    return str(rows.iloc[-1]['league'])


def main():
    print("Loading state…")
    with open(PROCESSED / 'elo_state.json') as f:
        elo_state = json.load(f)
    with open(PROCESSED / 'roster_state.json') as f:
        roster_state = json.load(f)
    with open(PROCESSED / 'fe_checkpoint.json') as f:
        ckpt = json.load(f)

    # Train the logistic-regression model on the MAJOR-leagues feature file
    # IMPORTANT: train on the SAME dataset as upload_game_features.py
    # (features_all.csv, all leagues) so /predict's coefficients match the
    # game_features.model_pred shown on /games. Previously this used the
    # filtered features.csv, producing a different LR — meaning /predict
    # and /games disagreed by ~3pp on every game.
    features_train = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    features_train['date'] = pd.to_datetime(features_train['date'], utc=True)

    # But for the team enumeration / per-team stats (ELO, roster, gd15, etc.)
    # we want EVERY 2026 team — including LCS — so the /calculator page can
    # let the user pick any team. Load features_all.csv for that lookup.
    features = pd.read_csv(PROCESSED / 'features_all.csv', low_memory=False)
    features['date'] = pd.to_datetime(features['date'], utc=True)

    print("Training model…")
    model = train_model(features_train)
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']

    elo_map   = elo_state['elo_map']

    overrides_path = PROCESSED / 'elo_overrides.json'
    if overrides_path.exists():
        with open(overrides_path) as f:
            _overrides = json.load(f)
        for player, data in _overrides.items():
            elo_map[player] = data['elo'] if isinstance(data, dict) else data
        if _overrides:
            print(f"Applied {len(_overrides)} ELO override(s): {', '.join(_overrides)}")

    player_gd15  = ckpt.get('player_gd15', {})
    team_outperf_hist = ckpt.get('team_outperf', {})
    team_outperf_staleness = ckpt.get('team_outperf_staleness', {})

    # Collect all teams that appear in 2026 data
    print(f"  diag: features_all rows: {len(features):,}; columns: {list(features.columns)[:8]}…")
    print(f"  diag: features year distribution: {features['year'].value_counts().to_dict()}")
    if 'league' in features.columns:
        print(f"  diag: features 2026 leagues: {features[features['year']==2026]['league'].value_counts().to_dict()}")
    recent = features[features['year'] == 2026]
    teams_2026 = sorted(set(recent['blue_team'].dropna()) | set(recent['red_team'].dropna()))

    print(f"Computing per-team stats for {len(teams_2026)} teams…")
    print(f"  diag: teams_2026 sample: {teams_2026[:10]}")
    team_stats = {}
    for team in teams_2026:
        league = _team_league(team, features)
        elo    = _team_elo(team, elo_map, roster_state, league)
        rwr    = _team_rwr(team, features)
        players = roster_state.get(team, [])
        gd15   = _team_gd15(players, player_gd15)
        outperf = _team_outperf(team, team_outperf_hist, team_outperf_staleness)
        team_stats[team] = {
            'league':  league,
            'elo':     elo,
            'rwr':     round(rwr, 4) if rwr is not None else None,
            'gd15':    round(gd15, 2) if gd15 is not None else None,
            'outperf': round(outperf, 4) if outperf is not None else None,
            'po_adj':  TEAM_PO_ADJ.get(team, 0.0),
            'coaching_adj': (COACHING_ADJ[team][1]
                             if team in COACHING_ADJ and 2026 >= COACHING_ADJ[team][0]
                             else 0.0),
        }

    # Rosters for 2026 teams (top/jng/mid/bot/sup order)
    rosters: dict[str, list[str]] = {}
    for team in teams_2026:
        players = roster_state.get(team, [])
        if players:
            rosters[team] = players

    # Precompute pairwise h2h records — single pass over features instead of
    # O(N²) DataFrame scans (used to take ~6 min for ~600 teams).
    print("Computing team h2h records…")
    h2h: dict[str, float] = {}
    teams_2026_set = set(teams_2026)
    f = features.dropna(subset=['h2h_wr']).copy()
    # Restrict to matchups where BOTH teams are in the 2026 universe
    f = f[f['blue_team'].isin(teams_2026_set) & f['red_team'].isin(teams_2026_set)]
    # Last row per unordered team-pair → that's the most recent h2h snapshot
    # for that matchup. The h2h_wr stored on a row is from the BLUE team's
    # perspective; we always key the dict on (t1, t2) where t1 < t2, with
    # h2h_wr re-oriented to t1's perspective.
    f['_t1'] = f[['blue_team', 'red_team']].min(axis=1)
    f['_t2'] = f[['blue_team', 'red_team']].max(axis=1)
    last_per_pair = f.groupby(['_t1', '_t2'], sort=False).tail(1)
    for _, row in last_per_pair.iterrows():
        t1, t2 = row['_t1'], row['_t2']
        wr = float(row['h2h_wr'])
        # Re-orient: stored wr is from blue's perspective; we want it from t1's
        if row['blue_team'] != t1:
            wr = 1.0 - wr
        h2h[f"{t1}|||{t2}"] = round(wr, 4)

    # Player H2H — filtered to only current roster players
    print("Filtering player h2h to 2026 roster players…")
    player_h2h_path = PROCESSED / 'player_h2h.json'
    player_h2h_out: dict = {}
    if player_h2h_path.exists():
        with open(player_h2h_path) as f:
            raw_ph2h = json.load(f)
        active_players: set[str] = set()
        for players in rosters.values():
            active_players.update(players)
        for key, val in raw_ph2h.items():
            parts = key.split('|||')
            if len(parts) == 3 and parts[0] in active_players and parts[1] in active_players:
                player_h2h_out[key] = val
    print(f"  {len(player_h2h_out)} player h2h pairs for {len(active_players)} active players")

    # Per-player ELO for active roster players only
    active_players_all: set[str] = set()
    for players in rosters.values():
        active_players_all.update(players)
    player_elos_out = {
        p: round(float(elo_map[p]), 1)
        for p in active_players_all
        if p in elo_map
    }

    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'features':  FEATS,
        'fill':      FILL,
        'scaler': {
            'mean':  [round(v, 8) for v in scaler.mean_.tolist()],
            'scale': [round(v, 8) for v in scaler.scale_.tolist()],
        },
        'coef':       [round(v, 8) for v in lr.coef_[0].tolist()],
        'intercept':  round(float(lr.intercept_[0]), 8),
        'alpha_g2':   ALPHA_G2,
        'beta_da':    BETA_DA,
        'team_po_adj':    TEAM_PO_ADJ,
        'coaching_adj':   COACHING_ADJ,
        'teams':      team_stats,
        'rosters':    rosters,
        'h2h':        h2h,
        'player_h2h': player_h2h_out,
        'player_elos': player_elos_out,
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    size_kb = OUT.stat().st_size // 1024
    print(f"Wrote {OUT}  ({len(team_stats)} teams, {len(h2h)} h2h pairs, {len(player_h2h_out)} player h2h, {len(player_elos_out)} player elos, {size_kb}KB)")


if __name__ == '__main__':
    main()
