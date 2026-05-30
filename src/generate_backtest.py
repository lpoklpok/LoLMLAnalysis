"""
generate_backtest.py

Regenerates web/public/backtest.json with:
  - Existing LCK/LEC/LPL Polymarket backtest (kelly_5pct filter as before)
  - LCS simulation using OddsPortal vigfree odds (q_blue_win), 0% fee
  - Combined curve: LCK/LEC/LPL + LCS bets interleaved by date
  - Per-region P&L stats added to output

Usage:
    python src/generate_backtest.py
"""

import json
import os
import sys
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT       = Path(__file__).resolve().parent.parent
FEAT_MAJOR = ROOT / 'data' / 'processed' / 'features.csv'      # LCK/LEC/LPL only
FEAT_ALL   = ROOT / 'data' / 'processed' / 'features_all.csv'  # all leagues incl LCS
BACKTEST   = ROOT / 'web' / 'public' / 'backtest.json'
OUT        = ROOT / 'web' / 'public' / 'backtest.json'

# ---------------------------------------------------------------------------
# Model constants (must stay in sync with predict_upcoming.py)
# ---------------------------------------------------------------------------
FEATS = ['elo_diff', 'rwr_diff', 'h2h_wr', 'gd15_diff', 'outperf_diff']
FILL  = {'elo_diff': 0.0, 'rwr_diff': 0.0, 'h2h_wr': 0.5,
         'gd15_diff': 0.0, 'outperf_diff': 0.0}

ALPHA_G2 = 0.8970
BETA_DA  = 0.0929

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

COACHING_ADJ = {
    'Karmine Corp': (2026, 0.3695),
}

# ---------------------------------------------------------------------------
# Model helpers
# ---------------------------------------------------------------------------

