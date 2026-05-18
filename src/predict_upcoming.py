"""
predict_upcoming.py
Fetches upcoming LCK/LEC matches from Leaguepedia, infers current rosters
from the last known OE game per team, applies current ELO state, and
generates model predictions for games not yet played.

Output: data/processed/upcoming_predictions.csv
"""

import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from supabase import create_client

load_dotenv(Path(os.path.dirname(__file__)) / '..' / '.env')

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'

POSITIONS      = ['top', 'jng', 'mid', 'bot', 'sup']
TARGET_LEAGUES = {'LCK', 'LEC'}
_ELO_TIER      = {'LCK': 1620, 'LPL': 1620, 'LEC': 1500,
                  'LCS': 1380, 'LTA': 1380, 'LTA N': 1380, 'LTA S': 1380, 'LCKC': 1380}

FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FILL  = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5,
         'playoffs': 0, 'gd15_diff': 0.0, 'outperf_diff': 0.0}

# Match any 2026 LCK or LEC tab (avoids hardcoding split names)
LEAGUEPEDIA_TAB_FILTER = "(Tab LIKE '%LCK/2026%' OR Tab LIKE '%LEC/2026%')"

# Team name normalisation: Leaguepedia → OE canonical
_TEAM_NORM = {
    'Kiwoom DRX':      'Kiwoom DRX',
    'DRX':             'Kiwoom DRX',
    'Gen.G':           'Gen.G',
    'T1':              'T1',
    'KT Rolster':      'KT Rolster',
    'Hanwha Life Esports': 'Hanwha Life Esports',
    'BNK FEARX':       'BNK FEARX',
    'Nongshim RedForce': 'Nongshim RedForce',
    'DN SOOPers':      'DN SOOPers',
    'G2 Esports':      'G2 Esports',
    'Fnatic':          'Fnatic',
    'Team Vitality':   'Team Vitality',
    'Karmine Corp':    'Karmine Corp',
    'Movistar KOI':    'Movistar KOI',
    'Natus Vincere':   'Natus Vincere',
    'SK Gaming':       'SK Gaming',
    'GiantX':          'GiantX',
    'Shifters':        'Shifters',
}


def _norm_team(name: str) -> str:
    return _TEAM_NORM.get(name.strip(), name.strip())


def _starting_elo(league: str) -> float:
    return _ELO_TIER.get(league, 1260)


def fetch_upcoming(days_ahead: int = 14) -> pd.DataFrame:
    """Query Leaguepedia for upcoming LCK/LEC matches."""
    now = pd.Timestamp.utcnow()
    cutoff = now + pd.Timedelta(days=days_ahead)
    params = {
        'action':  'cargoquery',
        'tables':  'MatchSchedule',
        'fields':  'Team1,Team2,DateTime_UTC,BestOf,Tab,Winner',
        'where':   f"DateTime_UTC > '{now.strftime('%Y-%m-%d %H:%M:%S')}' "
                   f"AND DateTime_UTC < '{cutoff.strftime('%Y-%m-%d %H:%M:%S')}' "
                   f"AND {LEAGUEPEDIA_TAB_FILTER}",
        'limit':   '100',
        'format':  'json',
    }

    for attempt in range(5):
        try:
            r = requests.get(
                'https://lol.fandom.com/api.php', params=params,
                headers={'User-Agent': 'LoLMLAnalysis/1.0'}, timeout=15
            )
            data = r.json()
            if 'cargoquery' in data:
                rows = [d['title'] for d in data['cargoquery']]
                if not rows:
                    print("  No results — schedule may not be posted yet")
                    return pd.DataFrame()
                df = pd.DataFrame(rows)
                df['DateTime_UTC'] = pd.to_datetime(df['DateTime_UTC'], utc=True, errors='coerce')
                # Drop completed games (Winner already set)
                df = df[df['Winner'].isna() | (df['Winner'] == '')]
                df['league'] = df['Tab'].str.split('/').str[0]
                print(f"  Found tabs: {df['Tab'].unique().tolist()}")
                return df
            if 'error' in data and data['error']['code'] == 'ratelimited':
                print(f"Rate limited, waiting 30s (attempt {attempt+1}/5)...")
                time.sleep(30)
            else:
                print(f"Unexpected API response: {data}")
                break
        except Exception as e:
            print(f"Request error: {e}")
            time.sleep(10)

    return pd.DataFrame()


