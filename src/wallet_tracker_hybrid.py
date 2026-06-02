"""Hybrid wallet tracker: WebSocket primary + polling reconciler.

Addresses the failure modes pure-WSS hits:
  1. Polymarket's activity stream silently stops delivering after ~20 min
     (known GitHub issue) — solved with a proactive reconnect timer at 15 min
  2. Naive reconnects can lose messages during the gap — solved by running
     /trades polling at 20s as a backstop that catches anything WSS missed
  3. Both sources hitting the same trade — solved by a dedup set keyed on
     transactionHash + asset_id (the canonical fill identifier)

Architecture:
  ┌─────────────────────┐    ┌──────────────────┐
  │ WSS task            │    │ poll task        │
  │ - subscribe trades  │    │ - /trades?user=X │
  │ - per-msg watchdog  │    │   per wallet     │
  │ - 15-min recycle    │    │ - every 20s      │
  └──────────┬──────────┘    └────────┬─────────┘
             │ (proxyWallet match)    │
             ▼                        ▼
        ┌─────────────────────────────────┐
        │ shared async queue              │
        │ → dedup by (tx_hash, asset_id) │
        │ → enrich (pregame check)        │
        │ → CSV + Discord                 │
        │ → log source: 'ws' or 'poll'    │
        └─────────────────────────────────┘
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    CT_TZ = ZoneInfo('America/Chicago')
except Exception:
    CT_TZ = None

import aiohttp
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(levelname)s  %(message)s')
log = logging.getLogger('hybrid')

# Source of truth = Supabase `sharks` table (editable from the /sharks page).
# This module-level dict is refreshed by sync_watch_task() every 60s; the
# fallback below seeds initial boot if Supabase is unreachable.
WATCH_LIST: dict[str, str] = {
    '0x9c76cdb43fb46454da005fbc82047a64a18ec926': 'Bagwell306',
    '0x9a4cf053d6788a095da9be5e811e73131f491f30': 'AmaHnk',
    '0x0a6356d95e871f7288063d56a2db518ea004fc03': 'f3arless',
    '0xda3a9b7afff7b44ad4fd75308723194e0a11381f': 'Gooooooollllllllll',
    '0x85d53efdd055aa88fb00a914f5615bfd585545ee': 'retroactivesource',
    '0x40ce68f1564f3c751b12d88a393d8cc0651dbf90': 'JuiceFarm',
    '0x3da89a55cdd4b5c69f80e5cd3ef1782a3e0480c3': '(unnamed1)',
    '0xdd58b7e8b989f2cd20ccd903ecc4a997ff3618f9': 'texastechbooster',
    '0x7a0face7188ae921d0fa1301e237280f73041305': 'Gengfrauds',
    '0xd02add54ed7eeeffd39a69b661216346e3dc4771': 'ISKWsouichi',
    '0xfc04aa268a487d792cb3580bea0be7eba052f726': 'paperdood',
    '0xf7f0b0b1e9c0fe02ccad926916ee31aef74b912c': 'wapol',
    '0xf7c2664cb29240811d6a89dd3960ebbc03a79b8d': 'spartachio',
}

SUPABASE_URL = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or
                os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY') or '')

async def _refresh_watch_from_supabase(session: aiohttp.ClientSession) -> bool:
    """Pull active sharks from Supabase and mutate WATCH_LIST in place.
    Returns True on success."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return False
    headers = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
    url = f'{SUPABASE_URL}/rest/v1/sharks?select=wallet_address,name&active=eq.true'
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
            if r.status != 200:
                log.warning(f'[supabase] sharks GET {r.status}: {(await r.text())[:200]}')
                return False
            rows = await r.json()
    except Exception as e:
        log.warning(f'[supabase] sharks fetch err: {e!r}')
        return False
    new_map = {(row['wallet_address'] or '').lower(): (row.get('name') or '(unnamed)')
               for row in rows if row.get('wallet_address')}
    if not new_map:
        log.warning('[supabase] sharks query returned 0 rows — not overwriting')
        return False
    added   = sorted(set(new_map) - set(WATCH_LIST))
    removed = sorted(set(WATCH_LIST) - set(new_map))
    if added or removed:
        log.info(f'[supabase] sharks updated: +{len(added)} -{len(removed)}')
        for w in added:   log.info(f'   + {new_map[w]}  {w}')
        for w in removed: log.info(f'   - {WATCH_LIST[w]}  {w}')
    WATCH_LIST.clear(); WATCH_LIST.update(new_map)
    return True


