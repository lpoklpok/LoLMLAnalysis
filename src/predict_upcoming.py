"""
predict_upcoming.py
Builds the upcoming-match list from active Polymarket LoL markets (plus
data/manual_upcoming.json for tournaments Polymarket doesn't list), infers
current rosters from the last known OE game per team, applies current ELO
state, and generates model predictions for any market with at least one team
in LCK/LEC/LPL/LCS.

Predictions are side-neutral: the logistic regression intercept (blue-side
baseline advantage ≈ +2%) is excluded so that equal teams → 50%.

Best-of is inferred from the Polymarket event title/description (regex
'best of N' / 'bo N'), defaulting to 3 if not stated.

Output: data/processed/upcoming_predictions.csv
"""

import json
import os
import re
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
# G2 adjustment for 2025+: z_G2 = ALPHA_G2 * logodds + BETA_DA * draft_advantage
ALPHA_G2 = 0.8970
BETA_DA  = 0.0929

# Per-team playoff logodds adjustment (positive = outperforms in playoffs vs regular season).
# Fitted via leave-one-year-out residuals, scaled by a single global shrinkage factor (0.76)
# optimised on 2025+2026 log loss. Only teams with ≥10 playoff games included.
TEAM_PO_ADJ = {
    'G2 Esports':         0.4172,
    'FunPlus Phoenix':    0.3159,
    'Bilibili Gaming':    0.2242,
    'T1':                 0.2068,
    'KT Rolster':         0.1991,
    'Weibo Gaming':       0.1234,
    'BNK FEARX':          0.1069,
    "Anyone's Legend":    0.0801,
    'Team BDS':           0.0612,
    'Karmine Corp':       0.0416,
    'Hanwha Life Esports':-0.0616,
    'Team WE':           -0.0757,
    'Top Esports':       -0.0927,
    'Dplus Kia':         -0.0968,
    'JD Gaming':         -0.1238,
    'Invictus Gaming':   -0.1406,
    'Gen.G':             -0.1510,
    'Movistar KOI':      -0.1518,
    'Team Heretics':     -0.3450,
    'ThunderTalk Gaming':-0.3521,
    'Ninjas in Pyjamas': -0.3548,
    'EDward Gaming':     -0.3743,
    'Team Vitality':     -0.4237,
    'Fnatic':            -0.4427,
    'GiantX':            -0.4491,
    'Nongshim RedForce': -0.6670,
}

# Coaching adjustments: team → (from_year, logodds_bonus).
# Applied to all games (regular season + playoffs) from from_year onwards.
# Reapered joined Karmine Corp for 2026; fitted on 2026 KC games.
COACHING_ADJ = {
    'Karmine Corp': (2026, 0.3695),
}

FEAT_LABELS = {
    'elo_diff':     'ELO Diff',
    'rwr_diff':     'Win Rate Diff (10g)',
    'h2h_wr':       'H2H Win Rate (Team 1)',
    'playoffs':     'Playoffs',
    'gd15_diff':    'GD@15 Diff',
    'outperf_diff': 'Market Outperf Diff',
}

# Canonical team -> league. Used to label predictions when Polymarket is the source of
# the matchup list (Polymarket doesn't tell us the league directly). Teams not in this
# map fall through to 'Other' and are still predicted if rosters exist.
_TEAM_LEAGUE = {
    # LCK
    'T1': 'LCK', 'Gen.G': 'LCK', 'KT Rolster': 'LCK', 'Hanwha Life Esports': 'LCK',
    'Kiwoom DRX': 'LCK', 'BNK FEARX': 'LCK', 'Nongshim RedForce': 'LCK',
    'DN SOOPers': 'LCK', 'Dplus Kia': 'LCK', 'HANJIN BRION': 'LCK',
    # LEC
    'G2 Esports': 'LEC', 'Fnatic': 'LEC', 'Team Vitality': 'LEC',
    'Karmine Corp': 'LEC', 'Movistar KOI': 'LEC', 'Natus Vincere': 'LEC',
    'SK Gaming': 'LEC', 'GiantX': 'LEC', 'Team Heretics': 'LEC', 'Shifters': 'LEC',
    # LPL
    "Anyone's Legend": 'LPL', 'Bilibili Gaming': 'LPL', 'JD Gaming': 'LPL',
    'EDward Gaming': 'LPL', 'Invictus Gaming': 'LPL', 'LGD Gaming': 'LPL',
    'Oh My God': 'LPL', 'Ninjas in Pyjamas': 'LPL', 'LNG Esports': 'LPL',
    'ThunderTalk Gaming': 'LPL', 'Top Esports': 'LPL', 'Ultra Prime': 'LPL',
    'Weibo Gaming': 'LPL', 'Team WE': 'LPL', 'FunPlus Phoenix': 'LPL',
    # LCS
    'Cloud9': 'LCS', 'Dignitas': 'LCS', 'Disguised': 'LCS', 'FlyQuest': 'LCS',
    'LYON': 'LCS', 'Sentinels': 'LCS', 'Shopify Rebellion': 'LCS', 'Team Liquid': 'LCS',
}
MAJOR_LEAGUES = {'LCK', 'LEC', 'LPL', 'LCS'}

