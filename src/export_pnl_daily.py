"""
export_pnl_daily.py
Pulls Polymarket + Kalshi trade history, buckets cash-flow P&L by UTC date,
and writes the last 7 days + 30-day cumulative view to web/public/pnl_daily.json
for the /pnl page.

Designed to run both locally and in GitHub Actions. Reads credentials from env:
  POLYMARKET_WALLET     — proxy wallet address (defaults to lpoklpok's wallet)
  KALSHI_API_KEY        — RSA key UUID (Kalshi step skipped if missing)
  KALSHI_PRIVATE_KEY    — PEM contents (multi-line). Use KALSHI_PRIVATE_KEY_PATH
                          to point to a local .pem file instead.

LoL-only filter applied by title keyword (Polymarket) and KXLOL ticker prefix
(Kalshi).
"""
import base64
import datetime
import json
import os
import time
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

# Pull local TradingPnL/.env when present (for local runs); harmless on CI.
for env_path in (
    Path('/Users/kevinwang/2027Projects/TradingPnL/.env'),
    Path(__file__).resolve().parent.parent / '.env',
):
    if env_path.exists():
        load_dotenv(env_path)

# ── Config ──────────────────────────────────────────────────────────────────
WALLET   = os.environ.get('POLYMARKET_WALLET', '0x9560dbf536660b5fc71efbe75b144f92013b9467')
KEYWORDS = ['lol', 'game handicap', 'games total', 'first stand', 'esports world',
            'lec', 'lcs', 'lck', 'lpl', 'msi', 'worlds', 'cblol']
EXCLUDED_CIDS = {
    '0xdd61d5b118b791f379888a4c560b48a0469509e42107325126b046ea2a348b93',
    '0x9be6eece606031076710039492dbef046237321699a8129e263ee6b1190b7fa2',
}
KALSHI_PREFIXES = ['KXLOL']
OUT_PATH = Path(__file__).resolve().parent.parent / 'web' / 'public' / 'pnl_daily.json'

DATA_API  = 'https://data-api.polymarket.com'
KALSHI_URL = 'https://api.elections.kalshi.com/trade-api/v2'


# ── Polymarket ─────────────────────────────────────────────────────────────

def _fetch_polymarket() -> pd.DataFrame:
    """Realized-PnL per UTC date.

    For each market: PnL = total_sold + total_redeemed - total_bought
    Attribute the entire market's PnL to the date of its final closing
    event (last SELL or REDEEM). Markets still open contribute $0 today
    (their BUYs sit as cost basis).
    """
    rows, offset = [], 0
    while True:
        r = requests.get(f'{DATA_API}/activity',
                         params={'user': WALLET, 'limit': 500, 'offset': offset}, timeout=20)
        if not r.ok: break
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 500: break
        offset += 500
        time.sleep(0.1)
    if not rows:
        return pd.DataFrame(columns=['date','polymarket_pnl','polymarket_trades'])

    df = pd.DataFrame([{
        'timestamp':   pd.to_datetime(a['timestamp'], unit='s', utc=True),
        'type':        a.get('type', ''),
        'conditionId': a.get('conditionId', ''),
        'side':        a.get('side', ''),
        'usd_value':   float(a.get('usdcSize', 0) or 0),
        'title':       a.get('title', '') or '',
    } for a in rows])

    df = df[~df['conditionId'].isin(EXCLUDED_CIDS)]
    pat = '|'.join(KEYWORDS)
    df  = df[df['title'].str.lower().str.contains(pat, na=False)]
    df['date'] = df['timestamp'].dt.tz_convert('UTC').dt.date

    # Per-market PnL = sold + redeemed + rewards - bought; attribute to close date
    trades  = df[df['type'] == 'TRADE']
    redeems = df[df['type'] == 'REDEEM']
    rewards = df[df['type'].isin(['REWARD', 'MAKER_REBATE'])]

    market_pnl = []
    for cid in df['conditionId'].unique():
        t = trades [trades ['conditionId'] == cid]
        r = redeems[redeems['conditionId'] == cid]
        w = rewards[rewards['conditionId'] == cid]
        bought   = t[t['side'] == 'BUY']['usd_value'].sum()
        sold     = t[t['side'] == 'SELL']['usd_value'].sum()
        redeemed = r['usd_value'].sum()
        rebate   = w['usd_value'].sum()
        # Closing events: SELLs + REDEEMs. If none, market is still open → skip (PnL = 0 so far).
        closes = pd.concat([t[t['side'] == 'SELL'], r])
        if len(closes) == 0:
            continue
        close_date = closes['timestamp'].max().tz_convert('UTC').date()
        pnl        = sold + redeemed + rebate - bought
        market_pnl.append({'date': close_date, 'pnl': pnl})

    pnl_df = pd.DataFrame(market_pnl)

    # Daily trade count = count of TRADE activity on that date (BUYs count too,
    # since they represent active trading even if PnL is deferred).
    trade_counts = trades.groupby('date').size().rename('polymarket_trades').reset_index()

    if pnl_df.empty:
        daily = trade_counts.rename(columns={'polymarket_trades':'polymarket_trades'})
        daily['polymarket_pnl'] = 0.0
        return daily[['date','polymarket_pnl','polymarket_trades']]

    pnl_daily = pnl_df.groupby('date')['pnl'].sum().rename('polymarket_pnl').reset_index()
    merged = pnl_daily.merge(trade_counts, on='date', how='outer').fillna(0)
    merged['polymarket_trades'] = merged['polymarket_trades'].astype(int)
    return merged


