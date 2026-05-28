"""
build_flow_features.py
Walk-forward Polymarket flow features per OE game. For each game with
matching Polymarket trades, compute the T1 price drift in the last hour
before kickoff:

    price_drift_1h = T1_last_trade_price_at_gameStart − T1_last_trade_price_1h_before
    vwap_drift_1h  = T1_VWAP_last_hour − T1_last_trade_price_at_gameStart

Notes
- "T1" = the OE blue team. We map blue_team → Polymarket outcome name via a
  small NORM dict.
- For game N of a series, we use the "game_{n}_winner" sub-market (series-
  winner falls back to match_winner if no per-game market exists).
- Output: data/processed/flow_features.csv (gameid + 2 features).
- PolymarketTrades only began logging 2026-05-24; older games get no data.
"""
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT      = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / 'data' / 'processed'
OUT       = PROCESSED / 'flow_features.csv'

# R2-hosted Parquet — much fresher than the local CSV
R2_GLOB   = 'r2://polymarket-trades/polymarket_trades/**/*.parquet'

# OE → Polymarket team name normalization (mostly the OE names work directly)
NORM = {
    'Kiwoom DRX': 'KRX',
    'DRX':        'KRX',
    'MAD Lions KOI': 'Movistar KOI',
}


def _norm(name: str) -> str:
    return NORM.get(name, name)