# Manual schedule fallback for tournaments not on lolesports (e.g. EWC).
# Path: data/manual_upcoming.json
# Format: [{"date": "2026-07-15T10:00:00Z", "team1": "T1", "team2": "Gen.G", "league": "EWC", "best_of": 5}, ...]
_MANUAL_SCHEDULE_PATH = Path(os.path.dirname(__file__)) / '..' / 'data' / 'manual_upcoming.json'

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
    'Nongshim Red Force':       'Nongshim RedForce',
    'DN Freecs':                'DN SOOPers',
    'DN SOOPers':               'DN SOOPers',
    'Dplus KIA':                'Dplus Kia',
    'Dplus Kia':                'Dplus Kia',
    'DPLUS KIA':                'Dplus Kia',
    'HANJIN BRION':             'HANJIN BRION',
    'OK BRION':                 'HANJIN BRION',
    # LCS
    'Cloud9':                   'Cloud9',
    'CLOUD9':                   'Cloud9',
    'C9':                       'Cloud9',
    'Dignitas':                 'Dignitas',
    'DIGNITAS':                 'Dignitas',
    'DIG':                      'Dignitas',
    'Disguised':                'Disguised',
    'DISGUISED':                'Disguised',
    'FlyQuest':                 'FlyQuest',
    'FLYQUEST':                 'FlyQuest',
    'FLY':                      'FlyQuest',
    'LYON':                     'LYON',
    'Lyon':                     'LYON',
    'Sentinels':                'Sentinels',
    'SENTINELS':                'Sentinels',
    'SEN':                      'Sentinels',
    'Shopify Rebellion':        'Shopify Rebellion',
    'SHOPIFY REBELLION':        'Shopify Rebellion',
    'Team Liquid':              'Team Liquid',
    'TEAM LIQUID':              'Team Liquid',
    'Team Liquid Honda':        'Team Liquid',
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
    # LPL
    "Anyone's Legend":          "Anyone's Legend",
    'BILIBILI GAMING':          'Bilibili Gaming',
    'Bilibili Gaming':          'Bilibili Gaming',
    'Beijing JDG Esports':      'JD Gaming',
    'JD Gaming':                'JD Gaming',
    'EDWARD GAMING':            'EDward Gaming',
    'EDward Gaming':            'EDward Gaming',
    'Invictus Gaming':          'Invictus Gaming',
    'LGD GAMING':               'LGD Gaming',
    'Oh My God':                'Oh My God',
    'Shenzhen NINJAS IN PYJAMAS': 'Ninjas in Pyjamas',
    'Ninjas in Pyjamas':        'Ninjas in Pyjamas',
    'Suzhou LNG Esports':       'LNG Esports',
    'LNG Esports':              'LNG Esports',
    'THUNDER TALK GAMING':      'ThunderTalk Gaming',
    'ThunderTalk Gaming':       'ThunderTalk Gaming',
    'TOP ESPORTS':              'Top Esports',
    'Top Esports':              'Top Esports',
    'Ultra Prime':              'Ultra Prime',
    'WeiboGaming':              'Weibo Gaming',
    'Weibo Gaming':             'Weibo Gaming',
    "Xi'an Team WE":            'Team WE',
    'Team WE':                  'Team WE',
    'FunPlus Phoenix':          'FunPlus Phoenix',
    'FUNPLUS PHOENIX':          'FunPlus Phoenix',
    # MSI / Worlds / EWC (same teams, names already covered above)
}


def _norm_team(name: str) -> str:
    return _TEAM_NORM.get(name.strip(), name.strip())


def _starting_elo(league: str) -> float:
    return _ELO_TIER.get(league, 1260)