# ── Kalshi ─────────────────────────────────────────────────────────────────

def _load_kalshi_pem() -> str | None:
    """Return PEM contents (string) or None if not configured."""
    pem = os.environ.get('KALSHI_PRIVATE_KEY')
    if pem:
        return pem.replace('\\n', '\n')  # GH Actions sometimes escapes newlines
    pem_path = os.environ.get('KALSHI_PRIVATE_KEY_PATH')
    if pem_path and Path(pem_path).exists():
        return Path(pem_path).read_text()
    return None


def _kalshi_sign(key_id: str, pem: str, method: str, path: str) -> dict:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    ts  = str(int(time.time() * 1000))
    msg = (ts + method.upper() + '/trade-api/v2' + path).encode()
    private_key = serialization.load_pem_private_key(pem.encode(), password=None)
    sig = private_key.sign(
        msg,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=padding.PSS.MAX_LENGTH),
        hashes.SHA256(),
    )
    return {
        'KALSHI-ACCESS-KEY':       key_id,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': base64.b64encode(sig).decode(),
        'Content-Type':            'application/json',
    }


def _kalshi_get(path: str, key_id: str, pem: str, params: dict = None) -> dict:
    headers = _kalshi_sign(key_id, pem, 'GET', path)
    r = requests.get(f'{KALSHI_URL}{path}', headers=headers, params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def _paginate(path: str, list_key: str, key_id: str, pem: str) -> list:
    rows, cursor = [], None
    while True:
        params = {'limit': 200}
        if cursor: params['cursor'] = cursor
        data   = _kalshi_get(path, key_id, pem, params)
        batch  = data.get(list_key, [])
        rows.extend(batch)
        cursor = data.get('cursor')
        if not cursor or not batch: break
        time.sleep(0.15)
    return rows


def _fetch_kalshi() -> pd.DataFrame:
    """Realized-PnL per UTC date.

    For each ticker: PnL = revenue (from settlement + SELL fills) - cost (BUY fills).
    Attribute the entire ticker's PnL to the date of its final closing event
    (settlement or last SELL). Open positions contribute $0.
    """
    key_id = os.environ.get('KALSHI_API_KEY', '').strip()
    pem    = _load_kalshi_pem()
    if not (key_id and pem):
        raise RuntimeError('Kalshi credentials missing (KALSHI_API_KEY + KALSHI_PRIVATE_KEY)')

    def _keep(t: str) -> bool:
        return any(str(t).startswith(p) for p in KALSHI_PREFIXES) if KALSHI_PREFIXES else True

    fills = []
    for f in _paginate('/portfolio/fills', 'fills', key_id, pem):
        ticker = f.get('ticker') or f.get('market_ticker', '')
        if not _keep(ticker): continue
        action = (f.get('action') or '').upper()
        side   = (f.get('side') or '').upper()
        price  = float((f.get('yes_price_dollars') if side == 'YES'
                         else f.get('no_price_dollars')) or 0)
        count  = float(f.get('count_fp', 0) or 0)
        usd    = price * count
        ts     = pd.to_datetime(f.get('created_time', ''), utc=True)
        if pd.isna(ts): continue
        fills.append({'ticker': ticker, 'ts': ts, 'action': action, 'usd': usd})

    settlements = []
    for s in _paginate('/portfolio/settlements', 'settlements', key_id, pem):
        ticker  = s.get('ticker', '')
        if not _keep(ticker): continue
        revenue = int(s.get('revenue', 0) or 0) / 100
        ts      = pd.to_datetime(s.get('settled_time', ''), utc=True)
        if pd.isna(ts): continue
        settlements.append({'ticker': ticker, 'ts': ts, 'revenue': revenue})

    fills_df = pd.DataFrame(fills)
    sett_df  = pd.DataFrame(settlements)

    # Per-ticker PnL = sells + settlement_revenue - buys; attribute to close date
    tickers = set(fills_df['ticker']) if not fills_df.empty else set()
    if not sett_df.empty:
        tickers |= set(sett_df['ticker'])

    market_pnl = []
    for ticker in tickers:
        tf = fills_df[fills_df['ticker'] == ticker] if not fills_df.empty else pd.DataFrame()
        ts = sett_df [sett_df ['ticker'] == ticker] if not sett_df.empty  else pd.DataFrame()
        bought   = tf[tf['action'] == 'BUY']['usd'].sum() if not tf.empty else 0
        sold     = tf[tf['action'] == 'SELL']['usd'].sum() if not tf.empty else 0
        redeemed = ts['revenue'].sum() if not ts.empty else 0
        # Closing events: SELLs + settlements
        close_events = pd.concat([
            tf[tf['action'] == 'SELL'][['ts']] if not tf.empty else pd.DataFrame(columns=['ts']),
            ts[['ts']] if not ts.empty else pd.DataFrame(columns=['ts']),
        ])
        if close_events.empty:
            continue
        close_date = close_events['ts'].max().tz_convert('UTC').date()
        market_pnl.append({'date': close_date, 'pnl': sold + redeemed - bought})

    pnl_df = pd.DataFrame(market_pnl)
    fill_dates = (
        fills_df.assign(date=lambda d: d['ts'].dt.tz_convert('UTC').dt.date)
                .groupby('date').size().rename('kalshi_trades').reset_index()
    ) if not fills_df.empty else pd.DataFrame(columns=['date','kalshi_trades'])

    if pnl_df.empty:
        if fill_dates.empty:
            return pd.DataFrame(columns=['date','kalshi_pnl','kalshi_trades'])
        fill_dates['kalshi_pnl'] = 0.0
        return fill_dates[['date','kalshi_pnl','kalshi_trades']]

    pnl_daily = pnl_df.groupby('date')['pnl'].sum().rename('kalshi_pnl').reset_index()
    merged = pnl_daily.merge(fill_dates, on='date', how='outer').fillna(0)
    merged['kalshi_trades'] = merged['kalshi_trades'].astype(int)
    return merged


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    print('Fetching Polymarket activity…')
    pm_daily = _fetch_polymarket()
    print(f'  {len(pm_daily)} Polymarket days')

    print('Fetching Kalshi fills+settlements…')
    try:
        ka_daily = _fetch_kalshi()
        print(f'  {len(ka_daily)} Kalshi days')
        kalshi_available = True
    except Exception as e:
        print(f'  Kalshi fetch failed: {e!r}')
        ka_daily = pd.DataFrame(columns=['date','kalshi_pnl','kalshi_trades'])
        kalshi_available = False

    merged = pm_daily.merge(ka_daily, on='date', how='outer').fillna(0)
    merged['date'] = pd.to_datetime(merged['date'])
    merged = merged.sort_values('date')
    merged['total_pnl'] = merged['polymarket_pnl'] + merged['kalshi_pnl']

    today = pd.Timestamp.utcnow().normalize().tz_localize(None)

    win30 = merged[merged['date'] >= today - pd.Timedelta(days=30)].copy()
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

    by_date = {row['date']: row for _, row in merged.iterrows()}
    days = []
    for i in range(6, -1, -1):
        d = today - pd.Timedelta(days=i)
        r = by_date.get(d)
        if r is not None:
            days.append({
                'date':              d.strftime('%Y-%m-%d'),
                'polymarket_pnl':    round(float(r['polymarket_pnl']), 2),
                'kalshi_pnl':        round(float(r['kalshi_pnl']), 2),
                'total_pnl':         round(float(r['total_pnl']), 2),
                'polymarket_trades': int(r.get('polymarket_trades', 0) or 0),
                'kalshi_trades':     int(r.get('kalshi_trades', 0) or 0),
            })
        else:
            days.append({'date': d.strftime('%Y-%m-%d'),
                         'polymarket_pnl': 0.0, 'kalshi_pnl': 0.0, 'total_pnl': 0.0,
                         'polymarket_trades': 0, 'kalshi_trades': 0})

    totals = {
        'polymarket_pnl_7d':    round(sum(d['polymarket_pnl'] for d in days), 2),
        'kalshi_pnl_7d':        round(sum(d['kalshi_pnl'] for d in days), 2),
        'total_pnl_7d':         round(sum(d['total_pnl'] for d in days), 2),
        'polymarket_trades_7d': sum(d['polymarket_trades'] for d in days),
        'kalshi_trades_7d':     sum(d['kalshi_trades'] for d in days),
    }

    out = {
        'generated_at_utc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'wallet':           WALLET,
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
