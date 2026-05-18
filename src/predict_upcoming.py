"""
predict_upcoming.py
Fetches upcoming LCK/LEC matches from the lolesports.com schedule API,
infers current rosters from the last known OE game per team, applies
current ELO state, and generates model predictions for games not yet played.

Output: data/processed/upcoming_predictions.csv
"""

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from supabase import create_client

load_dotenv(Path(os.path.dirname(__file__)) / '..' / '.env')

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'

POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']
_ELO_TIER = {'LCK': 1620, 'LPL': 1620, 'LEC': 1500,
              'LCS': 1380, 'LTA': 1380, 'LTA N': 1380, 'LTA S': 1380, 'LCKC': 1380}

FEATS    = ['elo_diff', 'rwr_diff', 'h2h_wr', 'playoffs', 'gd15_diff', 'outperf_diff']
FILL     = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5,
            'playoffs': 0, 'gd15_diff': 0.0, 'outperf_diff': 0.0}
MODEL_NAME = 'Logistic Regression'

# lolesports.com schedule API
_LS_URL     = 'https://esports-api.lolesports.com/persisted/gw/getSchedule'
_LS_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
_LS_LEAGUES = {
    'LCK': '98767991310872058',
    'LEC': '98767991302996019',
}

# Team name normalisation: lolesports display name → OE canonical
_TEAM_NORM = {
    # LCK
    'T1':                       'T1',
    'Gen.G':                    'Gen.G',
    'Gen.G Esports':            'Gen.G',
    'KT Rolster':               'KT Rolster',
    'kt Rolster':               'KT Rolster',
    'Hanwha Life Esports':      'Hanwha Life Esports',
    'Kiwoom DRX':               'Kiwoom DRX',
    'KIWOOM DRX':               'Kiwoom DRX',
    'DRX':                      'Kiwoom DRX',
    'BNK FearX':                'BNK FEARX',
    'BNK FEARX':                'BNK FEARX',
    'Nongshim RedForce':        'Nongshim RedForce',
    'NONGSHIM RED FORCE':       'Nongshim RedForce',
    'DN Freecs':                'DN SOOPers',
    'DN SOOPers':               'DN SOOPers',
    'Dplus KIA':                'Dplus Kia',
    'Dplus Kia':                'Dplus Kia',
    'HANJIN BRION':             'HANJIN BRION',
    'OK BRION':                 'HANJIN BRION',
    # LEC
    'G2 Esports':               'G2 Esports',
    'Fnatic':                   'Fnatic',
    'Team Vitality':            'Team Vitality',
    'Karmine Corp':             'Karmine Corp',
    'Movistar KOI':             'Movistar KOI',
    'Natus Vincere':            'Natus Vincere',
    'SK Gaming':                'SK Gaming',
    'GiantX':                   'GiantX',
    'GIANTX':                   'GiantX',
    'Team Heretics':            'Team Heretics',
    'Shifters':                 'Shifters',
}


def _norm_team(name: str) -> str:
    return _TEAM_NORM.get(name.strip(), name.strip())


def _starting_elo(league: str) -> float:
    return _ELO_TIER.get(league, 1260)


def fetch_upcoming(days_ahead: int = 14) -> pd.DataFrame:
    """Query the lolesports schedule API for upcoming LCK/LEC matches."""
    now    = pd.Timestamp.now('UTC')
    cutoff = now + pd.Timedelta(days=days_ahead)
    rows   = []

    for league, league_id in _LS_LEAGUES.items():
        page_token = None
        while True:
            params = {'hl': 'en-US', 'leagueId': league_id}
            if page_token:
                params['pageToken'] = page_token

            try:
                r = requests.get(
                    _LS_URL, params=params,
                    headers={'x-api-key': _LS_API_KEY},
                    timeout=15,
                )
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                print(f"  Error fetching {league} schedule: {e}")
                break

            schedule = data.get('data', {}).get('schedule', {})
            events   = schedule.get('events', [])

            past_window = False
            for event in events:
                if event.get('type') != 'match':
                    continue

                start = pd.Timestamp(event['startTime'])

                if start > cutoff:
                    past_window = True
                    break

                if event.get('state') != 'unstarted' or start <= now:
                    continue

                match = event.get('match', {})
                teams = match.get('teams', [])
                if len(teams) < 2:
                    continue

                rows.append({
                    'Team1':        teams[0]['name'],
                    'Team2':        teams[1]['name'],
                    'DateTime_UTC': start,
                    'BestOf':       int(match.get('strategy', {}).get('count', 1)),
                    'league':       league,
                })

            newer = schedule.get('pages', {}).get('newer')
            if newer and not past_window:
                page_token = newer
            else:
                break

    if not rows:
        print("  No upcoming matches found in the lolesports schedule.")
        return pd.DataFrame()

    df = pd.DataFrame(rows).sort_values('DateTime_UTC').reset_index(drop=True)
    print(f"  Found {len(df)} upcoming games across {df['league'].nunique()} league(s)")
    return df


def load_state() -> tuple[dict, dict, pd.DataFrame]:
    with open(PROCESSED_DIR / 'elo_state.json') as f:
        elo_state = json.load(f)
    with open(PROCESSED_DIR / 'roster_state.json') as f:
        roster_state = json.load(f)
    features = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    features['date'] = pd.to_datetime(features['date'], utc=True)
    return elo_state['elo_map'], roster_state, features