_POLY_URL = 'https://gamma-api.polymarket.com/events'


def fetch_oddsportal_odds() -> dict:
    """
    Load upcoming odds scraped from OddsPortal (data/odds/upcoming_odds.csv).
    Returns dict mapping frozenset({team1, team2}) ->
        {'prob_team1': float, 'team1': str, 'team2': str, 'odd1': float, 'odd2': float}
    """
    path = Path(os.path.dirname(__file__)) / '..' / 'data' / 'odds' / 'upcoming_odds.csv'
    if not path.exists():
        print("  No upcoming_odds.csv found — run PullOddsData.py --upcoming first")
        return {}
    try:
        df = pd.read_csv(path)
        result = {}
        for _, row in df.iterrows():
            t1 = str(row['team1']).strip()
            t2 = str(row['team2']).strip()
            result[frozenset([t1, t2])] = {
                'prob_team1': float(row['implied_prob1_vigfree']),
                'team1':      t1,
                'team2':      t2,
                'odd1':       float(row['odd1_decimal']),
                'odd2':       float(row['odd2_decimal']),
            }
        print(f"  OddsPortal: loaded {len(result)} upcoming match odds")
        return result
    except Exception as e:
        print(f"  OddsPortal load error: {e}")
        return {}


_BO_RE          = re.compile(r'(?:best\s*of|\bbo)\s*(\d+)', re.IGNORECASE)
_DATE_RE        = re.compile(r'(\d{4})-(\d{2})-(\d{2})')
_TOURNAMENT_RE  = re.compile(r'-\s*(.+?)\s*$')  # text after last " - " in a Polymarket title
_GAME_WINNER_RE = re.compile(r'Game\s+(\d+)\s+Winner', re.IGNORECASE)


def _infer_best_of(event: dict) -> int:
    """Detect BO from the event's per-game 'Game N Winner' sub-markets.

    Heuristic (from the Polymarket structure): the event lists a separate winner
    market for each game that may be played, so:
      - has a 'Game 4 Winner' sub-market  → Bo5
      - has a 'Game 2 Winner' sub-market but no Game 4 → Bo3
      - has only 'Game 1 Winner' (or no per-game winner markets) → Bo1

    Falls back to a title/description regex ('best of N' / 'Bo N') and then to Bo3
    if nothing is detectable — useful for events listed before per-game markets are
    published.
    """
    max_game = 0
    for m in event.get('markets', []):
        gt = (m.get('groupItemTitle') or '').strip()
        mm = _GAME_WINNER_RE.match(gt)
        if mm:
            try:
                n = int(mm.group(1))
                if n > max_game:
                    max_game = n
            except ValueError:
                pass
    if max_game >= 4:
        return 5
    if max_game >= 2:
        return 3
    if max_game == 1:
        return 1

    # Fallback: text-based BO regex in title/description
    for field in ('title', 'description', 'groupItemTitle'):
        text = event.get(field) or ''
        m = _BO_RE.search(text)
        if m:
            try:
                n = int(m.group(1))
                if 1 <= n <= 7:
                    return n
            except ValueError:
                pass
    return 3


def _infer_tournament(event: dict) -> str | None:
    """Extract the tournament suffix from a Polymarket title.
    Format observed: 'LoL: A vs B (BO3) - LPL Group Ascend' → 'LPL Group Ascend'."""
    title = event.get('title') or ''
    m = _TOURNAMENT_RE.search(title)
    if not m:
        return None
    suffix = m.group(1).strip()
    return suffix if suffix else None


def _tournament_to_league(tournament: str | None) -> str | None:
    """Map a Polymarket tournament suffix to a coarse league bucket.
    Returns None if the suffix is missing or unrecognised — caller falls back to team lookup."""
    if not tournament:
        return None
    t = tournament.strip()
    tl = t.lower()
    # Order matters: more-specific tournaments first (e.g. 'LCK Challengers' before 'LCK').
    if 'challengers' in tl or 'academy' in tl:
        return 'Other'  # LCK Challengers League etc. — not the top tier
    if tl.startswith('esports world cup') or 'esports world cup' in tl:
        return 'EWC'
    if 'mid-season' in tl or tl.startswith('msi'):
        return 'MSI'
    if 'world championship' in tl or tl.startswith('worlds'):
        return 'Worlds'
    if 'first stand' in tl:
        return 'First Stand'
    if tl.startswith('lck'): return 'LCK'
    if tl.startswith('lec'): return 'LEC'
    if tl.startswith('lpl'): return 'LPL'
    if tl.startswith('lcs'): return 'LCS'
    return 'Other'


