"""
export_pnl_daily.py
Pulls Polymarket + Kalshi trade history via the existing TradingPnL source modules,
buckets P&L by date using the cash-flow method, and writes the last 7 days plus
30-day cumulative history to web/public/pnl_daily.json for the /pnl page.

Reads Kalshi credentials from TradingPnL/.env (KALSHI_API_KEY, KALSHI_PRIVATE_KEY_PATH).
Reads Polymarket wallet from TradingPnL/config.json.
LoL-only filter applied (matches the config: included_title_keywords for PM,
included_ticker_prefixes for Kalshi).

Output JSON shape:
  {
    "generated_at_utc": "...",
    "wallet":           "0x9560...",
    "days": [
      {"date": "2026-05-19", "polymarket_pnl": 123.45, "kalshi_pnl": 67.89,
       "total_pnl": 191.34, "polymarket_trades": 12, "kalshi_trades": 3}
    ],
    "totals": {
      "polymarket_pnl_7d":   ...,
      "kalshi_pnl_7d":       ...,
      "total_pnl_7d":        ...,
      "polymarket_trades_7d": ...,
      "kalshi_trades_7d":     ...
    },
    "cumulative_30d": [{"date":"2026-04-25","cum_pnl":0,...}]
  }
"""
import datetime
import json
import os
import sys
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

# Reuse the existing TradingPnL source modules — they're battle-tested.
TPL_ROOT = Path('/Users/kevinwang/2027Projects/TradingPnL')
sys.path.insert(0, str(TPL_ROOT))
load_dotenv(TPL_ROOT / '.env')

from src.sources import polymarket as pm   # noqa: E402
from src.sources import kalshi    as ka    # noqa: E402

OUT_PATH = Path(__file__).resolve().parent.parent / 'web' / 'public' / 'pnl_daily.json'


def _config() -> dict:
    with open(TPL_ROOT / 'config.json') as f:
        return json.load(f)


def _polymarket_daily(cfg: dict) -> pd.DataFrame:
    """Polymarket cash-flow P&L per UTC date, filtered to LoL markets."""
    wallet   = cfg['polymarket']['wallet']
    keywords = [k.lower() for k in cfg['polymarket'].get('included_title_keywords', [])]
    excluded = set(cfg['polymarket'].get('excluded_condition_ids', {}).keys())

    activity = pm.fetch_activity(wallet)
    if activity.empty:
        return pd.DataFrame(columns=['date','polymarket_pnl','polymarket_trades'])

    activity = activity[~activity['conditionId'].isin(excluded)]
    if keywords:
        pat = '|'.join(keywords)
        activity = activity[activity['title'].str.lower().str.contains(pat, na=False)]

    activity = activity.copy()
    activity['date'] = activity['timestamp'].dt.tz_convert('UTC').dt.date

    # Cash flow:
    #   BUY  → -usd_value (cash out)
    #   SELL → +usd_value (cash in)
    #   REDEEM → +usd_value (settlement payout)
    def cash_flow(row):
        if row['type'] == 'TRADE':
            return row['usd_value'] if row['side'] == 'SELL' else -row['usd_value']
        if row['type'] == 'REDEEM':
            return row['usd_value']
        if row['type'] in ('REWARD', 'MAKER_REBATE'):
            return row['usd_value']
        return 0.0
    activity['cash'] = activity.apply(cash_flow, axis=1)

    daily = activity.groupby('date').agg(
        polymarket_pnl=('cash', 'sum'),
        polymarket_trades=('type', lambda s: (s == 'TRADE').sum()),
    ).reset_index()
    return daily


def _kalshi_daily(cfg: dict) -> pd.DataFrame:
    """Kalshi cash-flow P&L per UTC date, filtered to LoL markets."""
    prefixes = cfg['kalshi'].get('included_ticker_prefixes', [])

    fills, settlements = ka.fetch_fills(), ka.fetch_settlements()

    def _keep_ticker(t: str) -> bool:
        if not prefixes:
            return True
        return any(str(t).startswith(p) for p in prefixes)

    cash_records = []

    if not fills.empty:
        f = fills[fills['ticker'].apply(_keep_ticker)].copy()
        f['date']  = f['timestamp'].dt.tz_convert('UTC').dt.date
        # BUY → cash out, SELL → cash in (action column is BUY/SELL)
        f['cash']  = f.apply(lambda r: r['usd_value'] if r['action'] == 'SELL' else -r['usd_value'], axis=1)
        for _, r in f.iterrows():
            cash_records.append({'date': r['date'], 'cash': r['cash'], 'is_trade': True})

    if not settlements.empty:
        s = settlements[settlements['ticker'].apply(_keep_ticker)].copy()
        s['date'] = s['timestamp'].dt.tz_convert('UTC').dt.date
        # revenue net of cost is the settlement P&L; revenue is the cash inflow
        for _, r in s.iterrows():
            cash_records.append({'date': r['date'], 'cash': r['revenue'], 'is_trade': False})

    if not cash_records:
        return pd.DataFrame(columns=['date','kalshi_pnl','kalshi_trades'])

    cf = pd.DataFrame(cash_records)
    daily = cf.groupby('date').agg(
        kalshi_pnl=('cash', 'sum'),
        kalshi_trades=('is_trade', 'sum'),
    ).reset_index()
    return daily


