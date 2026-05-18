"""
predict_upcoming.py
Fetches upcoming LCK/LEC matches from the lolesports.com schedule API,
infers current rosters from the last known OE game per team, applies
current ELO state, and generates model predictions for games not yet played.

Predictions are side-neutral: the logistic regression intercept (blue-side
baseline advantage ≈ +2%) is excluded so that equal teams → 50%.

Output: data/processed/upcoming_predictions.csv
"""

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv
from scipy.stats import pearsonr
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss as sk_log_loss
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

FEAT_LABELS = {
    'elo_diff':     'ELO Diff',
    'rwr_diff':     'Win Rate Diff (10g)',
    'h2h_wr':       'H2H Win Rate (Team 1)',
    'playoffs':     'Playoffs',
    'gd15_diff':    'GD@15 Diff',
    'outperf_diff': 'Market Outperf Diff',
}

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


def train_model(features: pd.DataFrame) -> tuple[Pipeline, np.ndarray | None, dict]:
    """Returns (fitted pipeline, inverse Fisher information matrix, model stats dict)."""
    train   = features[features['year'].isin([2024, 2025])]
    X_train = train[FEATS].fillna(FILL)
    y_train = train['blue_win'].values

    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(X_train, y_train)

    fim_inv    = _compute_fim_inv(model, X_train)
    model_stats = _compute_model_stats(model, fim_inv, X_train, y_train)
    return model, fim_inv, model_stats


def _compute_fim_inv(model: Pipeline, X_train: pd.DataFrame) -> np.ndarray | None:
    """Inverse Fisher information matrix — used for delta-method SEs."""
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(X_train)
    p      = lr.predict_proba(X_sc)[:, 1]
    W      = p * (1 - p)
    X_aug  = np.column_stack([np.ones(len(X_sc)), X_sc])
    FIM    = X_aug.T @ (W[:, None] * X_aug)
    try:
        return np.linalg.inv(FIM)
    except np.linalg.LinAlgError:
        return None


def _compute_model_stats(model: Pipeline, fim_inv: np.ndarray | None,
                         X_train: pd.DataFrame, y_train: np.ndarray) -> dict:
    """
    Compute and return model metadata for display:
      - per-feature standardised coefficient, SE, and individual R²
      - McFadden R² for the overall model
    """
    lr = model.named_steps['lr']

    # McFadden R²
    p_train = model.predict_proba(X_train)[:, 1]
    n       = len(y_train)
    L_full  = -float(sk_log_loss(y_train, p_train, normalize=False))
    p_null  = float(y_train.mean())
    L_null  = n * (p_null * np.log(p_null) + (1 - p_null) * np.log(1 - p_null))
    mcfadden_r2 = float(1 - L_full / L_null)

    # Per-feature coefficient SEs from diagonal of FIM inverse
    coef_se = ([float(np.sqrt(max(0.0, fim_inv[j + 1, j + 1]))) for j in range(len(FEATS))]
               if fim_inv is not None else [float('nan')] * len(FEATS))

    # Individual R²: squared Pearson correlation with outcome
    feature_stats = []
    for j, feat in enumerate(FEATS):
        r, _ = pearsonr(X_train[feat], y_train)
        feature_stats.append({
            'name':  feat,
            'label': FEAT_LABELS.get(feat, feat),
            'coef':  round(float(lr.coef_[0][j]), 4),
            'se':    round(coef_se[j], 4),
            'r2':    round(float(r ** 2), 4),
        })

    return {
        'features':    feature_stats,
        'mcfadden_r2': round(mcfadden_r2, 4),
        'n_train':     int(n),
    }


def _predict_side_neutral(model: Pipeline, row_filled: pd.DataFrame) -> float:
    """Win probability with intercept zeroed out (side-neutral)."""
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(row_filled)
    z      = float(X_sc[0] @ lr.coef_.ravel())
    return float(1.0 / (1.0 + np.exp(-z)))


def _pred_se_side_neutral(fim_inv: np.ndarray | None,
                          model: Pipeline, row_filled: pd.DataFrame,
                          p: float) -> float:
    """SE of the side-neutral probability via the delta method (feature sub-block of FIM⁻¹)."""
    if fim_inv is None:
        return float('nan')
    scaler       = model.named_steps['s']
    X_sc         = scaler.transform(row_filled)
    FIM_feat_inv = fim_inv[1:, 1:]
    var_z        = float(X_sc[0] @ FIM_feat_inv @ X_sc[0])
    return round(p * (1 - p) * np.sqrt(max(0.0, var_z)), 4)


def _safe(v) -> float | None:
    """Return None for NaN/inf so Supabase accepts it."""
    try:
        return None if (v is None or np.isnan(v) or np.isinf(v)) else float(v)
    except Exception:
        return None


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

    pred = _predict_side_neutral(model, row_filled)
    se   = _pred_se_side_neutral(fim_inv, model, row_filled, pred)

    return {
        'blue_team':          blue_team,
        'red_team':           red_team,
        'league':             league,
        'blue_elo':           round(float(np.mean(blue_elos)), 1),
        'red_elo':            round(float(np.mean(red_elos)), 1),
        'elo_diff':           round(elo_diff, 1),
        'pred_blue_win':      round(pred, 4),
        'pred_se':            round(se, 4) if not np.isnan(se) else None,
        'model_name':         MODEL_NAME,
        # per-game feature values shown on the predictions page
        'feat_rwr_diff':      _safe(rwr_diff),
        'feat_h2h_wr':        _safe(h2h_wr),
        'feat_gd15_diff':     _safe(gd15_diff),
        'feat_outperf_diff':  _safe(outperf_diff),
    }


def run():
    print("Loading ELO + roster state...")
    elo_map, roster_state, features = load_state()

    print("Training model on 2024-2025...")
    model, fim_inv, model_stats = train_model(features)

    print("Fetching upcoming matches from lolesports...")
    upcoming = fetch_upcoming(days_ahead=14)

    if upcoming.empty:
        print("No upcoming matches found.")
        return

    results = []
    for _, row in upcoming.iterrows():
        blue    = _norm_team(row['Team1'])
        red     = _norm_team(row['Team2'])
        league  = row['league']
        dt      = row['DateTime_UTC']
        best_of = int(row['BestOf'])

        pred = predict_game(blue, red, league, elo_map, roster_state, features, model, fim_inv)
        if pred:
            pred['date']    = dt.isoformat()
            pred['best_of'] = best_of
            results.append(pred)
            print(f"  {dt.strftime('%m-%d %H:%M')} UTC  {blue:<25} vs {red:<25}  "
                  f"pred={pred['pred_blue_win']:.3f} ±{pred['pred_se'] or 0:.3f}  "
                  f"elo={pred['elo_diff']:+.0f}  BO{best_of}")

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

        # Upload predictions
        client.table('upcoming_predictions').delete().neq('blue_team', '').execute()
        records = out.to_dict(orient='records')
        for i in range(0, len(records), 100):
            client.table('upcoming_predictions').insert(records[i:i+100]).execute()
        print(f"Uploaded {len(records)} upcoming predictions.")

        # Upload model stats (upsert into single row)
        client.table('model_info').upsert({
            'id':           1,
            'features':     model_stats['features'],
            'mcfadden_r2':  model_stats['mcfadden_r2'],
            'n_train':      model_stats['n_train'],
            'updated_at':   pd.Timestamp.now('UTC').isoformat(),
        }).execute()
        print(f"Uploaded model stats (McFadden R²={model_stats['mcfadden_r2']:.4f}, "
              f"n={model_stats['n_train']:,}).")


if __name__ == '__main__':
    run()