def _infer_match_date(event: dict) -> 'pd.Timestamp | None':
    """Best-effort match date: slug YYYY-MM-DD trumps event endDate."""
    slug = event.get('slug') or ''
    m = _DATE_RE.search(slug)
    if m:
        try:
            return pd.Timestamp(f'{m.group(1)}-{m.group(2)}-{m.group(3)}T00:00:00+00:00')
        except Exception:
            pass
    end_date = event.get('endDate')
    if end_date:
        try:
            return pd.Timestamp(end_date)
        except Exception:
            return None
    return None


def fetch_polymarket_odds() -> dict:
    """
    Fetch all active LoL match markets from Polymarket.
    Returns dict mapping frozenset({team1, team2}) ->
        {'prob_team1', 'team1', 'team2', 'volume', 'slug', 'best_of', 'match_date'}
    where team1/team2 are OE-canonical names and prob_team1 is the win
    probability for outcomes[0].
    """
    try:
        events = []
        for offset in range(0, 500, 100):
            r = requests.get(_POLY_URL, params={
                'tag_slug': 'league-of-legends',
                'active': 'true', 'closed': 'false',
                'limit': 100, 'offset': offset,
            }, timeout=15)
            r.raise_for_status()
            page = r.json() if isinstance(r.json(), list) else []
            events.extend(page)
            if len(page) < 100:
                break
    except Exception as e:
        print(f"  Polymarket fetch error: {e}")
        return {}

    result = {}
    for event in events:
        if 'vs' not in event.get('title', '').lower():
            continue
        markets = event.get('markets', [])
        winner = next((m for m in markets if m.get('question', '') == event['title']), None)
        if not winner:
            continue

        prices   = winner.get('outcomePrices', [])
        outcomes = winner.get('outcomes', [])
        if isinstance(prices,   str): prices   = json.loads(prices)
        if isinstance(outcomes, str): outcomes = json.loads(outcomes)
        if len(prices) < 2 or len(outcomes) < 2:
            continue

        try:
            prob1 = float(prices[0])
            vol   = float(winner.get('volume') or 0)
        except (ValueError, TypeError):
            continue

        t1 = _norm_team(outcomes[0])
        t2 = _norm_team(outcomes[1])
        tournament = _infer_tournament(event)
        result[frozenset([t1, t2])] = {
            'prob_team1': prob1, 'team1': t1, 'team2': t2, 'volume': vol,
            'slug':         event.get('slug', ''),
            'best_of':      _infer_best_of(event),
            'match_date':   _infer_match_date(event),
            'tournament':   tournament,
            'league_label': _tournament_to_league(tournament),
        }

    print(f"  Polymarket: found {len(result)} active LoL match markets")
    return result