async def sync_watch_task():
    """Refresh WATCH_LIST from Supabase every 60s."""
    while True:
        async with aiohttp.ClientSession() as session:
            await _refresh_watch_from_supabase(session)
        await asyncio.sleep(60)


# Boot-time alert suppression: the initial /trades poll returns up to 20
# trades per wallet, all "new" to the freshly-booted process. Suppress
# Discord alerts during a short warmup window so we don't flood the channel
# with re-alerts of fills the user already saw. Trades still hit CSV +
# dedup set so the worker doesn't re-alert them later.
BOOT_TIME_MONO  = time.monotonic()
WARMUP_GRACE_SEC = int(os.environ.get('WARMUP_GRACE_SEC', '30'))
WARMUP_MAX_AGE_SEC = int(os.environ.get('WARMUP_MAX_AGE_SEC', '300'))   # 5 min

# ── Tier classification from 7-day backtest (2026-05-25 → 2026-06-01) ──
# PROVEN sharks: net positive pre-series PnL over the window. Worth mirroring.
# AVOID: net negative. Skip these alerts.
# NEUTRAL: small sample / borderline. Treat with caution.
TIER_PROVEN  = {'Gooooooollllllllll','retroactivesource','(unnamed1)','AmaHnk','JuiceFarm','Gengfrauds'}
TIER_NEUTRAL = {'paperdood','f3arless','texastechbooster','jdmboy','wapol'}
TIER_AVOID   = {'Bagwell306','spartachio','ISKWsouichi'}

def tier(name: str) -> tuple[str, str]:
    """Returns (tag_string, emoji) for the tier."""
    if name in TIER_PROVEN:  return ('PROVEN',  '🟢')
    if name in TIER_AVOID:   return ('AVOID',   '🔴')
    return ('NEUTRAL', '🟡')

# ── Config ──
RTDS_URL = 'wss://ws-live-data.polymarket.com'
GAMMA = 'https://gamma-api.polymarket.com'
DATA = 'https://data-api.polymarket.com'
DISCORD = os.environ.get('SHARP_DISCORD_WEBHOOK_URL') or os.environ.get('DISCORD_WEBHOOK_URL', '')
CSV = ROOT / 'data' / 'processed' / 'sharp_fills_hybrid.csv'

POLL_INTERVAL_SEC = 20                      # polling fallback cadence
WS_RECYCLE_AFTER = timedelta(minutes=15)    # proactively reconnect before 20-min silent death
WS_WATCHDOG_SEC  = 30                       # if no message in N seconds, force reconnect
PREGAME_BUFFER   = timedelta(minutes=15)
DEFAULT_STAKE    = 50.0

# Shared dedup set (across WSS + poll). Keyed on (tx_hash, asset_id, proxy)
processed: set = set()
# Async queue for fill events from both sources
fill_queue: asyncio.Queue = asyncio.Queue(maxsize=10000)
event_cache: dict[str, dict | None] = {}

# Stats
stats = {'ws_msgs': 0, 'ws_matches': 0, 'poll_matches': 0, 'discord_sent': 0,
         'ws_reconnects': 0, 'ws_silent_kills': 0}


async def get_series_start(session, slug):
    if slug in event_cache: return event_cache[slug]
    try:
        async with session.get(f'{GAMMA}/events', params={'slug': slug}, timeout=10) as r:
            data = await r.json() if r.ok else None
        ev = (data[0] if data else None) if isinstance(data, list) else data
    except Exception:
        ev = None
    times = []
    if ev:
        for m in (ev.get('markets') or []):
            if m.get('gameStartTime'):
                try: times.append(datetime.fromisoformat(m['gameStartTime'].replace('Z','+00:00')))
                except: pass
    event_cache[slug] = min(times) if times else None
    return event_cache[slug]


async def discord_send(session, text):
    if not DISCORD: return
    try:
        async with session.post(DISCORD, json={'content': text}, timeout=5): pass
        stats['discord_sent'] += 1
    except Exception as e:
        log.warning(f'discord error: {e!r}')