def main():
    cfg = _config()
    print('Fetching Polymarket activity…')
    pm_daily = _polymarket_daily(cfg)
    print(f'  {len(pm_daily)} Polymarket days')

    print('Fetching Kalshi fills+settlements…')
    try:
        ka_daily = _kalshi_daily(cfg)
        print(f'  {len(ka_daily)} Kalshi days')
        kalshi_available = True
    except Exception as e:
        print(f'  Kalshi fetch failed: {e!r}')
        ka_daily = pd.DataFrame(columns=['date','kalshi_pnl','kalshi_trades'])
        kalshi_available = False

    # Merge: outer join on date so days with only one source still appear
    merged = pm_daily.merge(ka_daily, on='date', how='outer').fillna(0)
    merged['date'] = pd.to_datetime(merged['date'])
    merged = merged.sort_values('date')
    merged['total_pnl'] = merged['polymarket_pnl'] + merged['kalshi_pnl']

    # 30-day cumulative window for the chart
    today  = pd.Timestamp.utcnow().normalize().tz_localize(None)
    win30  = merged[merged['date'] >= today - pd.Timedelta(days=30)].copy()
    win30['cum_pnl'] = win30['total_pnl'].cumsum()
    cumulative_30d = [
        {'date': d.strftime('%Y-%m-%d'),
         'polymarket_pnl': round(p, 2),
         'kalshi_pnl':     round(k, 2),
         'total_pnl':      round(t, 2),
         'cum_pnl':        round(c, 2)}
        for d, p, k, t, c in zip(win30['date'], win30['polymarket_pnl'],
                                  win30['kalshi_pnl'], win30['total_pnl'], win30['cum_pnl'])
    ]

    # 7-day breakdown table (back-fill missing days with zeros)
    win7_dates = [today - pd.Timedelta(days=i) for i in range(6, -1, -1)]
    by_date = {row['date']: row for _, row in merged.iterrows()}
    days = []
    for d in win7_dates:
        if d in by_date:
            r = by_date[d]
            days.append({
                'date':              d.strftime('%Y-%m-%d'),
                'polymarket_pnl':    round(float(r['polymarket_pnl']), 2),
                'kalshi_pnl':        round(float(r['kalshi_pnl']), 2),
                'total_pnl':         round(float(r['total_pnl']), 2),
                'polymarket_trades': int(r.get('polymarket_trades', 0) or 0),
                'kalshi_trades':     int(r.get('kalshi_trades', 0) or 0),
            })
        else:
            days.append({
                'date': d.strftime('%Y-%m-%d'),
                'polymarket_pnl': 0.0, 'kalshi_pnl': 0.0, 'total_pnl': 0.0,
                'polymarket_trades': 0, 'kalshi_trades': 0,
            })

    totals = {
        'polymarket_pnl_7d':    round(sum(d['polymarket_pnl'] for d in days), 2),
        'kalshi_pnl_7d':        round(sum(d['kalshi_pnl'] for d in days), 2),
        'total_pnl_7d':         round(sum(d['total_pnl'] for d in days), 2),
        'polymarket_trades_7d': sum(d['polymarket_trades'] for d in days),
        'kalshi_trades_7d':     sum(d['kalshi_trades'] for d in days),
    }

    out = {
        'generated_at_utc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'wallet':           cfg['polymarket']['wallet'],
        'kalshi_available': kalshi_available,
        'days':             days,
        'totals':           totals,
        'cumulative_30d':   cumulative_30d,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'Wrote {OUT_PATH} — totals: PM ${totals["polymarket_pnl_7d"]:+,.0f}, '
          f'Kalshi ${totals["kalshi_pnl_7d"]:+,.0f}, total ${totals["total_pnl_7d"]:+,.0f}')


if __name__ == '__main__':
    main()