def fetch_upcoming(poly_odds: dict, days_ahead: int = 21) -> pd.DataFrame:
    """Build the upcoming-matches table from active Polymarket LoL markets.

    Falls back to data/manual_upcoming.json for tournaments not on Polymarket.
    `poly_odds` is the dict returned by fetch_polymarket_odds() — reused to avoid a
    second API call.
    """
    now    = pd.Timestamp.now('UTC')
    cutoff = now + pd.Timedelta(days=days_ahead)
    rows   = []

    skipped_past      = 0
    skipped_far       = 0
    skipped_no_league = 0
    for key, pm in poly_odds.items():
        t1, t2 = pm['team1'], pm['team2']
        # Prefer the league parsed from Polymarket's tournament suffix; fall back to a
        # major-region team membership. Need at least one side to anchor a major-league
        # team so the model has rosters/ELO to work with.
        league_from_tournament = pm.get('league_label')
        lg1 = _TEAM_LEAGUE.get(t1)
        lg2 = _TEAM_LEAGUE.get(t2)
        has_major_team = bool(lg1 or lg2)
        if not has_major_team:
            skipped_no_league += 1
            continue
        league = league_from_tournament or lg1 or lg2 or 'Other'
        match_date = pm.get('match_date')
        if match_date is None:
            # Without a date we can't sort or filter; skip.
            continue
        if match_date.tzinfo is None:
            match_date = match_date.tz_localize('UTC')
        if match_date < now - pd.Timedelta(days=1):
            skipped_past += 1
            continue
        if match_date > cutoff:
            skipped_far += 1
            continue
        rows.append({
            'Team1':        t1,
            'Team2':        t2,
            'DateTime_UTC': match_date,
            'BestOf':       int(pm.get('best_of', 3)),
            'league':       league,
        })
    if skipped_past or skipped_far or skipped_no_league:
        print(f"  Polymarket filter: {skipped_past} past, {skipped_far} >{days_ahead}d out, "
              f"{skipped_no_league} no major team")

    # Merge manual schedule (EWC and other non-Polymarket tournaments)
    if _MANUAL_SCHEDULE_PATH.exists():
        import json as _json
        try:
            manual = _json.loads(_MANUAL_SCHEDULE_PATH.read_text())
            for entry in manual:
                if 'date' not in entry or 'team1' not in entry:
                    continue
                dt = pd.Timestamp(entry['date']).tz_localize('UTC') if pd.Timestamp(entry['date']).tzinfo is None else pd.Timestamp(entry['date'])
                if now < dt <= cutoff:
                    rows.append({
                        'Team1':        entry['team1'],
                        'Team2':        entry['team2'],
                        'DateTime_UTC': dt,
                        'BestOf':       int(entry.get('best_of', 1)),
                        'league':       entry.get('league', 'EWC'),
                    })
            manual_count = sum(1 for e in manual if 'date' in e and 'team1' in e and now < (pd.Timestamp(e['date']).tz_localize('UTC') if pd.Timestamp(e['date']).tzinfo is None else pd.Timestamp(e['date'])) <= cutoff)
            if manual_count:
                print(f"  Loaded {manual_count} game(s) from manual_upcoming.json")
        except Exception as e:
            print(f"  Warning: could not read manual_upcoming.json: {e}")

    if not rows:
        print("  No upcoming matches found in Polymarket.")
        return pd.DataFrame()

    df = pd.DataFrame(rows).sort_values('DateTime_UTC').reset_index(drop=True)
    print(f"  Found {len(df)} upcoming games across {df['league'].nunique()} league(s)")
    return df


def _add_series_momentum(df: pd.DataFrame) -> pd.DataFrame:
    """Add series_momentum column: +1 blue won prev game, -1 lost, 0 if G1 or bo1."""
    df = df.copy()
    df['_date_day'] = df['date'].dt.date
    df['_team_key'] = df.apply(
        lambda r: '|'.join(sorted([str(r['blue_team']), str(r['red_team'])])), axis=1
    )
    df = df.sort_values(['_date_day', 'league', '_team_key', 'game'])
    def _draft_adv(grp):
        grp = grp.sort_values('game')
        prev = grp['blue_win'].shift(1)
        # Loser of prev game gets draft choice: +1 if blue lost (blue picks), -1 if blue won (red picks)
        grp['draft_advantage'] = prev.apply(
            lambda x: 0 if pd.isna(x) else (-1 if x == 1 else 1)
        ).astype(int)
        return grp
    return df.groupby(['_date_day', 'league', '_team_key'], group_keys=False).apply(_draft_adv)


def load_state() -> tuple[dict, dict, pd.DataFrame, dict, dict, dict, dict]:
    with open(PROCESSED_DIR / 'elo_state.json') as f:
        elo_state = json.load(f)
    with open(PROCESSED_DIR / 'roster_state.json') as f:
        roster_state = json.load(f)
    features = pd.read_csv(PROCESSED_DIR / 'features.csv', low_memory=False)
    features['date'] = pd.to_datetime(features['date'], utc=True)
    features = _add_series_momentum(features)

    player_h2h: dict = {}
    player_h2h_path = PROCESSED_DIR / 'player_h2h.json'
    if player_h2h_path.exists():
        with open(player_h2h_path) as f:
            raw = json.load(f)
        player_h2h = {tuple(k.split('|||')): v for k, v in raw.items()}

    # Load per-player GD@15 and per-team outperf histories from checkpoint
    # so diffs can be computed against the actual upcoming opponent
    player_gd15: dict = {}
    team_outperf: dict = {}
    team_outperf_staleness: dict = {}
    ckpt_path = PROCESSED_DIR / 'fe_checkpoint.json'
    if ckpt_path.exists():
        with open(ckpt_path) as f:
            ckpt = json.load(f)
        player_gd15            = ckpt.get('player_gd15', {})
        team_outperf           = ckpt.get('team_outperf', {})
        team_outperf_staleness = ckpt.get('team_outperf_staleness', {})

    return (elo_state['elo_map'], roster_state, features, player_h2h,
            player_gd15, team_outperf, team_outperf_staleness)