def train_model(features: pd.DataFrame) -> tuple[Pipeline, np.ndarray | None]:
    """Returns (fitted pipeline, inverse Fisher information matrix)."""
    train      = features[features['year'].isin([2024, 2025])]
    X_train    = train[FEATS].fillna(FILL)
    y_train    = train['blue_win'].values

    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(X_train, y_train)

    fim_inv = _compute_fim_inv(model, X_train)
    return model, fim_inv


def _compute_fim_inv(model: Pipeline, X_train: pd.DataFrame) -> np.ndarray | None:
    """
    Inverse Fisher information matrix for the logistic regression fit.
    Used to compute standard errors of predicted probabilities via the delta method.
    """
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']

    X_sc   = scaler.transform(X_train)
    p      = lr.predict_proba(X_sc)[:, 1]
    W      = p * (1 - p)

    # Augment with intercept column
    X_aug  = np.column_stack([np.ones(len(X_sc)), X_sc])
    FIM    = X_aug.T @ (W[:, None] * X_aug)

    try:
        return np.linalg.inv(FIM)
    except np.linalg.LinAlgError:
        return None


def _pred_se(model: Pipeline, fim_inv: np.ndarray | None, row_filled: pd.DataFrame) -> float:
    """
    Standard error of the predicted blue-win probability at a given feature vector,
    using the delta method: SE(p) ≈ p(1-p) · sqrt(x'·FIM⁻¹·x).
    """
    if fim_inv is None:
        return float('nan')

    scaler = model.named_steps['s']
    X_sc   = scaler.transform(row_filled)
    x_aug  = np.hstack([[1.0], X_sc[0]])
    var_z  = float(x_aug @ fim_inv @ x_aug)
    p      = float(model.predict_proba(row_filled)[:, 1][0])
    return round(p * (1 - p) * np.sqrt(max(0.0, var_z)), 4)


def predict_game(blue_team: str, red_team: str, league: str,
                 elo_map: dict, roster_state: dict, features: pd.DataFrame,
                 model: Pipeline, fim_inv: np.ndarray | None) -> dict | None:
    blue_players = roster_state.get(blue_team)
    red_players  = roster_state.get(red_team)

    if not blue_players or not red_players:
        print(f"  No roster found for {blue_team} or {red_team}")
        return None

    start     = _starting_elo(league)
    blue_elos = [elo_map.get(p, start) for p in blue_players]
    red_elos  = [elo_map.get(p, start) for p in red_players]
    elo_diff  = float(np.mean(blue_elos) - np.mean(red_elos))

    def latest_feat(team, col):
        mask      = (features['blue_team'] == team) | (features['red_team'] == team)
        team_rows = features[mask]
        if team_rows.empty:
            return np.nan
        last = team_rows.iloc[-1]
        if last['blue_team'] == team:
            return last[col]
        if col in {'rwr_diff', 'h2h_wr', 'gd15_diff', 'outperf_diff'}:
            return -last[col] if not pd.isna(last[col]) else np.nan
        return last[col]

    rwr_diff     = latest_feat(blue_team, 'rwr_diff')
    h2h_wr       = latest_feat(blue_team, 'h2h_wr')
    gd15_diff    = latest_feat(blue_team, 'gd15_diff')
    outperf_diff = latest_feat(blue_team, 'outperf_diff')

    row_filled = pd.DataFrame([{
        'elo_diff':     elo_diff,
        'rwr_diff':     rwr_diff,
        'h2h_wr':       h2h_wr,
        'playoffs':     0,
        'gd15_diff':    gd15_diff,
        'outperf_diff': outperf_diff,
    }]).fillna(FILL)

    pred = float(model.predict_proba(row_filled)[:, 1][0])
    se   = _pred_se(model, fim_inv, row_filled)

    return {
        'blue_team':     blue_team,
        'red_team':      red_team,
        'league':        league,
        'blue_elo':      round(float(np.mean(blue_elos)), 1),
        'red_elo':       round(float(np.mean(red_elos)), 1),
        'elo_diff':      round(elo_diff, 1),
        'pred_blue_win': round(pred, 4),
        'pred_se':       se,
        'model_name':    MODEL_NAME,
    }


def run():
    print("Loading ELO + roster state...")
    elo_map, roster_state, features = load_state()

    print("Training model on 2024-2025...")
    model, fim_inv = train_model(features)

    print("Fetching upcoming matches from lolesports...")
    upcoming = fetch_upcoming(days_ahead=14)

    if upcoming.empty:
        print("No upcoming matches found.")
        return

    results = []
    for _, row in upcoming.iterrows():
        blue   = _norm_team(row['Team1'])
        red    = _norm_team(row['Team2'])
        league = row['league']
        dt     = row['DateTime_UTC']
        best_of = int(row['BestOf'])

        pred = predict_game(blue, red, league, elo_map, roster_state, features, model, fim_inv)
        if pred:
            pred['date']    = dt.isoformat()
            pred['best_of'] = best_of
            results.append(pred)
            print(f"  {dt.strftime('%m-%d %H:%M')} UTC  {blue:<25} vs {red:<25}  "
                  f"pred_blue={pred['pred_blue_win']:.3f} ±{pred['pred_se']:.3f}  "
                  f"elo_diff={pred['elo_diff']:+.0f}  BO{best_of}")

    if not results:
        print("No predictions generated.")
        return

    out = pd.DataFrame(results)
    out.to_csv(PROCESSED_DIR / 'upcoming_predictions.csv', index=False)
    print(f"\nSaved {len(out)} predictions to upcoming_predictions.csv")

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
