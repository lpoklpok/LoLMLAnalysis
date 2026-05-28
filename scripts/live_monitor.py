#!/usr/bin/env python3
"""
live_monitor.py — call lolesports livestats endpoint for a live game,
print clock + score + gold + objective changes.

The feed publishes new frames in 10-second windows with a ~30s broadcast lag
behind real-time, so the in-game clock you see here will trail Twitch by
that much. The script prints EVERY change (new kill, new tower, etc.) plus
a status line every 10s so you always see something.

Usage:
  python3 live_monitor.py <gameId>
  python3 live_monitor.py 116249880466944873            # KRX vs BFX G2
  python3 live_monitor.py 116249880466944873 --interval 1
  python3 live_monitor.py 116249880466944873 --buffer 35

Find game IDs via getEventDetails:
  curl -H "x-api-key: 0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z" \\
    "https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=<matchId>"
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.request
import urllib.error

try:
    from live_winprob import LiveWinProbModel, frame_to_stats
    from objective_overlay import (
        ObjectiveState, apply_overlay, BaronTracker, derive_soul,
    )
except ImportError:  # noqa
    LiveWinProbModel = None
    frame_to_stats = None
    ObjectiveState = apply_overlay = BaronTracker = derive_soul = None


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)


def fetch(game_id: str, starting_time: str | None = None) -> tuple[int, dict | None]:
    """Return (status_code, parsed JSON or None)."""
    url = f"https://feed.lolesports.com/livestats/v1/window/{game_id}"
    if starting_time:
        url += f"?startingTime={starting_time}"
    try:
        with urllib.request.urlopen(url, timeout=6) as r:
            if r.status == 204:
                return (204, None)
            return (r.status, json.load(r))
    except urllib.error.HTTPError as e:
        return (e.code, None)


def aligned_ts(buffer_s: int) -> str:
    now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=buffer_s)
    s_floor = (now.second // 10) * 10
    return now.replace(second=s_floor, microsecond=0).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fetch_freshest(game_id: str, start_buffer: int = 15, max_buffer: int = 60, step: int = 1) -> tuple[dict | None, int | None]:
    """Try increasing buffer (= older startingTime) until we get 200. Smallest
    buffer = freshest data. Returns (response_data, buffer_used).
    `step` controls increment size when backing off from 400."""
    buf = start_buffer
    while buf <= max_buffer:
        ts = aligned_ts(buf)
        code, d = fetch(game_id, ts)
        if code == 200 and d:
            return d, buf
        if code == 400:
            buf += step
            continue
        if code in (204, 404):
            return None, None
        buf += step
    # Last resort
    _, d = fetch(game_id)
    return d, None


def fmt_clock(seconds: int) -> str:
    m, s = divmod(max(0, seconds), 60)
    return f"{m:02d}:{s:02d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id", help="game ID from getEventDetails")
    ap.add_argument("--interval", type=float, default=2.0, help="poll interval (s)")
    ap.add_argument("--buffer", type=int, default=15,
                    help="starting buffer in seconds (smallest to try); script auto-backs-off if feed isn't caught up")
    ap.add_argument("--step", type=int, default=1,
                    help="increment in seconds when backing off from HTTP 400 (default 1 = finest grain)")
    ap.add_argument("--snapshot-every", type=int, default=10,
                    help="snapshot the game state every N seconds of in-game clock (default 10; try 5)")
    ap.add_argument("--prior", type=float, default=None,
                    help="pre-game P(blue wins) for live win-prob model (e.g. 0.62)")
    args = ap.parse_args()

    model = None
    if args.prior is not None and LiveWinProbModel is not None:
        try:
            model = LiveWinProbModel.load()
            print(f"loaded live win-prob model; pre-game prior P(blue)={args.prior:.3f}")
        except Exception as e:
            print(f"[warn] could not load win-prob model: {e}")

    # Anchor: first frame ever returned (game start)
    print(f"finding game start anchor for {args.game_id}…", flush=True)
    while True:
        _, d0 = fetch(args.game_id)
        if d0 and d0.get("frames"):
            break
        print("  not loaded yet (404/empty), retrying in 10s…", flush=True)
        time.sleep(10)
    anchor = parse_iso(d0["frames"][0]["rfc460Timestamp"])

    md = d0.get("gameMetadata", {})
    blue_picks = [p["championId"] for p in md.get("blueTeamMetadata", {}).get("participantMetadata", [])]
    red_picks  = [p["championId"] for p in md.get("redTeamMetadata",  {}).get("participantMetadata", [])]
    print(f"\nGame start: {anchor.isoformat()}")
    print(f"Blue picks: {blue_picks}")
    print(f"Red picks:  {red_picks}")
    header_extra = "  p_mdl  p_adj" if model else ""
    print(f"\n{'wall':>8}  {'clock':>6}  {'buf':>4}  {'lag':>4}  {'state':<10}  {'B-K':>3} {'R-K':>3}  {'B-T':>3} {'R-T':>3}  diff   {header_extra}   events")
    print("-" * 130)

    baron_tracker = BaronTracker() if BaronTracker else None

    # Track last-printed snapshot bucket + last state for event diffs
    last_bucket = -1
    last = {"bk": 0, "rk": 0, "bt": 0, "rt": 0, "bd": 0, "rd": 0, "bb": 0, "rb": 0, "binh": 0, "rinh": 0, "state": ""}

    def emit(f, used_buf):
        nonlocal last_bucket, last
        ts = parse_iso(f["rfc460Timestamp"])
        clock_s = int((ts - anchor).total_seconds())
        actual_lag = (dt.datetime.now(dt.timezone.utc) - ts).total_seconds()
        bucket = clock_s // args.snapshot_every

        b = f["blueTeam"]; r = f["redTeam"]
        state = f.get("gameState", "?")
        bk, rk = b.get("totalKills", 0), r.get("totalKills", 0)
        bt, rt = b.get("towers", 0), r.get("towers", 0)
        bd, rd = len(b.get("dragons") or []), len(r.get("dragons") or [])
        bb, rb = b.get("barons", 0) or 0, r.get("barons", 0) or 0
        binh, rinh = b.get("inhibitors", 0) or 0, r.get("inhibitors", 0) or 0
        bg, rg = b.get("totalGold", 0), r.get("totalGold", 0)

        events: list[str] = []
        if bk > last["bk"]: events.append(f"+{bk-last['bk']} BLUE kill")
        if rk > last["rk"]: events.append(f"+{rk-last['rk']} RED kill")
        if bt > last["bt"]: events.append(f"BLUE tower ({bt}T)")
        if rt > last["rt"]: events.append(f"RED tower ({rt}T)")
        if bd > last["bd"]: events.append(f"BLUE dragon #{bd}")
        if rd > last["rd"]: events.append(f"RED dragon #{rd}")
        if bb > last["bb"]: events.append(f"BLUE BARON #{bb}")
        if rb > last["rb"]: events.append(f"RED BARON #{rb}")
        if binh > last["binh"]: events.append(f"BLUE inhib")
        if rinh > last["rinh"]: events.append(f"RED inhib")
        if state != last["state"] and last["state"]: events.append(f"state→{state}")

        if bucket != last_bucket or events:
            wall = dt.datetime.now().strftime("%H:%M:%S")
            ev_str = (" · " + ", ".join(events)) if events else ""
            buf_str = f"{used_buf}s" if used_buf else "?"
            p_str = ""
            if model is not None and frame_to_stats is not None:
                stats = frame_to_stats(f, anchor.timestamp())
                p_blue = model.predict(
                    time_min=stats.time_min,
                    gold_diff=stats.gold_diff,
                    xp_diff=stats.xp_diff,
                    cs_diff=stats.cs_diff,
                    kill_diff=stats.kill_diff,
                    prior_p_blue=args.prior,
                )
                # Overlay objective state from this frame
                if baron_tracker is not None:
                    in_game_s = stats.time_min * 60
                    baron_tracker.update(f, in_game_s)
                    b_drakes, b_soul = derive_soul(b.get("dragons") or [])
                    r_drakes, r_soul = derive_soul(r.get("dragons") or [])
                    objs = ObjectiveState(
                        blue_dragons=b_drakes, red_dragons=r_drakes,
                        blue_has_soul=b_soul, red_has_soul=r_soul,
                        blue_baron_taken_at=baron_tracker.blue_last_at,
                        red_baron_taken_at=baron_tracker.red_last_at,
                        blue_inhibitors=binh, red_inhibitors=rinh,
                        time_s=in_game_s,
                    )
                    p_adj, _ = apply_overlay(p_blue, objs)
                else:
                    p_adj = p_blue
                p_str = f"  {p_blue:.3f}  {p_adj:.3f}"
            print(f"{wall}  {fmt_clock(clock_s):>6}  {buf_str:>4}  {actual_lag:>3.0f}s  {state:<10}  "
                   f"{bk:>3} {rk:>3}  {bt:>3} {rt:>3}  {bg-rg:+7,d}{p_str}{ev_str}", flush=True)
            last_bucket = bucket

        last.update({"bk": bk, "rk": rk, "bt": bt, "rt": rt, "bd": bd, "rd": rd,
                      "bb": bb, "rb": rb, "binh": binh, "rinh": rinh, "state": state})
        return state

    try:
        while True:
            d, used_buf = fetch_freshest(args.game_id, start_buffer=args.buffer, step=args.step)
            if not d or not d.get("frames"):
                time.sleep(args.interval); continue

            # Walk every frame and emit if its snapshot-bucket hasn't been printed yet.
            # This catches all the sub-second frames inside the 60s window, not just
            # the latest.
            final_state = "in_game"
            for f in d["frames"]:
                final_state = emit(f, used_buf)

            if final_state == "finished":
                lastf = d["frames"][-1]
                b = lastf["blueTeam"]; r = lastf["redTeam"]
                print(f"\nGame finished. Final: "
                       f"BLUE {b.get('totalKills')}K {b.get('towers')}T {len(b.get('dragons') or [])}D {b.get('barons')}B vs "
                       f"RED {r.get('totalKills')}K {r.get('towers')}T {len(r.get('dragons') or [])}D {r.get('barons')}B "
                       f"(gold diff {b.get('totalGold',0)-r.get('totalGold',0):+,})")
                return

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[stopped]")


if __name__ == "__main__":
    main()