def format_alert(name, wallet, side, outcome, price, size, usd, title, slug, tx, pregame, source, trade_ts):
    profile = f'https://polymarket.com/profile/{wallet}'
    market = f'https://polymarket.com/market/{slug}' if slug else ''
    our_price = price if side == 'BUY' else (1 - price)
    if 0 < our_price < 1:
        our_shares = DEFAULT_STAKE / our_price; payout = DEFAULT_STAKE / our_price
    else:
        our_shares = 0; payout = 0
    tag, tier_emoji = tier(name)
    action = '✅ ACT' if tag == 'PROVEN' else ('⚠️ SKIP' if tag == 'AVOID' else '🤔 EYEBALL')
    # Format trade timestamp in CT (with age vs now)
    if CT_TZ and trade_ts is not None:
        ts_ct = trade_ts.astimezone(CT_TZ).strftime('%b %d %I:%M:%S %p CT')
        age_sec = (datetime.now(timezone.utc) - trade_ts).total_seconds()
        if age_sec < 60: age = f'{age_sec:.0f}s ago'
        elif age_sec < 3600: age = f'{age_sec/60:.0f}m ago'
        else: age = f'{age_sec/3600:.1f}h ago'
        ts_line = f'   ⏱  **{ts_ct}**  ({age})'
    else:
        ts_line = ''
    return (
        f"{tier_emoji} **[{tag}] {name}** {side} **{size:,.0f} shares** of \"{outcome}\" @ ${price:.3f}  [PRE-SERIES | {source} | {action}]\n"
        f"{ts_line}\n"
        f"   `{(title or '?')[:80]}`\n"
        f"   mirror plan: {side} **{our_shares:,.0f} shares** (${DEFAULT_STAKE:,.0f}) → ${payout:,.0f} if right\n"
        f"   trader: <{profile}>\n"
        f"   market: <{market}>\n"
        f"   tx: <https://polygonscan.com/tx/{tx}>"
    )


async def enqueue_fill(t: dict, source: str):
    """Normalize and queue a trade event from either source."""
    proxy = (t.get('proxyWallet') or t.get('user') or '').lower()
    if proxy not in WATCH_LIST: return
    tx = t.get('transactionHash', '')
    aid = str(t.get('asset', ''))
    key = (tx, aid, proxy)
    if key in processed: return
    processed.add(key)
    if source == 'ws': stats['ws_matches'] += 1
    else: stats['poll_matches'] += 1
    await fill_queue.put((source, t))


async def worker(session: aiohttp.ClientSession):
    """Consume fills from the queue, enrich, write to CSV + Discord."""
    while True:
        source, t = await fill_queue.get()
        try:
            proxy = (t.get('proxyWallet') or t.get('user') or '').lower()
            name = WATCH_LIST[proxy]
            title = t.get('title') or ''
            slug = t.get('eventSlug') or t.get('slug') or ''
            # LoL filter: previously this checked title.startswith('LoL:') but
            # that only catches match/game-winner submarkets. Handicap, totals,
            # and kill props use different title prefixes ("Game Handicap:",
            # "Games Total:", "Total Kills..."). The eventSlug is consistent
            # across every submarket of a LoL event, so gate on that instead.
            slug_lc = slug.lower()
            if not (title.startswith('LoL:') or
                    slug_lc.startswith(('lol-','lck-','lec-','lpl-','lcs-'))):
                continue
            series_start = await get_series_start(session, slug) if slug else None
            trade_ts = datetime.fromtimestamp(t.get('timestamp', time.time()), tz=timezone.utc) if isinstance(t.get('timestamp'), (int, float)) else datetime.now(timezone.utc)
            pregame = series_start is not None and trade_ts <= series_start - PREGAME_BUFFER

            side = t.get('side', '?'); outcome = t.get('outcome', '?')
            price = float(t.get('price', 0) or 0); size = float(t.get('size', 0) or 0)
            usd = price * size
            tx = t.get('transactionHash', ''); aid = str(t.get('asset', ''))

            # CSV
            CSV.parent.mkdir(parents=True, exist_ok=True)
            new = not CSV.exists()
            with open(CSV, 'a') as f:
                if new: f.write('timestamp_utc,sharp_wallet,sharp_name,side,event_slug,event_title,outcome,price,size,usd,pregame,tx_hash,asset_id,source\n')
                t_clean = title.replace(',',' ').replace('"','').replace('\n',' ')
                f.write(f'{trade_ts.isoformat()},{proxy},{name},{side},{slug},"{t_clean}","{outcome}",{price},{size},{usd},{pregame},{tx},{aid},{source}\n')

            tag = 'PRE-SERIES' if pregame else 'live/post'
            log.info(f'  🦈 [{source}] {name} {side} ${usd:,.0f} {outcome[:25]:25s} {title[:50]} [{tag}]')

            if pregame and DISCORD:
                # Boot warmup: suppress alerts for fills older than WARMUP_MAX_AGE_SEC
                # during the first WARMUP_GRACE_SEC after boot. Catches the initial
                # /trades?limit=20 backfill without flooding the Discord channel.
                trade_age = (datetime.now(timezone.utc) - trade_ts).total_seconds()
                in_warmup = (time.monotonic() - BOOT_TIME_MONO) < WARMUP_GRACE_SEC
                if in_warmup and trade_age > WARMUP_MAX_AGE_SEC:
                    log.info(f'  [warmup-skip] {name} {side} ${usd:,.0f} {outcome[:25]} ({trade_age/60:.0f}min old)')
                else:
                    msg = format_alert(name, proxy, side, outcome, price, size, usd, title, slug, tx, pregame, source, trade_ts)
                    await discord_send(session, msg)
        except Exception as e:
            log.warning(f'worker error: {e!r}')


