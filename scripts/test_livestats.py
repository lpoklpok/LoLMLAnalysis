#!/usr/bin/env python3
"""
test_livestats.py — quick probe of lolesports.com livestats feed.

Polls every 10s, prints key state per tick alongside your wall clock.
Run alongside a Twitch tab to compare lag.

Usage:
  # Auto-detect any live game:
  python3 scripts/test_livestats.py

  # Override with a specific gameId (from getEventDetails):
  python3 scripts/test_livestats.py 115548128962971864

  # Or set buffer delay (default 30s — Riot broadcast offset):
  python3 scripts/test_livestats.py --buffer 30
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.request

LIVE_API     = "https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US"
DETAILS_API  = "https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id={match_id}"
WINDOW_API   = "https://feed.lolesports.com/livestats/v1/window/{game_id}?startingTime={ts}"
HEADERS      = {"x-api-key": "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"}  # public, used by lolesports.com itself


def _get_json(url: str, headers: dict | None = None) -> dict | None:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            if r.status == 204:
                return None
            return json.load(r)
    except Exception as e:
        return {"_error": str(e)}


def find_live_game() -> tuple[str, str] | None:
    """Return (game_id, label) for any in-progress game, or None."""
    d = _get_json(LIVE_API, HEADERS)
    if not d or "_error" in d:
        return None
    events = (d.get("data", {}).get("schedule", {}) or {}).get("events", [])
    for e in events:
        m = e.get("match") or {}
        # Need event details to find the in-progress game ID
        match_id = m.get("id")
        if not match_id: continue
        det = _get_json(DETAILS_API.format(match_id=match_id), HEADERS)
        if not det or "_error" in det: continue
        m2 = det.get("data", {}).get("event", {}).get("match") or {}
        teams = [t.get("code") for t in (m2.get("teams") or [])]
        for g in m2.get("games") or []:
            if g.get("state") in ("inProgress", "paused"):
                return str(g["id"]), f"{' vs '.join(teams)} G{g.get('number')} ({e.get('league', {}).get('name', '?')})"
    return None


def aligned_now(buffer_seconds: int) -> str:
    """Return an ISO timestamp aligned to a 10-second boundary, `buffer_seconds` in the past."""
    now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=buffer_seconds)
    sec_floor = (now.second // 10) * 10
    return now.replace(second=sec_floor, microsecond=0).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fmt_frame(f: dict, fetched_at: dt.datetime) -> str:
    b, r = f.get("blueTeam", {}), f.get("redTeam", {})
    bg, rg = b.get("totalGold", 0), r.get("totalGold", 0)
    bk, rk = b.get("totalKills", 0), r.get("totalKills", 0)
    bt, rt = b.get("towers", 0), r.get("towers", 0)
    state  = f.get("gameState", "?")
    ft     = f.get("rfc460Timestamp", "?")[:19]
    # Convert frame timestamp to local for visible lag
    try:
        frame_dt = dt.datetime.strptime(f["rfc460Timestamp"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
        lag_s    = (fetched_at - frame_dt).total_seconds()
        lag_str  = f"  (lag {lag_s:+.0f}s vs wall clock)"
    except Exception:
        lag_str = ""
    return (f"{ft:<22} {state:<10}  "
            f"B {bg:>6}g  R {rg:>6}g  diff {bg-rg:+5d}  |  "
            f"B {bk:>2}K {bt:>2}T  R {rk:>2}K {rt:>2}T{lag_str}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id", nargs="?", help="Optional explicit gameId (skip auto-detect)")
    ap.add_argument("--buffer", type=int, default=30, help="seconds to subtract from now (broadcast offset)")
    ap.add_argument("--interval", type=float, default=10.0, help="poll interval seconds")
    args = ap.parse_args()

    game_id = args.game_id
    label   = "explicit gameId"
    if not game_id:
        print("Searching for a live game…", flush=True)
        hit = find_live_game()
        if not hit:
            print("No in-progress games found right now.")
            print("Pass an explicit gameId once a game starts, e.g.:")
            print("  python3 scripts/test_livestats.py 115548128962971864")
            sys.exit(1)
        game_id, label = hit
    print(f"Polling {label} → gameId={game_id}")
    print(f"Buffer: {args.buffer}s · Interval: {args.interval}s\n")

    last_signature = ""
    while True:
        ts        = aligned_now(args.buffer)
        wall_now  = dt.datetime.now(dt.timezone.utc)
        url       = WINDOW_API.format(game_id=game_id, ts=ts)
        d         = _get_json(url)
        wall_str  = wall_now.strftime("%H:%M:%S")
        if d is None:
            print(f"[{wall_str}]  ts={ts}  → 204 (no data yet; backing off)")
        elif "_error" in d:
            print(f"[{wall_str}]  ts={ts}  → error: {d['_error']}")
        else:
            frames = d.get("frames", [])
            if not frames:
                print(f"[{wall_str}]  ts={ts}  → 200 but empty")
            else:
                last = frames[-1]
                sig  = f"{last.get('rfc460Timestamp')}|{last.get('gameState')}|{last.get('blueTeam',{}).get('totalGold')}"
                if sig != last_signature:
                    print(f"[{wall_str}]  {fmt_frame(last, wall_now)}")
                    last_signature = sig
                else:
                    # No new data since last poll — note briefly
                    print(f"[{wall_str}]  (no new frame)")
                if last.get("gameState") == "finished":
                    print("Game finished — exiting.")
                    return
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