def _role_h2h_info(blue_players: list, red_players: list, player_h2h: dict) -> list[dict]:
    """Per-role head-to-head record from blue player's perspective."""
    result = []
    for i, pos in enumerate(POSITIONS):
        bp, rp = blue_players[i], red_players[i]
        p0, p1 = (bp, rp) if bp <= rp else (rp, bp)
        key = (p0, p1, pos)
        data = player_h2h.get(key, {'n': 0, 'wins': 0})
        n = data['n']
        wins_p0 = data['wins']
        blue_wins = wins_p0 if p0 == bp else n - wins_p0
        result.append({'pos': pos, 'blue': bp, 'red': rp, 'n': n, 'blue_wins': blue_wins})
    return result


def train_model(features: pd.DataFrame) -> tuple[Pipeline, np.ndarray | None, dict]:
    """Returns (fitted pipeline, inverse Fisher information matrix, model stats dict)."""
    train   = features[features['year'].isin([2024, 2025])]
    test    = features[features['year'] == 2026]
    X_train = train[FEATS].fillna(FILL)
    y_train = train['blue_win'].values

    model = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(X_train, y_train)

    fim_inv     = _compute_fim_inv(model, X_train)
    # Use 2026 hold-out for R² — in-sample would be optimistic
    X_eval  = test[FEATS].fillna(FILL)  if len(test) else X_train
    y_eval  = test['blue_win'].values   if len(test) else y_train
    model_stats = _compute_model_stats(model, fim_inv, X_train, y_train, X_eval, y_eval)
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
                         X_train: pd.DataFrame, y_train: np.ndarray,
                         X_eval: pd.DataFrame, y_eval: np.ndarray) -> dict:
    """
    Compute and return model metadata for display:
      - per-feature standardised coefficient, SE, and individual R²
      - McFadden R² computed on the held-out evaluation set (2026)
    """
    lr = model.named_steps['lr']

    # McFadden R² on held-out eval set
    p_eval  = model.predict_proba(X_eval)[:, 1]
    n       = len(y_eval)
    L_full  = -float(sk_log_loss(y_eval, p_eval, normalize=False))
    p_null  = float(y_eval.mean())
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
        'n_train':     int(len(y_train)),
        'n_eval':      int(n),
    }


def _predict_side_neutral(model: Pipeline, row_filled: pd.DataFrame,
                          game_in_series: int = 1, year: int = 2026,
                          draft_advantage: int = 0, team_po_bonus: float = 0.0,
                          coaching_bonus: float = 0.0) -> float:
    """Win probability with intercept zeroed out (side-neutral).
    For G2 in 2025+: z = ALPHA_G2 * logodds + BETA_DA * draft_advantage,
    separating regression-to-mean from the genuine draft-advantage boost.
    team_po_bonus: blue_team TEAM_PO_ADJ - red_team TEAM_PO_ADJ, applied when playoffs=1.
    coaching_bonus: net logodds shift from COACHING_ADJ for blue vs red team.
    """
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(row_filled)
    z      = float(X_sc[0] @ lr.coef_.ravel())
    if game_in_series == 2 and year >= 2025:
        z = ALPHA_G2 * z + BETA_DA * draft_advantage
    z += team_po_bonus + coaching_bonus
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


GD15_ROLL  = 5
OUTPERF_N  = 5


def _team_rwr(team: str, features: pd.DataFrame) -> float:
    """Team's rolling win rate from their most recent game."""
    mask = (features['blue_team'] == team) | (features['red_team'] == team)
    rows = features[mask].dropna(subset=['blue_rwr', 'red_rwr'])
    if rows.empty:
        return float('nan')
    last = rows.iloc[-1]
    return float(last['blue_rwr']) if last['blue_team'] == team else float(last['red_rwr'])


def _team_gd15(players: list, player_gd15: dict) -> float:
    """Mean rolling GD@15 for a lineup, matching feature_engineering constants."""
    vals = []
    for p in players:
        hist = player_gd15.get(p, [])
        if len(hist) >= 2:
            vals.append(float(np.mean(hist[-GD15_ROLL:])))
    return float(np.nanmean(vals)) if vals else float('nan')


