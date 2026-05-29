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
_DEFAULT_WALLET = '0x9560dbf536660b5fc71efbe75b144f92013b9467'
WALLET   = (os.environ.get('POLYMARKET_WALLET') or '').strip() or _DEFAULT_WALLET
KEYWORDS = ['lol', 'game handicap', 'games total', 'first stand', 'esports world',
            'lec', 'lcs', 'lck', 'lpl', 'msi', 'worlds', 'cblol']
EXCLUDED_CIDS = {
    '0xdd61d5b118b791f379888a4c560b48a0469509e42107325126b046ea2a348b93',
    '0x9be6eece606031076710039492dbef046237321699a8129e263ee6b1190b7fa2',
}
KALSHI_PREFIXES = ['KXLOL']
START_DATE = pd.Timestamp('2026-02-01', tz=None)  # cover all historical LoL activity; UI filters by post-model-era (2026-05-18+)
MODEL_ERA_START = pd.Timestamp('2026-05-18', tz=None)  # the "I built a model" cutoff — used as a label/preset on the UI
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
            is_closed = bool(j.get('closed'))
            out = {}
            for tok in j.get('tokens', []):
                outcome = str(tok.get('outcome', '')).lower()
                winner  = tok.get('winner')
                # Only trust winner flag when the market is fully closed.
                # Unfinalized markets (UMA "proposed" state) often have
                # winner=false on BOTH tokens — use price instead.
                if is_closed and winner is True:
                    out[outcome] = 1.0
                elif is_closed and winner is False:
                    out[outcome] = 0.0
                else:
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


def _fetch_kalshi_realized_from_csv() -> pd.DataFrame:
    """Read closed (realized) Kalshi LoL trades from the manually-exported
    transactions CSV. Source of truth for historical PnL since the API's
    /portfolio/fills caps at ~200 most-recent fills and can't reach back
    to Feb. Realized PnL is signed cents (incl fees); attribute to the
    close timestamp's UTC date.

    Re-download from Kalshi UI → Activity → Download CSV when new trades
    close, and replace data/kalshi/transactions.csv.
    """
    from pathlib import Path
    csv_path = Path(__file__).resolve().parent.parent / 'data' / 'kalshi' / 'transactions.csv'
    if not csv_path.exists():
        print(f'  Kalshi CSV missing at {csv_path} — falling back to API only')
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])
    df = pd.read_csv(csv_path)
    # Only completed trades (skip deposits/withdrawals/etc.)
    df = df[df['type'] == 'trade']
    # LoL only
    df = df[df['market_ticker'].astype(str).str.startswith(tuple(KALSHI_PREFIXES))]
    if df.empty:
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])
    df['close_dt']  = pd.to_datetime(df['close_timestamp'], utc=True)
    df['date']      = df['close_dt'].dt.date
    df['pnl']       = df['realized_pnl_with_fees_cents'].astype(float) / 100.0
    daily = df.groupby('date').agg(
        kalshi_pnl=('pnl', 'sum'),
        kalshi_trades=('pnl', 'size'),
    ).reset_index()
    return daily


def _fetch_kalshi_unrealized_mtm() -> pd.DataFrame:
    """Mark-to-market PnL for currently-open Kalshi LoL positions, attributed
    to today's date. Uses /portfolio/positions (returns current state) so it
    doesn't depend on the /portfolio/fills history cap.
    """
    key_id = os.environ.get('KALSHI_API_KEY', '').strip()
    pem    = _load_kalshi_pem()
    if not (key_id and pem):
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])
    try:
        positions = list(_paginate('/portfolio/positions', 'market_positions', key_id, pem))
    except Exception as e:
        print(f'  Kalshi positions API error: {e}')
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])

    # Filter to LoL with non-zero position
    lol = [p for p in positions
           if any(str(p.get('ticker','')).startswith(pfx) for pfx in KALSHI_PREFIXES)
           and float(p.get('position_fp') or 0) != 0]
    if not lol:
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])

    # Mark each open position
    from concurrent.futures import ThreadPoolExecutor
    def _yes_mid(ticker):
        try:
            r = requests.get(f'{KALSHI_URL}/markets/{ticker}', timeout=8)
            if r.status_code != 200: return ticker, None
            m = r.json().get('market', {})
            st = (m.get('status') or '').lower()
            if st in ('finalized', 'settled', 'closed'):
                res = (m.get('result') or '').lower()
                if res == 'yes': return ticker, 1.0
                if res == 'no':  return ticker, 0.0
            def _f(v):
                try: return float(v) if v is not None else None
                except (ValueError, TypeError): return None
            yb = _f(m.get('yes_bid_dollars')) or _f(m.get('yes_bid'))
            ya = _f(m.get('yes_ask_dollars')) or _f(m.get('yes_ask'))
            if yb is not None and yb > 1: yb /= 100
            if ya is not None and ya > 1: ya /= 100
            if yb is not None and ya is not None: return ticker, (yb + ya) / 2
            return ticker, None
        except Exception:
            return ticker, None
    tickers = sorted({p['ticker'] for p in lol})
    mid: dict[str, float] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for tk, px in ex.map(_yes_mid, tickers):
            if px is not None: mid[tk] = px

    total_unrealized = 0.0
    for p in lol:
        tk = p['ticker']
        pos = float(p.get('position_fp') or 0)        # +YES / -NO contracts
        cost = float(p.get('market_exposure_dollars') or 0)  # cost basis in $
        ym = mid.get(tk)
        if ym is None: continue
        is_yes = pos > 0
        contracts = abs(pos)
        mid_for_side = ym if is_yes else (1 - ym)
        current_value = contracts * mid_for_side
        total_unrealized += current_value - cost

    today = pd.Timestamp.utcnow().normalize().date()
    if abs(total_unrealized) < 0.005:
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])
    return pd.DataFrame([{'date': today, 'kalshi_pnl': round(total_unrealized, 2), 'kalshi_trades': 0}])


