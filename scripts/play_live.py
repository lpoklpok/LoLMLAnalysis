"""
play_live.py — one-command launcher for live LoL win-prob monitoring.

Flow:
  1. List upcoming matches from `upcoming_predictions` (Supabase) + lolesports schedule
  2. User picks one (or it auto-selects the nearest major)
  3. Polls lolesports getEventDetails until a game is live
  4. Reads game metadata to determine which team is on the in-game BLUE side
  5. Maps the series prior to a per-game blue-side prior (accounting for the
     ~3pp blue-side advantage when needed)
  6. Launches scripts/live_monitor.py with --prior pre-filled

Usage:
  python3 scripts/play_live.py                          # interactive pick from upcoming
  python3 scripts/play_live.py --match "T1"             # filter by team name
  python3 scripts/play_live.py --gameid 12345 --prior .55  # skip lookup
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

LOLESPORTS_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"
HEADERS = {"x-api-key": LOLESPORTS_KEY}
BLUE_SIDE_EDGE_PP = 0.030  # empirical blue-side advantage (~3pp)

# G2/G3 adjustment constants from predict_upcoming.py
ALPHA_G2 = 0.8970   # logodds shrinkage (regression-to-mean across games in a series)
BETA_DA  = 0.0929   # draft-advantage boost; +1 if blue side LOST prev game


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def upcoming_priors(client) -> list[dict]:
    r = client.table("upcoming_predictions").select("*").execute()
    rows = sorted(r.data, key=lambda x: x.get("date", ""))
    return rows


def schedule_window(hours: int = 24) -> list[dict]:
    d = fetch("https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US")
    events = d.get("data", {}).get("schedule", {}).get("events", [])
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for e in events:
        t = dt.datetime.fromisoformat(e["startTime"].replace("Z", "+00:00"))
        delta = (t - now).total_seconds()
        if -2 * 3600 < delta < hours * 3600:  # already started up to 2h ago, or upcoming
            out.append({"start": t, "event": e})
    out.sort(key=lambda x: x["start"])
    return out


def event_team_names(e: dict) -> tuple[str, str]:
    teams = e.get("match", {}).get("teams", [])
    if len(teams) < 2:
        return "?", "?"
    return teams[0].get("name", "?"), teams[1].get("name", "?")


def _norm(s: str) -> str:
    """Lowercase + strip spaces/punctuation for fuzzy team-name matching."""
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def match_prior_for_event(priors: list[dict], event: dict) -> tuple[float, str, str] | None:
    """Find a Supabase prior row matching this lolesports event. Returns
    (pred_blue_win, blue_team_in_prior, red_team_in_prior) or None.
    """
    a, b = event_team_names(event)
    a_n, b_n = _norm(a), _norm(b)
    for row in priors:
        bt = _norm(row.get("blue_team") or "")
        rt = _norm(row.get("red_team") or "")
        if (a_n in bt or bt in a_n) and (b_n in rt or rt in b_n):
            return float(row["pred_blue_win"]), row["blue_team"], row["red_team"]
        if (a_n in rt or rt in a_n) and (b_n in bt or bt in b_n):
            # swapped — invert prior
            return 1.0 - float(row["pred_blue_win"]), row["red_team"], row["blue_team"]
    return None


def list_matches(matches: list[dict], priors: list[dict]) -> None:
    print(f"\nUpcoming/live matches in the next ~24h:\n")
    for i, m in enumerate(matches, 1):
        e = m["event"]
        league = e.get("league", {}).get("name", "?")
        a, b = event_team_names(e)
        bo = e.get("match", {}).get("strategy", {}).get("count", "?")
        prior = match_prior_for_event(priors, e)
        ptext = f"prior={prior[0]:.3f}" if prior else "no-prior"
        when = m["start"].strftime("%a %H:%M UTC")
        print(f"  [{i:2d}] {when}  {league:8s}  {a:25s} vs {b:25s}  Bo{bo}  {ptext}")


def get_event_details(event_id: str) -> dict:
    return fetch(f"https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id={event_id}")


def find_live_gameid(event_id: str) -> tuple[str | None, dict | None, list[dict]]:
    """Returns (in-progress gameId, game record, full list of games)."""
    d = get_event_details(event_id)
    games = d.get("data", {}).get("event", {}).get("match", {}).get("games", [])
    for g in games:
        if g.get("state") == "inProgress":
            return g.get("id"), g, games
    return None, games[0] if games else None, games


def winner_team_id(game_id: str) -> str | None:
    """Find the final frame of a completed game and infer the winning team's id.
    Walks forward in time from game-start until we hit a frame with
    gameState='finished'. Returns the esportsTeamId of the winner, or None.

    Note: feed's `team.inhibitors` field counts inhibitors DESTROYED BY that team,
    so higher = won (this team broke through more enemy structures).
    """
    try:
        # First fetch (no startingTime) gives the game's earliest frames; use the
        # first one as the time anchor.
        d0 = fetch(f"https://feed.lolesports.com/livestats/v1/window/{game_id}")
        frames0 = d0.get("frames") or []
        if not frames0:
            return None
        anchor = dt.datetime.strptime(frames0[0]["rfc460Timestamp"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
        md = d0.get("gameMetadata", {})
        b_id = md.get("blueTeamMetadata", {}).get("esportsTeamId", "")
        r_id = md.get("redTeamMetadata",  {}).get("esportsTeamId", "")

        # Step forward in 5-minute increments to find the finish.
        last_finished: dict | None = None
        for minutes in range(15, 65, 5):  # 15, 20, 25, ..., 60
            ts_dt = anchor + dt.timedelta(minutes=minutes)
            floor_s = (ts_dt.second // 10) * 10
            ts = ts_dt.replace(second=floor_s, microsecond=0).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            try:
                d = fetch(f"https://feed.lolesports.com/livestats/v1/window/{game_id}?startingTime={ts}")
                frames = d.get("frames") or []
                if not frames:
                    continue
                if frames[-1].get("gameState") == "finished":
                    last_finished = frames[-1]
                    # We could continue probing later in case the game ran longer,
                    # but the final state is sticky — break out.
                    break
            except urllib.error.HTTPError:
                # 400 = past end of broadcast feed; if we already have finished, use it
                if last_finished:
                    break
                continue
        if not last_finished:
            return None

        b = last_finished.get("blueTeam", {}) or {}
        r = last_finished.get("redTeam",  {}) or {}
        b_inh = int(b.get("inhibitors") or 0)
        r_inh = int(r.get("inhibitors") or 0)
        if b_inh > r_inh: return b_id  # blue destroyed more inhibs → blue won
        if r_inh > b_inh: return r_id
        # Fallback: higher towers destroyed
        if (b.get("towers") or 0) > (r.get("towers") or 0): return b_id
        if (r.get("towers") or 0) > (b.get("towers") or 0): return r_id
        return None
    except Exception as ex:
        return None


def compute_per_game_blue_prior(
    p_team_a_g1: float,
    game_num: int,
    blue_team_id_this_game: str,
    team_a_id: str,
    team_a_g1_won_on_blue: bool,
    prev_game_winner_id: str | None,
) -> tuple[float, str]:
    """Compute P(in-game blue side wins this specific game) from the series prior.

    Inputs:
      p_team_a_g1            — P(team A wins) from upcoming_predictions (G1 prior)
      game_num               — 1, 2, or 3
      blue_team_id_this_game — esportsTeamId of whoever's on blue side this game
      team_a_id              — esportsTeamId of team A (the team the prior is for)
      team_a_g1_won_on_blue  — whether team A was on blue side in G1
      prev_game_winner_id    — esportsTeamId of the winner of the previous game (None for G1)

    Returns (p_blue_this_game, debug_string).
    """
    logit_a = math.log(p_team_a_g1 / (1.0 - p_team_a_g1)) if 0 < p_team_a_g1 < 1 else 0.0
    debug = [f"team_A_G1_logit={logit_a:+.3f}"]

    if game_num == 1:
        # Direct mapping: if blue side = team A, use prior; else flip
        if blue_team_id_this_game == team_a_id:
            p_blue = p_team_a_g1
            debug.append("G1, blue=A → p_blue = p_A")
        else:
            p_blue = 1.0 - p_team_a_g1
            debug.append("G1, blue=B → p_blue = 1 - p_A")
    else:
        # G2 (and G3 approximated): shrink team-A logodds + add draft adv from blue's POV
        shrinkage = ALPHA_G2 ** (game_num - 1)
        logit_a_now = shrinkage * logit_a
        debug.append(f"shrunk team_A logit by ALPHA^{game_num-1}={shrinkage:.3f} → {logit_a_now:+.3f}")

        # Draft advantage from blue's perspective this game:
        # +1 if blue's team LOST the previous game (so blue's team has draft choice)
        if prev_game_winner_id is None:
            da = 0
            debug.append("prev winner unknown → da=0")
        elif prev_game_winner_id == blue_team_id_this_game:
            da = -1
            debug.append("blue side WON prev → da=-1 (red has draft choice)")
        else:
            da = +1
            debug.append("blue side LOST prev → da=+1 (blue has draft choice)")

        # Convert team-A logodds to blue-side logodds
        if blue_team_id_this_game == team_a_id:
            logit_blue = logit_a_now
        else:
            logit_blue = -logit_a_now
        logit_blue += BETA_DA * da
        debug.append(f"BETA*da={BETA_DA*da:+.3f}")
        p_blue = 1.0 / (1.0 + math.exp(-logit_blue))

    return p_blue, " | ".join(debug)


def lolesports_blue_side(game_id: str) -> tuple[str | None, str | None]:
    """Returns (blueTeamCode, redTeamCode) once the live feed has metadata."""
    try:
        d = fetch(f"https://feed.lolesports.com/livestats/v1/window/{game_id}")
        md = d.get("gameMetadata", {})
        b_id = md.get("blueTeamMetadata", {}).get("esportsTeamId", "")
        r_id = md.get("redTeamMetadata", {}).get("esportsTeamId", "")
        return b_id, r_id
    except Exception:
        return None, None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", type=str, help="filter by team name (case-insensitive substring)")
    ap.add_argument("--gameid", type=str, help="explicit lolesports gameId; skip lookup")
    ap.add_argument("--prior", type=float, help="explicit pre-game P(blue wins); skip prior lookup")
    ap.add_argument("--auto", action="store_true", help="auto-pick the nearest match with a prior")
    ap.add_argument("--no-launch", action="store_true", help="print args but don't exec live_monitor")
    args = ap.parse_args()

    # Direct path: gameid + prior provided
    if args.gameid and args.prior is not None:
        launch_monitor(args.gameid, args.prior, args.no_launch)
        return

    load_dotenv(Path(".env"))
    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    priors = upcoming_priors(client)
    print(f"Loaded {len(priors)} upcoming priors from Supabase.")

    matches = schedule_window(36)
    if args.match:
        matches = [m for m in matches if args.match.lower() in " ".join(event_team_names(m["event"])).lower()]

    if not matches:
        print("No upcoming/live matches found.")
        return

    list_matches(matches, priors)

    # Pick a match
    if args.auto:
        for m in matches:
            if match_prior_for_event(priors, m["event"]):
                choice = m
                break
        else:
            print("No matches with a prior found."); return
    else:
        sel = input("\nPick a match number (or q): ").strip()
        if sel.lower() == "q": return
        try:
            choice = matches[int(sel) - 1]
        except (ValueError, IndexError):
            print("Bad selection."); return

    e = choice["event"]
    event_id = e.get("match", {}).get("id")
    a, b = event_team_names(e)
    print(f"\n→ Selected: {a} vs {b}  ({e.get('league',{}).get('name')})  start={choice['start'].isoformat()}")

    prior_info = match_prior_for_event(priors, e)
    if not prior_info:
        print("[warn] no Supabase prior matches this event; using 0.50 as fallback.")
        series_prior_team_a = 0.50
    else:
        series_prior_team_a, prior_blue_name, _ = prior_info
        print(f"  Supabase prior: P({prior_blue_name} wins series) = {series_prior_team_a:.3f}")

    # Poll for the live gameId
    print("\nPolling for in-progress game (every 20s)…")
    last_warn = 0
    games_list: list[dict] = []
    while True:
        gid, grec, games_list = find_live_gameid(event_id)
        if gid:
            print(f"  → gameId {gid} is live")
            break
        if time.time() - last_warn > 60:
            state = (grec or {}).get("state", "unknown")
            print(f"  …no in-progress game yet (next state={state})")
            last_warn = time.time()
        time.sleep(20)

    # Identify the current game number (1, 2, or 3)
    game_num = 1
    for g in games_list:
        if g.get("id") == gid:
            game_num = int(g.get("number") or 1)
            break
    print(f"  game number in series: {game_num}")

    # Wait for game metadata to populate (sides decided)
    print("Waiting for game metadata (sides)…")
    blue_id = red_id = None
    while not (blue_id and red_id):
        blue_id, red_id = lolesports_blue_side(gid)
        if not (blue_id and red_id):
            time.sleep(5)

    # Identify team A id — schedule endpoint omits team ids, so fetch from event details.
    details = get_event_details(event_id)
    teams = details.get("data", {}).get("event", {}).get("match", {}).get("teams", [])
    team_a_id   = teams[0].get("id") if teams else ""
    team_a_name = teams[0].get("code") or teams[0].get("name") if teams else "?"
    team_b_name = teams[1].get("code") or teams[1].get("name") if len(teams) > 1 else "?"
    blue_is_a = (blue_id == team_a_id)
    print(f"  in-game blue: {team_a_name if blue_is_a else team_b_name} (id={blue_id})")
    print(f"  in-game red:  {team_b_name if blue_is_a else team_a_name} (id={red_id})")

    # For G2/G3, gather previous game results from the feed
    prev_winner_id = None
    team_a_g1_won_on_blue = False  # placeholder; not actually needed for current formula
    if game_num >= 2:
        # Find the previous completed game
        prev_game = None
        for g in games_list:
            if int(g.get("number") or 0) == game_num - 1 and g.get("state") == "completed":
                prev_game = g
                break
        if prev_game:
            prev_winner_id = winner_team_id(prev_game.get("id"))
            print(f"  prev game (G{game_num-1}) id={prev_game.get('id')}  winner_id={prev_winner_id}")
            if prev_winner_id is None:
                print("  [warn] couldn't auto-determine G1 winner from feed; please answer:")
                ans = input(f"  Did {team_a_name} win G{game_num-1}? (y/n): ").strip().lower()
                prev_winner_id = team_a_id if ans.startswith("y") else (teams[1].get("id") if len(teams) > 1 else "")
        else:
            print(f"  [warn] no completed G{game_num-1} found in event")

    # Compute per-game blue-side prior
    if prior_info:
        p_blue_game, debug = compute_per_game_blue_prior(
            p_team_a_g1=series_prior_team_a,
            game_num=game_num,
            blue_team_id_this_game=blue_id,
            team_a_id=team_a_id,
            team_a_g1_won_on_blue=team_a_g1_won_on_blue,
            prev_game_winner_id=prev_winner_id,
        )
        print(f"  prior derivation: {debug}")
    else:
        p_blue_game = 0.50
        print("  [warn] no prior — using 0.50")

    # Blue-side edge (~3pp, scaled by how close the matchup is)
    edge = BLUE_SIDE_EDGE_PP * (1 - 2 * abs(p_blue_game - 0.5))
    p_blue_game = min(max(p_blue_game + edge, 0.01), 0.99)
    print(f"  + blue-side edge {edge:+.3f}")
    print(f"  → final per-game blue prior: {p_blue_game:.3f}")

    launch_monitor(gid, p_blue_game, args.no_launch)


def launch_monitor(gameid: str, prior: float, no_launch: bool) -> None:
    cmd = ["python3", "scripts/live_monitor.py", str(gameid),
           "--interval", "1", "--snapshot-every", "30", "--prior", f"{prior:.4f}"]
    print(f"\n$ {' '.join(cmd)}\n")
    if no_launch:
        return
    os.execvp("python3", cmd)


if __name__ == "__main__":
    main()