def _team_outperf(team: str, team_outperf: dict, staleness: dict) -> float:
    """Rolling outperformance vs market for a team, NaN if stale."""
    if staleness.get(team, 0) >= OUTPERF_N:
        return float('nan')
    hist = team_outperf.get(team, [])
    if len(hist) < 3:
        return float('nan')
    return float(np.mean(hist[-OUTPERF_N:]))


def _matchup_h2h_wr(blue_team: str, red_team: str, features: pd.DataFrame) -> float:
    """Blue team's historical win rate against red team, looked up from their shared game history."""
    mask = (
        ((features['blue_team'] == blue_team) & (features['red_team'] == red_team)) |
        ((features['blue_team'] == red_team)  & (features['red_team'] == blue_team))
    )
    rows = features[mask].dropna(subset=['h2h_wr'])
    if len(rows) < 2:
        return np.nan
    last = rows.iloc[-1]
    if last['blue_team'] == blue_team:
        return float(last['h2h_wr'])
    return 1.0 - float(last['h2h_wr'])  # invert: stored from the other team's blue perspective


def predict_game(blue_team: str, red_team: str, league: str,
                 elo_map: dict, roster_state: dict, features: pd.DataFrame,
                 model: Pipeline, fim_inv: np.ndarray | None,
                 player_h2h: dict | None = None,
                 player_gd15: dict | None = None,
                 team_outperf: dict | None = None,
                 team_outperf_staleness: dict | None = None,
                 draft_advantage: int = 0,
                 game_in_series: int = 1,
                 year: int = 2026,
                 playoffs: bool = False) -> dict | None:
    """
    draft_advantage: +1 if blue lost prev game (blue has pick/side choice),
                     -1 if blue won prev game (red has choice), 0 for G1/bo1.
    game_in_series: 1 for G1/bo1, 2 for G2, etc. Used to apply G2 shrinkage.
    playoffs: True for playoff series (enables team playoff adjustment).
    """
    blue_players = roster_state.get(blue_team)
    red_players  = roster_state.get(red_team)

    if not blue_players or not red_players:
        print(f"  No roster found for {blue_team} or {red_team}")
        return None

    start     = _starting_elo(league)
    blue_elos = [elo_map.get(p, start) for p in blue_players]
    red_elos  = [elo_map.get(p, start) for p in red_players]
    elo_diff  = float(np.mean(blue_elos) - np.mean(red_elos))

    # Each feature computed from each team's own recent history,
    # then diff'd against the actual upcoming opponent (not last game's opponent)
    blue_rwr     = _team_rwr(blue_team, features)
    red_rwr      = _team_rwr(red_team,  features)
    rwr_diff     = blue_rwr - red_rwr if not (np.isnan(blue_rwr) or np.isnan(red_rwr)) else np.nan

    h2h_wr       = _matchup_h2h_wr(blue_team, red_team, features)

    _pg = player_gd15 or {}
    blue_gd15    = _team_gd15(blue_players, _pg)
    red_gd15     = _team_gd15(red_players,  _pg)
    gd15_diff    = blue_gd15 - red_gd15 if not (np.isnan(blue_gd15) or np.isnan(red_gd15)) else np.nan

    _to = team_outperf or {}
    _ts = team_outperf_staleness or {}
    blue_op      = _team_outperf(blue_team, _to, _ts)
    red_op       = _team_outperf(red_team,  _to, _ts)
    outperf_diff = blue_op - red_op if not (np.isnan(blue_op) or np.isnan(red_op)) else np.nan

    row_filled = pd.DataFrame([{
        'elo_diff':     elo_diff,
        'rwr_diff':     rwr_diff,
        'h2h_wr':       h2h_wr,
        'playoffs':     0,
        'gd15_diff':    gd15_diff,
        'outperf_diff': outperf_diff,
    }]).fillna(FILL)

    team_po_bonus = (TEAM_PO_ADJ.get(blue_team, 0.0) - TEAM_PO_ADJ.get(red_team, 0.0)) if playoffs else 0.0

    def _coaching_bonus(team: str) -> float:
        from_year, bonus = COACHING_ADJ.get(team, (9999, 0.0))
        return bonus if year >= from_year else 0.0
    coaching_bonus = _coaching_bonus(blue_team) - _coaching_bonus(red_team)

    pred = _predict_side_neutral(model, row_filled, game_in_series=game_in_series,
                                 year=year, draft_advantage=draft_advantage,
                                 team_po_bonus=team_po_bonus, coaching_bonus=coaching_bonus)
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
        'feat_rwr_diff':       _safe(rwr_diff),
        'feat_h2h_wr':         _safe(h2h_wr),
        'feat_gd15_diff':      _safe(gd15_diff),
        'feat_outperf_diff':   _safe(outperf_diff),
        # per-role player head-to-head records (informational only)
        'role_h2h':           _role_h2h_info(blue_players, red_players, player_h2h or {}),
    }