# ── WebSocket task ──

async def ws_task():
    """Subscribe to RTDS, push matching trades to queue. Resilient with watchdog."""
    while True:
        last_msg_time = time.time()
        connect_time = time.time()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(RTDS_URL, heartbeat=20) as ws:
                    await ws.send_json({'action':'subscribe', 'subscriptions':[{'topic':'activity','type':'trades'}]})
                    stats['ws_reconnects'] += 1
                    log.info(f'[ws] subscribed to activity>trades (reconnect #{stats["ws_reconnects"]})')

                    while True:
                        # Proactive recycle before known 20-min stall
                        if time.time() - connect_time > WS_RECYCLE_AFTER.total_seconds():
                            log.info('[ws] proactive recycle (15-min preemption)')
                            await ws.close()
                            break

                        try:
                            msg = await asyncio.wait_for(ws.receive(), timeout=WS_WATCHDOG_SEC)
                        except asyncio.TimeoutError:
                            stats['ws_silent_kills'] += 1
                            log.warning(f'[ws] watchdog: {WS_WATCHDOG_SEC}s silence, forcing reconnect')
                            await ws.close()
                            break

                        if msg.type != aiohttp.WSMsgType.TEXT: continue
                        last_msg_time = time.time()
                        if not msg.data or not msg.data.strip().startswith(('{','[')): continue
                        try: data = json.loads(msg.data)
                        except Exception: continue
                        items = data if isinstance(data, list) else [data]
                        for item in items:
                            if not isinstance(item, dict): continue
                            payload = item.get('payload') or item
                            if isinstance(payload, dict):
                                stats['ws_msgs'] += 1
                                await enqueue_fill(payload, 'ws')
                            elif isinstance(payload, list):
                                for p in payload:
                                    if isinstance(p, dict):
                                        stats['ws_msgs'] += 1
                                        await enqueue_fill(p, 'ws')
        except Exception as e:
            log.warning(f'[ws] error: {e!r}, reconnecting in 2s')
            await asyncio.sleep(2)


# ── Polling reconciler ──

async def poll_task():
    """Every 20s, poll /trades per wallet — catches anything WSS missed."""
    while True:
        await asyncio.sleep(POLL_INTERVAL_SEC)
        async with aiohttp.ClientSession() as session:
            for wallet, name in WATCH_LIST.items():
                try:
                    async with session.get(f'{DATA}/trades', params={'user': wallet, 'limit': 20}, timeout=10) as r:
                        trades = await r.json() if r.ok else []
                    if not isinstance(trades, list): continue
                    for t in reversed(trades):
                        # /trades returns proxyWallet but as 'user' field too — normalize
                        t['proxyWallet'] = wallet
                        await enqueue_fill(t, 'poll')
                except Exception as e:
                    log.warning(f'[poll] {name}: {e!r}')


# ── Periodic stats heartbeat ──

async def stats_task():
    while True:
        await asyncio.sleep(300)   # 5 min
        log.info(f'[stats] ws_msgs={stats["ws_msgs"]:,}  ws_matches={stats["ws_matches"]}  '
                 f'poll_matches={stats["poll_matches"]}  discord={stats["discord_sent"]}  '
                 f'reconnects={stats["ws_reconnects"]}  silent_kills={stats["ws_silent_kills"]}')


# ── Main ──

async def main():
    log.info(f'hybrid tracker: WSS primary + {POLL_INTERVAL_SEC}s polling reconciler')
    log.info(f'recycle WSS every {WS_RECYCLE_AFTER}, watchdog every {WS_WATCHDOG_SEC}s')
    # Sync WATCH_LIST from Supabase before subscriptions fire.
    async with aiohttp.ClientSession() as boot_session:
        await _refresh_watch_from_supabase(boot_session)
    log.info(f'watch list ({len(WATCH_LIST)}): {", ".join(WATCH_LIST.values())}')
    async with aiohttp.ClientSession() as session:
        await asyncio.gather(
            ws_task(),
            poll_task(),
            worker(session),
            stats_task(),
            sync_watch_task(),
        )


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info('stopped')