def train_model(features: pd.DataFrame):
    train   = features[features['year'].isin([2024, 2025])]
    X_train = train[FEATS].fillna(FILL)
    y_train = train['blue_win'].values
    model   = Pipeline([('s', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
    model.fit(X_train, y_train)
    return model


def _coaching_bonus(team: str, year: int) -> float:
    if team in COACHING_ADJ:
        from_year, bonus = COACHING_ADJ[team]
        if year >= from_year:
            return bonus
    return 0.0


def predict_side_neutral(model, row: pd.DataFrame, game: int, year: int,
                         draft_advantage: int, blue_team: str, red_team: str,
                         playoffs: int) -> float:
    scaler = model.named_steps['s']
    lr     = model.named_steps['lr']
    X_sc   = scaler.transform(row)
    z      = float(X_sc[0] @ lr.coef_.ravel())
    if game == 2 and year >= 2025:
        z = ALPHA_G2 * z + BETA_DA * draft_advantage
    if playoffs:
        z += TEAM_PO_ADJ.get(blue_team, 0.0) - TEAM_PO_ADJ.get(red_team, 0.0)
    z += _coaching_bonus(blue_team, year) - _coaching_bonus(red_team, year)
    return float(1.0 / (1.0 + np.exp(-z)))

# ---------------------------------------------------------------------------
# Bet generation
# ---------------------------------------------------------------------------

def make_bets(df: pd.DataFrame, model, kelly_threshold: float = 0.05,
              min_edge: float = 0.0, fee_pct: float = 0) -> list[dict]:
    """
    Generate bet log from a feature dataframe with q_blue_win odds.
    Returns list of bet dicts sorted by date.
    """
    bets = []
    # Pre-sort by date + game for draft_advantage lookup
    df = df.sort_values('date').reset_index(drop=True)

    # Track previous game outcome per series for draft_advantage
    # series key: frozenset of teams + date-window
    prev_blue_win: dict[str, int] = {}  # series_key -> blue_win of prev game

    for _, row in df.iterrows():
        if pd.isna(row.get('q_blue_win')):
            continue

        market_q = float(row['q_blue_win'])
        if market_q <= 0 or market_q >= 1:
            continue

        blue_team = str(row['blue_team'])
        red_team  = str(row['red_team'])
        game      = int(row.get('game', 1))
        year      = int(row.get('year', 2026))
        playoffs  = int(row.get('playoffs', 0))
        blue_win  = int(row['blue_win'])

        # Draft advantage for G2
        series_key = '|'.join(sorted([blue_team, red_team]))
        draft_advantage = 0
        if game >= 2 and series_key in prev_blue_win:
            draft_advantage = -1 if prev_blue_win[series_key] == 1 else 1
        prev_blue_win[series_key] = blue_win

        X = pd.DataFrame([{f: row.get(f, FILL[f]) for f in FEATS}]).fillna(FILL)
        model_p = predict_side_neutral(model, X, game, year, draft_advantage,
                                       blue_team, red_team, playoffs)

        # Determine which side to bet (always the one model favours)
        if model_p > market_q:
            side = 'blue'
            prob_edge = model_p - market_q
            mp = market_q
        else:
            side = 'red'
            prob_edge = (1 - model_p) - (1 - market_q)
            mp = 1 - market_q

        if prob_edge <= min_edge:
            continue

        raw_kelly = prob_edge / (1 - mp) if (1 - mp) > 0 else 0
        kelly_f   = min(raw_kelly * 0.5, 0.20)

        if kelly_f < kelly_threshold:
            continue

        # Date string
        d = str(row['date'])[:10]

        bets.append({
            'date':       d,
            'league':     str(row.get('league', 'LCS')),
            'blue_team':  blue_team,
            'red_team':   red_team,
            'model_p':    round(model_p, 4),
            'market_q':   round(market_q, 4),
            'blue_win':   blue_win,
            'side':       side,
            'prob_edge':  round(prob_edge, 4),
            'kelly_f':    round(kelly_f, 4),
            'stake':      None,       # filled during simulation
            'result':     None,
            'bankroll':   None,
            'won':        (side == 'blue' and blue_win == 1) or
                          (side == 'red'  and blue_win == 0),
            'fee_pct':    fee_pct,
        })

    return sorted(bets, key=lambda b: b['date'])


def simulate(bets: list[dict], starting_bankroll: float):
    """Run bankroll simulation over a bet list. Mutates stake/result/bankroll in-place."""
    bankroll = starting_bankroll
    peak     = bankroll
    mdd      = 0.0
    curve: list[dict] = []

    for bet in bets:
        mp    = bet['market_q'] if bet['side'] == 'blue' else 1 - bet['market_q']
        odds  = (1 - mp) / mp
        fee   = bet['fee_pct'] / 100
        f     = min(bet['kelly_f'], 0.20)
        stake = f * bankroll

        if bet['won']:
            profit = stake * odds * (1 - fee)
            bankroll += profit
            bet['result'] = round(profit, 2)
        else:
            bankroll -= stake
            bet['result'] = round(-stake, 2)

        bet['stake']    = round(stake, 2)
        bet['bankroll'] = round(bankroll, 2)

        if bankroll > peak:
            peak = bankroll
        mdd = max(mdd, peak - bankroll)

        last = curve[-1] if curve else None
        if last and last['date'] == bet['date']:
            last['bankroll'] = round(bankroll)
        else:
            curve.append({'date': bet['date'], 'bankroll': round(bankroll)})

    wins = sum(1 for b in bets if b['won'])
    return {
        'final':    round(bankroll, 2),
        'pnl':      round(bankroll - starting_bankroll, 2),
        'pct':      round((bankroll - starting_bankroll) / starting_bankroll * 100, 2),
        'win_rate': round(wins / len(bets) * 100, 2) if bets else 0,
        'mdd':      round(mdd, 2),
        'curve':    curve,
    }


def region_stats(bets: list[dict]) -> list[dict]:
    from collections import defaultdict
    by_league: dict = defaultdict(lambda: {'bets': 0, 'wins': 0, 'pnl': 0.0})
    for b in bets:
        lg = b['league']
        by_league[lg]['bets'] += 1
        by_league[lg]['wins'] += int(b['won'])
        by_league[lg]['pnl'] += b.get('result', 0) or 0
    return [
        {
            'league':   lg,
            'n_bets':   s['bets'],
            'win_rate': round(s['wins'] / s['bets'] * 100, 2) if s['bets'] else 0,
            'pnl':      round(s['pnl'], 2),
        }
        for lg, s in sorted(by_league.items())
    ]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("Loading existing backtest.json …")
    with open(BACKTEST) as f:
        existing = json.load(f)

    starting_bankroll = existing['starting_bankroll']
    fee_poly          = existing['fee_pct']   # 2 (percent)

    # Existing LCK/LEC/LPL bets (kelly_5pct filter) — preserve won/market_q/kelly_f
    existing_bets = existing['bets']
    # Add fee_pct field for re-simulation
    for b in existing_bets:
        b['fee_pct'] = fee_poly

    print(f"  {len(existing_bets)} existing LCK/LEC/LPL bets loaded")

    print("Training model on LCK/LEC/LPL 2024–2025 …")
    features_major = pd.read_csv(FEAT_MAJOR)
    model = train_model(features_major)

    print("Generating LCS 2026 bets …")
    features_all = pd.read_csv(FEAT_ALL, low_memory=False)
    lcs26 = features_all[(features_all['league'] == 'LCS') &
                          (features_all['year'] == 2026)].copy()
    lcs_bets = make_bets(lcs26, model, kelly_threshold=0.05, fee_pct=0)
    print(f"  {len(lcs_bets)} LCS bets pass half-Kelly > 5% filter "
          f"(from {lcs26['q_blue_win'].notna().sum()} games with odds)")

    # ------------------------------------------------------------------
    # Simulate LCS standalone
    # ------------------------------------------------------------------
    lcs_bets_copy = [dict(b) for b in lcs_bets]
    lcs_stats = simulate(lcs_bets_copy, starting_bankroll)
    print(f"  LCS only: ${lcs_stats['final']:,.0f} ({lcs_stats['pct']:+.1f}%)  "
          f"WR {lcs_stats['win_rate']:.1f}%  MDD ${lcs_stats['mdd']:,.0f}")

    # ------------------------------------------------------------------
    # Simulate combined (LCK/LEC/LPL existing + LCS, merged by date)
    # ------------------------------------------------------------------
    # Re-simulate existing bets from scratch (using stored kelly_f + won)
    existing_copy = [dict(b) for b in existing_bets]
    lcs_for_combined = [dict(b) for b in lcs_bets]
    combined = sorted(existing_copy + lcs_for_combined, key=lambda b: b['date'])
    combined_stats = simulate(combined, starting_bankroll)
    print(f"  Combined:  ${combined_stats['final']:,.0f} ({combined_stats['pct']:+.1f}%)  "
          f"WR {combined_stats['win_rate']:.1f}%  MDD ${combined_stats['mdd']:,.0f}")

    # Per-region stats on combined bets (after simulation so result is populated)
    reg_stats = region_stats(combined)
    for r in reg_stats:
        print(f"    {r['league']}: {r['n_bets']} bets  WR {r['win_rate']:.1f}%  P&L ${r['pnl']:+,.0f}")

    # Re-simulate existing bets too (to get consistent results with fee fix)
    existing_resim = [dict(b) for b in existing_bets]
    existing_stats = simulate(existing_resim, starting_bankroll)

    # ------------------------------------------------------------------
    # Build updated backtest.json
    # ------------------------------------------------------------------
    new_filters = list(existing['filters'])  # keep existing 5 filters

    def make_filter(key, label, bets_list, stats, n_total):
        return {
            'key':      key,
            'label':    label,
            'n_bets':   len(bets_list),
            'n_total':  n_total,
            'final':    stats['final'],
            'pnl':      stats['pnl'],
            'pct':      stats['pct'],
            'win_rate': stats['win_rate'],
            'mdd':      stats['mdd'],
        }

    lcs_n_total = int(lcs26['q_blue_win'].notna().sum())
    combined_n_total = existing['filters'][4]['n_total'] + lcs_n_total

    new_filters.append(make_filter(
        'lcs_only', 'LCS Only', lcs_bets_copy, lcs_stats, lcs_n_total))
    new_filters.append(make_filter(
        'with_lcs', '+LCS', combined, combined_stats, combined_n_total))

    new_curves = dict(existing['curves'])
    new_curves['lcs_only'] = lcs_stats['curve']
    new_curves['with_lcs'] = combined_stats['curve']

    out = {
        'generated':        datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'starting_bankroll': starting_bankroll,
        'fee_pct':          fee_poly,
        'filters':          new_filters,
        'bets':             existing['bets'],  # keep original kelly_5pct bets
        'lcs_bets':         lcs_bets_copy,
        'curves':           new_curves,
        'region_stats':     reg_stats,
    }

    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f"\nWrote {OUT}")


if __name__ == '__main__':
    main()
