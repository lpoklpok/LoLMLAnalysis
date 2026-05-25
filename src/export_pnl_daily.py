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
    """Trade-date mark-to-current PnL.

    For each TRADE: value the position at the current outcome price (or
    settle price if resolved), compute PnL from the entry price, attribute
    to the trade's UTC date.
      BUY:  pnl = size * (current_mid - price)
      SELL: pnl = size * (price - current_mid)   (short closed at current)
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
        'asset':       a.get('asset', '') or '',
        'outcome':     a.get('outcome', '') or '',
        'side':        a.get('side', ''),
        'price':       float(a.get('price', 0) or 0),
        'size':        float(a.get('size', 0) or 0),
        'usd_value':   float(a.get('usdcSize', 0) or 0),
        'title':       a.get('title', '') or '',
    } for a in rows])

    df = df[~df['conditionId'].isin(EXCLUDED_CIDS)]
    pat = '|'.join(KEYWORDS)
    df  = df[df['title'].str.lower().str.contains(pat, na=False)]

    trades = df[df['type'] == 'TRADE'].copy()
    if trades.empty:
        return pd.DataFrame(columns=['date','polymarket_pnl','polymarket_trades'])

    # Fetch current price for each unique (conditionId, outcome) via clob.markets
    # which works for both open AND resolved markets.
    unique_conds = trades['conditionId'].unique().tolist()
    print(f'  Looking up current/settle prices for {len(unique_conds)} markets…')

    from concurrent.futures import ThreadPoolExecutor

    def _market_prices(cond):
        # Returns dict {outcome.lower(): current_or_settle_price} or None.
        try:
            r = requests.get(f'https://clob.polymarket.com/markets/{cond}', timeout=8)
            if r.status_code != 200:
                return cond, None
            j = r.json()
            out = {}
            for tok in j.get('tokens', []):
                outcome = str(tok.get('outcome', '')).lower()
                winner  = tok.get('winner')
                if winner is True:  out[outcome] = 1.0
                elif winner is False: out[outcome] = 0.0
                else:
                    # Open market — use last trade price as proxy for current mid
                    pr = tok.get('price')
                    if pr is not None:
                        try: out[outcome] = float(pr)
                        except: pass
            # Fallback: if no price on tokens, try gamma outcomePrices
            if not out:
                import json as _json
                gr = requests.get('https://gamma-api.polymarket.com/markets',
                                  params={'condition_ids': cond}, timeout=8)
                if gr.status_code == 200 and gr.json():
                    m = gr.json()[0]
                    outs = m.get('outcomes'); ops = m.get('outcomePrices')
                    if isinstance(outs, str): outs = _json.loads(outs)
                    if isinstance(ops, str):  ops  = _json.loads(ops)
                    if outs and ops:
                        for o, p in zip(outs, ops):
                            try: out[str(o).lower()] = float(p)
                            except: pass
            return cond, out
        except Exception:
            return cond, None

    price_map: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=15) as ex:
        for cond, prices in ex.map(_market_prices, unique_conds):
            price_map[cond] = prices or {}

    missing = sum(1 for c in unique_conds if not price_map.get(c))
    if missing:
        print(f'  Missing prices for {missing}/{len(unique_conds)} markets (defaulting to entry price for those — PnL=0)')

    def trade_pnl(row):
        prices = price_map.get(row['conditionId']) or {}
        target = str(row['outcome']).lower()
        current = prices.get(target)
        if current is None:
            return 0.0  # unknown price → conservatively assume break-even
        if row['side'] == 'BUY':
            return row['size'] * (current - row['price'])
        if row['side'] == 'SELL':
            return row['size'] * (row['price'] - current)
        return 0.0

    trades['pnl']  = trades.apply(trade_pnl, axis=1)
    trades['date'] = trades['timestamp'].dt.tz_convert('UTC').dt.date

    return trades.groupby('date').agg(
        polymarket_pnl=('pnl', 'sum'),
        polymarket_trades=('pnl', 'size'),
    ).reset_index()


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
    """Trade-date mark-to-current PnL.

    For each fill: value the position at the current Kalshi mid (or settle
    if resolved), compute PnL from the entry price, attribute to the fill's
    UTC date. BUY YES at $0.40 + current $0.55 → PnL = size * 0.15.
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
        side   = (f.get('side') or '').upper()  # YES or NO
        price  = float((f.get('yes_price_dollars') if side == 'YES'
                         else f.get('no_price_dollars')) or 0)
        count  = float(f.get('count_fp', 0) or 0)
        ts     = pd.to_datetime(f.get('created_time', ''), utc=True)
        if pd.isna(ts): continue
        fills.append({'ticker': ticker, 'ts': ts, 'action': action, 'side': side,
                      'price': price, 'count': count})

    if not fills:
        return pd.DataFrame(columns=['date','kalshi_pnl','kalshi_trades'])

    fills_df = pd.DataFrame(fills)
    unique_tickers = fills_df['ticker'].unique().tolist()
    print(f'  Looking up current/settle prices for {len(unique_tickers)} Kalshi markets…')

    # For each ticker, fetch current YES price (or settle if closed).
    # Public endpoint — no auth needed for /markets.
    def _ticker_price(ticker):
        try:
            r = requests.get(f'{KALSHI_URL}/markets/{ticker}', timeout=8)
            if r.status_code != 200: return ticker, None
            m  = r.json().get('market', {})
            st = m.get('status', '')
            if st in ('finalized', 'settled', 'closed'):
                res = m.get('result', '')
                if res == 'yes': return ticker, 1.0
                if res == 'no':  return ticker, 0.0
            # Open market — use yes_bid/yes_ask midpoint, or last_price
            yb = m.get('yes_bid'); ya = m.get('yes_ask')
            if yb and ya:
                # Both are in cents
                return ticker, (yb + ya) / 2 / 100
            lp = m.get('last_price')
            if lp is not None:
                return ticker, lp / 100
            return ticker, None
        except Exception:
            return ticker, None

    from concurrent.futures import ThreadPoolExecutor
    yes_price_map: dict[str, float] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for tk, px in ex.map(_ticker_price, unique_tickers):
            if px is not None: yes_price_map[tk] = px

    def fill_pnl(row):
        yes = yes_price_map.get(row['ticker'])
        if yes is None: return 0.0
        # Convert YES price to "price for the side traded"
        current = yes if row['side'] == 'YES' else (1 - yes)
        if row['action'] == 'BUY':
            return row['count'] * (current - row['price'])
        if row['action'] == 'SELL':
            return row['count'] * (row['price'] - current)
        return 0.0

    fills_df['pnl']  = fills_df.apply(fill_pnl, axis=1)
    fills_df['date'] = fills_df['ts'].dt.tz_convert('UTC').dt.date

    return fills_df.groupby('date').agg(
        kalshi_pnl=('pnl', 'sum'),
        kalshi_trades=('pnl', 'size'),
    ).reset_index()


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