def run():
    print("Loading ELO + roster state...")
    elo_map, roster_state, features, player_h2h, player_gd15, team_outperf, team_outperf_staleness = load_state()

    print("Training model on 2024-2025...")
    model, fim_inv, model_stats = train_model(features)

    print("Fetching Polymarket odds...")
    poly_odds = fetch_polymarket_odds()

    print("Building upcoming matches from Polymarket (+ manual fallback)...")
    upcoming = fetch_upcoming(poly_odds, days_ahead=21)

    if upcoming.empty:
        print("No upcoming matches found.")
        return

    print("Loading OddsPortal upcoming odds...")
    op_odds = fetch_oddsportal_odds()

    results = []
    for _, row in upcoming.iterrows():
        blue    = _norm_team(row['Team1'])
        red     = _norm_team(row['Team2'])
        league  = row['league']
        dt      = row['DateTime_UTC']
        best_of = int(row['BestOf'])

        is_playoff = best_of >= 5
        pred = predict_game(blue, red, league, elo_map, roster_state, features, model, fim_inv,
                            player_h2h, player_gd15, team_outperf, team_outperf_staleness,
                            draft_advantage=0, playoffs=is_playoff)
        if pred:
            pred['date']    = dt.isoformat()
            pred['best_of'] = best_of

            # Attach Polymarket odds if market exists for this matchup
            pm = poly_odds.get(frozenset([blue, red]))
            if pm:
                blue_prob = pm['prob_team1'] if pm['team1'] == blue else 1 - pm['prob_team1']
                pred['poly_prob']        = round(blue_prob, 4)
                pred['poly_volume']      = round(pm['volume'], 0)
                pred['poly_event_slug']  = pm['slug']
                pred['poly_team1']       = pm['team1']
            else:
                pred['poly_prob']        = None
                pred['poly_volume']      = None
                pred['poly_event_slug']  = None
                pred['poly_team1']       = None

            # Attach OddsPortal bookmaker odds
            op = op_odds.get(frozenset([blue, red]))
            if op:
                op_blue_prob = op['prob_team1'] if op['team1'] == blue else 1 - op['prob_team1']
                op_blue_odd  = op['odd1'] if op['team1'] == blue else op['odd2']
                op_red_odd   = op['odd2'] if op['team1'] == blue else op['odd1']
                pred['op_prob']     = round(op_blue_prob, 4)
                pred['op_odd_blue'] = round(op_blue_odd, 3)
                pred['op_odd_red']  = round(op_red_odd, 3)
            else:
                pred['op_prob']     = None
                pred['op_odd_blue'] = None
                pred['op_odd_red']  = None

            results.append(pred)
            poly_str = f"  poly={pred['poly_prob']:.3f}" if pred['poly_prob'] else ''
            print(f"  {dt.strftime('%m-%d %H:%M')} UTC  {blue:<25} vs {red:<25}  "
                  f"pred={pred['pred_blue_win']:.3f} ±{pred['pred_se'] or 0:.3f}  "
                  f"elo={pred['elo_diff']:+.0f}  BO{best_of}{poly_str}")

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

        # Upload predictions (use results list directly so role_h2h stays as a list, not string)
        client.table('upcoming_predictions').delete().neq('blue_team', '').execute()
        for i in range(0, len(results), 100):
            client.table('upcoming_predictions').insert(results[i:i+100]).execute()
        print(f"Uploaded {len(results)} upcoming predictions.")

        # Upload model stats (upsert into single row)
        client.table('model_info').upsert({
            'id':           1,
            'features':     model_stats['features'],
            'mcfadden_r2':  model_stats['mcfadden_r2'],
            'n_train':      model_stats['n_train'],
            'n_eval':       model_stats['n_eval'],
            'updated_at':   pd.Timestamp.now('UTC').isoformat(),
        }).execute()
        print(f"Uploaded model stats (McFadden R²={model_stats['mcfadden_r2']:.4f} on 2026 hold-out, "
              f"n_train={model_stats['n_train']:,}, n_eval={model_stats['n_eval']:,}).")


if __name__ == '__main__':
    run()