def load_state() -> tuple[dict, dict, pd.DataFrame]:
    """Load ELO state, roster state, and training features."""
    with open(PROCESSED_DIR / 'elo_state.json') as f:
        elo_state = json.load(f)
    with open(PROCESSED_DIR / 'roster_state.json') as f:
        roster_state = json.load(f)
    features = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    features['date'] = pd.to_datetime(features['date'], utc=True)
    return elo_state['elo_map'], roster_state, features


def train_model(features: pd.DataFrame) -> Pipeline:
    train = features[features['year'].isin([2024, 2025])]
    m = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    m.fit(train[FEATS].fillna(FILL), train['blue_win'].values)
    return m


def predict_game(blue_team: str, red_team: str, league: str,
                 elo_map: dict, roster_state: dict,
                 features: pd.DataFrame, model: Pipeline) -> dict | None:
    """Generate a pre-game prediction for one upcoming match."""
    blue_players = roster_state.get(blue_team)
    red_players  = roster_state.get(red_team)

    if not blue_players or not red_players:
        print(f"  No roster found for {blue_team} or {red_team}")
        return None

    start = _starting_elo(league)
    blue_elos = [elo_map.get(p, start) for p in blue_players]
    red_elos  = [elo_map.get(p, start) for p in red_players]
    elo_diff  = float(np.mean(blue_elos) - np.mean(red_elos))

    # Pull latest rolling features from last known game for each team
    def latest_feat(team, col):
        rows = features[(features['blue_team'] == team) | (features['red_team'] == team)]
        if rows.empty:
            return np.nan
        last = rows.iloc[-1]
        if last['blue_team'] == team:
            return last[col]
        # flip sign for diff features when team was on red side
        flip_cols = {'rwr_diff', 'h2h_wr', 'gd15_diff', 'outperf_diff'}
        if col in flip_cols:
            return -last[col] if not pd.isna(last[col]) else np.nan
        return last[col]

    rwr_diff     = latest_feat(blue_team, 'rwr_diff')   # approximate
    h2h_wr       = latest_feat(blue_team, 'h2h_wr')
    gd15_diff    = latest_feat(blue_team, 'gd15_diff')
    outperf_diff = latest_feat(blue_team, 'outperf_diff')

    row = pd.DataFrame([{
        'elo_diff':     elo_diff,
        'rwr_diff':     rwr_diff,
        'h2h_wr':       h2h_wr,
        'playoffs':     0,
        'gd15_diff':    gd15_diff,
        'outperf_diff': outperf_diff,
    }])
    pred = float(model.predict_proba(row.fillna(FILL))[:, 1][0])

    return {
        'blue_team':    blue_team,
        'red_team':     red_team,
        'league':       league,
        'blue_elo':     round(np.mean(blue_elos), 1),
        'red_elo':      round(np.mean(red_elos), 1),
        'elo_diff':     round(elo_diff, 1),
        'pred_blue_win': round(pred, 4),
    }


def run():
    print("Loading ELO + roster state...")
    elo_map, roster_state, features = load_state()

    print("Training model on 2024-2025...")
    model = train_model(features)

    print("Fetching upcoming matches from Leaguepedia...")
    upcoming = fetch_upcoming(days_ahead=14)

    if upcoming.empty:
        print("No upcoming matches found.")
        return

    print(f"Found {len(upcoming)} upcoming games\n")

    results = []
    for _, row in upcoming.iterrows():
        blue = _norm_team(row['Team1'])
        red  = _norm_team(row['Team2'])
        league = row['league']
        dt = row['DateTime_UTC']

        pred = predict_game(blue, red, league, elo_map, roster_state, features, model)
        if pred:
            pred['date'] = dt.isoformat()
            results.append(pred)
            print(f"  {dt.strftime('%m-%d %H:%M')} UTC  {blue:<25} vs {red:<25}  "
                  f"pred_blue={pred['pred_blue_win']:.3f}  elo_diff={pred['elo_diff']:+.0f}")

    if not results:
        print("No predictions generated.")
        return

    out = pd.DataFrame(results)
    out.to_csv(PROCESSED_DIR / 'upcoming_predictions.csv', index=False)
    print(f"\nSaved {len(out)} predictions to upcoming_predictions.csv")

    # Upload to Supabase
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_KEY')
    if supabase_url and supabase_key:
        print("Uploading to Supabase...")
        client = create_client(supabase_url, supabase_key)
        client.table('upcoming_predictions').delete().neq('blue_team', '').execute()
        records = out.to_dict(orient='records')
        for i in range(0, len(records), 100):
            client.table('upcoming_predictions').insert(records[i:i+100]).execute()
        print(f"Uploaded {len(records)} upcoming predictions.")


if __name__ == '__main__':
    run()