def main():
    need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    if not all(os.environ.get(k) for k in need):
        print(f'ERROR: set R2 env vars: {need}')
        sys.exit(1)

    print(f'Pulling trades from R2: {R2_GLOB}')
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    con.execute(f"""CREATE SECRET r2 (TYPE r2,
        KEY_ID '{os.environ['R2_ACCESS_KEY_ID']}',
        SECRET '{os.environ['R2_SECRET_ACCESS_KEY']}',
        ACCOUNT_ID '{os.environ['R2_ACCOUNT_ID']}');""")
    t = con.execute(f"""
        SELECT timestamp_utc, event_slug, team1, team2, outcome,
               side, price, size, usd_value, market_type, condition_id
        FROM '{R2_GLOB}'
    """).fetchdf()
    t['timestamp_utc'] = pd.to_datetime(t['timestamp_utc'], utc=True)
    t['team1_n']   = t['team1'].map(_norm)
    t['team2_n']   = t['team2'].map(_norm)
    t['outcome_n'] = t['outcome'].map(_norm)
    print(f'  trades: {len(t):,}, date range: {t["timestamp_utc"].min()} → {t["timestamp_utc"].max()}')

    # Pull games from Supabase (game_features) — local games_with_odds.csv
    # is often stale by a few days; Supabase has same-day data.
    from dotenv import load_dotenv
    from supabase import create_client
    load_dotenv()
    sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_KEY'])
    cutoff = (t['timestamp_utc'].min() - pd.Timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S+00:00')
    print(f'Pulling game_features from Supabase (date >= {cutoff[:10]})...')
    rows = []
    offset = 0
    while True:
        r = (sb.table('game_features')
              .select('date,league,blue_team,red_team,game_in_series')
              .gte('date', cutoff)
              .range(offset, offset + 999).execute())
        if not r.data: break
        rows.extend(r.data)
        if len(r.data) < 1000: break
        offset += 1000
    g = pd.DataFrame(rows)
    if g.empty:
        print('No matching games in Supabase.'); return
    g = g.rename(columns={'blue_team': 'blue_team_teamname',
                            'red_team':  'red_team_teamname',
                            'game_in_series': 'game'})
    # Fake a gameid for join (date+teams hash) — used only to key the output
    g['gameid'] = g['date'].astype(str) + '|' + g['blue_team_teamname'] + '|' + g['red_team_teamname']
    g['date'] = pd.to_datetime(g['date'], utc=True)
    g['blue_n'] = g['blue_team_teamname'].map(_norm)
    g['red_n']  = g['red_team_teamname'].map(_norm)
    print(f'  games in window: {len(g):,}')

    # G1 ONLY for the pre-series sharp-money test.
    # Require game_in_series == 1 from Supabase — don't synthesize G1 from
    # "earliest game we have" because that picks up G2/G3 when G1 didn't
    # make it into the data and corrupts the window.
    g_g1 = g[g['game'] == 1].copy()
    print(f'  G1 games in window (game_in_series == 1): {len(g_g1):,}')

    # ONLY match_winner trades. game_1_winner trades that happen after
    # G1 ends settle to ~0/1 and pollute the "drift" calculation when the
    # G1 result has already leaked into the post-settlement price.
    t_mw = t[t['market_type'] == 'match_winner'].copy()
    if len(t_mw) == 0:
        print('No match_winner trades available — abort.'); return
    t_mw['_pair'] = t_mw.apply(lambda r: '|'.join(sorted([r['team1_n'], r['team2_n']])), axis=1)
    by_pair = {k: df for k, df in t_mw.groupby('_pair')}
    print(f'  match_winner trades: {len(t_mw):,}, unique team-pairs: {len(by_pair)}')

    # Window: [g1 − 24h, g1 − 10min]. Markets often open ~12-24h before
    # kickoff and bulk of pre-game flow happens in that window. End 10 min
    # before to avoid the last-minute frenzy / broadcast desk reaction.
    WIN_HOURS_BACK = 24
    BUFFER_MIN     = 10

    rows = []
    matched = 0
    for r in g_g1.itertuples(index=False):
        bn, rn = r.blue_n, r.red_n
        key = '|'.join(sorted([bn, rn]))
        sub = by_pair.get(key)
        if sub is None or len(sub) == 0: continue
        game_start = r.date
        window_start = game_start - pd.Timedelta(hours=WIN_HOURS_BACK)
        window_end   = game_start - pd.Timedelta(minutes=BUFFER_MIN)
        ts = sub['timestamp_utc']
        window = sub[(ts >= window_start) & (ts <= window_end)].sort_values('timestamp_utc')
        # Require minimum liquidity — protects against single-trade markets
        # (e.g., LJL Arneb vs Uwinks where one $50 click moved the price 58pp)
        MIN_TRADES = 10
        MIN_VOLUME = 200  # USD
        if len(window) < MIN_TRADES: continue
        if window['usd_value'].sum() < MIN_VOLUME: continue

        def t1_price(row) -> float:
            return float(row['price']) if row['outcome_n'] == bn else (1.0 - float(row['price']))

        first_row = window.iloc[0]
        last_row  = window.iloc[-1]
        p_start_t1 = t1_price(first_row)
        p_end_t1   = t1_price(last_row)
        window_minutes_covered = (last_row['timestamp_utc'] - first_row['timestamp_utc']).total_seconds() / 60

        # VWAP T1 over the window
        w = window.copy()
        w['p_t1'] = w.apply(t1_price, axis=1)
        vwap = float((w['p_t1'] * w['size']).sum() / max(w['size'].sum(), 1e-9))

        rows.append({
            'gameid':           r.gameid,
            'flow_n_trades':    len(window),
            'window_minutes':   round(window_minutes_covered, 1),
            'pre_series_drift': round(p_end_t1   - p_start_t1, 6),  # within-window price move into T1
            'pre_series_vwap_drift': round(vwap  - p_end_t1, 6),    # late buyers paying above avg?
        })
        matched += 1

    out = pd.DataFrame(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(OUT, index=False)
    print(f'\nMatched {matched:,} / {len(g_g1):,} G1 games with usable pre-series flow')
    if len(out):
        print(f'  pre_series_drift:       mean={out["pre_series_drift"].mean():+.4f}  std={out["pre_series_drift"].std():.4f}')
        print(f'  pre_series_vwap_drift:  mean={out["pre_series_vwap_drift"].mean():+.4f}  std={out["pre_series_vwap_drift"].std():.4f}')
    print(f'Wrote {OUT} ({len(out):,} rows)')


if __name__ == '__main__':
    main()
