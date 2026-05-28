#!/usr/bin/env python3
"""
first_kill_probe.py — alongside a low-latency Twitch tab, measures when the
first kill (and every subsequent kill) appears in the lolesports JSON feed.

The point: empirically determine whether the feed precedes the broadcast,
trails it, or is at parity. If it precedes by even a few seconds, there's
a potential edge on first-blood markets / live first-kill bets.

Usage:
  python3 scripts/first_kill_probe.py <gameId>
  python3 scripts/first_kill_probe.py 115548128962971864 --buffer 30 --interval 2

When you SEE the first kill on Twitch, note the wall clock. Compare to the
script's "FIRST KILL DETECTED @ <wall_clock>" line. Negative diff = feed first.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.request

WINDOW_API = "https://feed.lolesports.com/livestats/v1/window/{game_id}?startingTime={ts}"


def aligned_ts(buffer_seconds: int) -> str:
    now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=buffer_seconds)
    sec_floor = (now.second // 10) * 10
    return now.replace(second=sec_floor, microsecond=0).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fetch_window(game_id: str, buffer_s: int) -> dict | None:
    ts = aligned_ts(buffer_s)
    url = WINDOW_API.format(game_id=game_id, ts=ts)
    try:
        with urllib.request.urlopen(url, timeout=6) as r:
            if r.status == 204: return None
            return json.load(r)
    except Exception as e:
        return {"_error": str(e)}


def parse_iso(s: str) -> dt.datetime:
    s = s.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(s)
    except ValueError:
        # Trim sub-second precision if needed
        return dt.datetime.fromisoformat(s[:19] + "+00:00")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id")
    ap.add_argument("--buffer",   type=int,   default=30,  help="broadcast-delay buffer (seconds)")
    ap.add_argument("--interval", type=float, default=2.0, help="poll interval (seconds)")
    args = ap.parse_args()

    print(f"Polling gameId={args.game_id} every {args.interval}s (buffer={args.buffer}s)")
    print(f"Watch your Twitch — when you see the first kill, compare wall clocks.")
    print()
    print(f"{'wall_local':<10}  {'frame_ts (UTC)':<22}  {'state':<10}  {'lag':>5}  blue_K  red_K  notes")

    seen_first  = False
    last_blue_k = 0
    last_red_k  = 0

    while True:
        d = fetch_window(args.game_id, args.buffer)
        wall = dt.datetime.now(dt.timezone.utc)
        wall_local = dt.datetime.now().strftime("%H:%M:%S")
        if d is None:
            print(f"{wall_local}   (no data — 204; before game start or game ended)")
        elif "_error" in d:
            print(f"{wall_local}   ERROR: {d['_error']}")
        else:
            frames = d.get("frames", [])
            for f in frames:
                bk = f.get("blueTeam", {}).get("totalKills", 0) or 0
                rk = f.get("redTeam",  {}).get("totalKills", 0) or 0
                state = f.get("gameState", "?")
                if bk == last_blue_k and rk == last_red_k:
                    continue  # no change
                try:
                    frame_dt = parse_iso(f["rfc460Timestamp"])
                    lag = (wall - frame_dt).total_seconds()
                except Exception:
                    lag = float("nan")
                notes: list[str] = []
                if not seen_first and (bk > 0 or rk > 0):
                    side = "BLUE" if bk > 0 and rk == 0 else "RED" if rk > 0 and bk == 0 else "?"
                    notes.append(f"🚨 FIRST KILL ({side}) — wall_local={wall_local}, frame ago={lag:.1f}s")
                    seen_first = True
                if bk > last_blue_k:
                    notes.append(f"+{bk - last_blue_k} blue kill(s)")
                if rk > last_red_k:
                    notes.append(f"+{rk - last_red_k} red kill(s)")
                last_blue_k, last_red_k = bk, rk
                print(f"{wall_local}   {f['rfc460Timestamp'][:19]:<22}  {state:<10}  "
                      f"{lag:>4.0f}s   {bk:>4}    {rk:>4}   {' · '.join(notes)}")
                if state == "finished":
                    print("Game finished — exiting.")
                    return
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