def _fetch_kalshi() -> pd.DataFrame:
    """Combined Kalshi PnL: historical realized from CSV + current open MTM
    from API. Realized PnL is the canonical Kalshi number with fees; MTM
    reflects today's mark on open positions.
    """
    realized = _fetch_kalshi_realized_from_csv()
    open_mtm = _fetch_kalshi_unrealized_mtm()
    if realized.empty and open_mtm.empty:
        return pd.DataFrame(columns=['date', 'kalshi_pnl', 'kalshi_trades'])
    combined = pd.concat([realized, open_mtm], ignore_index=True)
    return combined.groupby('date').agg(
        kalshi_pnl=('kalshi_pnl', 'sum'),
        kalshi_trades=('kalshi_trades', 'sum'),
    ).reset_index()


def _fetch_kalshi_LEGACY() -> pd.DataFrame:
    """[DEPRECATED — kept for reference only. /portfolio/fills caps at ~200
    most-recent fills and can't see February.]"""
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
        """Return current YES-side price for a Kalshi market (or 1.0/0.0 if
        resolved). Kalshi's current API uses *_dollars suffix (string dollars)
        for prices; settlement uses status='finalized' + result in {yes,no}.
        For void/other resolutions, fall back to settlement_value_dollars."""
        try:
            r = requests.get(f'{KALSHI_URL}/markets/{ticker}', timeout=8)
            if r.status_code != 200: return ticker, None
            m  = r.json().get('market', {})
            st = (m.get('status') or '').lower()
            if st in ('finalized', 'settled', 'closed'):
                res = (m.get('result') or '').lower()
                if res == 'yes': return ticker, 1.0
                if res == 'no':  return ticker, 0.0
                # Void / partial: try settlement_value_dollars (string in $)
                sv = m.get('settlement_value_dollars')
                if sv is not None:
                    try: return ticker, float(sv)
                    except (ValueError, TypeError): pass
            # Open market — try yes_bid/ask midpoint with both modern (*_dollars
            # string) and legacy (cents number) field names, then fall back to
            # last_price.
            def _f(v):
                if v is None: return None
                try: return float(v)
                except (ValueError, TypeError): return None
            yb = _f(m.get('yes_bid_dollars')) or _f(m.get('yes_bid'))
            ya = _f(m.get('yes_ask_dollars')) or _f(m.get('yes_ask'))
            # Legacy cents → dollars
            if yb is not None and yb > 1: yb = yb / 100
            if ya is not None and ya > 1: ya = ya / 100
            if yb is not None and ya is not None:
                return ticker, (yb + ya) / 2
            lp = _f(m.get('last_price_dollars')) or _f(m.get('last_price'))
            if lp is not None:
                return ticker, lp / 100 if lp > 1 else lp
            # Try inverse from no-side if yes-side empty
            nb = _f(m.get('no_bid_dollars')) or _f(m.get('no_bid'))
            na = _f(m.get('no_ask_dollars')) or _f(m.get('no_ask'))
            if nb is not None and nb > 1: nb = nb / 100
            if na is not None and na > 1: na = na / 100
            if nb is not None and na is not None:
                return ticker, 1 - (nb + na) / 2
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

    # Build all days from START_DATE through today (inclusive).
    by_date = {row['date']: row for _, row in merged.iterrows()}
    days = []
    d = START_DATE
    while d <= today:
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
        d = d + pd.Timedelta(days=1)

    # Cumulative line: running sum from START_DATE.
    cum = 0.0
    cumulative = []
    for r in days:
        cum += r['total_pnl']
        cumulative.append({
            'date':            r['date'],
            'polymarket_pnl':  r['polymarket_pnl'],
            'kalshi_pnl':      r['kalshi_pnl'],
            'total_pnl':       r['total_pnl'],
            'cum_pnl':         round(cum, 2),
        })

    totals = {
        'polymarket_pnl':    round(sum(d['polymarket_pnl'] for d in days), 2),
        'kalshi_pnl':        round(sum(d['kalshi_pnl'] for d in days), 2),
        'total_pnl':         round(sum(d['total_pnl'] for d in days), 2),
        'polymarket_trades': sum(d['polymarket_trades'] for d in days),
        'kalshi_trades':     sum(d['kalshi_trades'] for d in days),
    }

    out = {
        'generated_at_utc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'wallet':           WALLET,
        'kalshi_available': kalshi_available,
        'start_date':       START_DATE.strftime('%Y-%m-%d'),
        'model_era_start':  MODEL_ERA_START.strftime('%Y-%m-%d'),
        'days':             days,
        'totals':           totals,
        'cumulative':       cumulative,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'Wrote {OUT_PATH} — totals since {START_DATE.date()}: PM ${totals["polymarket_pnl"]:+,.0f}, '
          f'Kalshi ${totals["kalshi_pnl"]:+,.0f}, total ${totals["total_pnl"]:+,.0f}')


if __name__ == '__main__':
    main()
