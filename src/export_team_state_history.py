"""
export_team_state_history.py
Per-team timeline of "team state BEFORE the game" (elo, rwr, gd15, roster).
Powers /predict page's date toggle.

Data sources:
  - Supabase `game_features` (production-fresh elo, blue_win → rolling rwr)
  - Local games.csv (rosters + per-position gd15 → team rolling gd15)

Output: web/public/team_state_history.json
"""

from __future__ import annotations

import json
import os
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean

import pandas as pd
import requests
from dotenv import load_dotenv

ROOT       = Path(os.path.dirname(__file__)).parent
GAMES_CSV  = ROOT / "data" / "processed" / "games.csv"
OUT_PATH   = ROOT / "web" / "public" / "team_state_history.json"
load_dotenv(ROOT / ".env")

WINDOW_DAYS = 30
POSITIONS   = ["top", "jng", "mid", "bot", "sup"]
GD15_ROLL   = 5
RWR_ROLL    = 10


def _rolling_mean(hist: deque, n: int) -> float | None:
    if not hist: return None
    return float(sum(hist) / len(hist))


def _pull_game_features() -> pd.DataFrame:
    URL = (os.environ["SUPABASE_URL"]).strip('"')
    KEY = (os.environ["SUPABASE_SERVICE_KEY"]).strip('"')
    rows = []
    offset = 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/game_features",
            params={
                "select": "date,blue_team,red_team,blue_elo,red_elo,blue_win,h2h_wr,game_in_series,draft_advantage",
                "order":  "date.asc",
                "limit":  "1000",
                "offset": str(offset),
            },
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
            timeout=20,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    return df


def main() -> None:
    print("Pulling game_features from Supabase…")
    gf = _pull_game_features()
    print(f"  {len(gf):,} rows  ({gf['date'].min()} → {gf['date'].max()})")

    # Walk chronologically to build per-team rwr history.
    # For each game, the BEFORE-rwr = rolling mean of last 10 prior results.
    team_wins: dict[str, deque] = defaultdict(lambda: deque(maxlen=RWR_ROLL))
    # team_state_at_game_idx[i] = (blue_rwr, red_rwr) BEFORE game i
    rwrs_blue: list[float | None] = []
    rwrs_red:  list[float | None] = []
    for _, row in gf.iterrows():
        b = row["blue_team"]; r = row["red_team"]
        rwrs_blue.append(_rolling_mean(team_wins[b], RWR_ROLL))
        rwrs_red.append( _rolling_mean(team_wins[r], RWR_ROLL))
        team_wins[b].append(int(row["blue_win"]))
        team_wins[r].append(int(1 - row["blue_win"]))
    gf["blue_rwr"] = rwrs_blue
    gf["red_rwr"]  = rwrs_red

    cutoff = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)

    # Per-player gd15 rolling history. Pull from Supabase `games` table (fresher
    # than local games.csv — Supabase has today's games while local pipeline lags).
    print("Pulling games from Supabase (fresh per-position gd15)…")
    needed = ["date", "blue_team_teamname", "red_team_teamname"]
    for s in ("blue", "red"):
        for p in POSITIONS:
            needed.append(f"{s}_{p}_playername")
            needed.append(f"{s}_{p}_golddiffat15")
    URL_ = (os.environ["SUPABASE_URL"]).strip('"')
    KEY_ = (os.environ["SUPABASE_SERVICE_KEY"]).strip('"')
    rows: list[dict] = []
    offset = 0
    while True:
        r = requests.get(f"{URL_}/rest/v1/games", params={
            "select": ",".join(needed),
            "order":  "date.asc",
            "limit":  "1000",
            "offset": str(offset),
        }, headers={"apikey": KEY_, "Authorization": f"Bearer {KEY_}"}, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    games = pd.DataFrame(rows)
    games["date"] = pd.to_datetime(games["date"], utc=True, errors="coerce")
    games = games.sort_values("date")
    print(f"  Supabase games rows: {len(games):,}  (max date {games['date'].max()})")

    # Dated per-player gd15 history (full series; JS will filter by user's chosen date).
    # Stored as list of [date_iso, gd15] tuples per player.
    player_gd15_dated: dict[str, list[tuple[str, float]]] = defaultdict(list)
    player_gd15: dict[str, deque] = defaultdict(lambda: deque(maxlen=GD15_ROLL * 3))
    team_gd15_by_ts:  dict[tuple[str, str], float] = {}
    rosters_by_team_ts: dict[tuple[str, str], list[str]] = {}
    for _, row in games.iterrows():
        ts = row["date"].isoformat()
        for side in ("blue", "red"):
            team = row[f"{side}_team_teamname"]
            if not isinstance(team, str): continue
            roster = [row.get(f"{side}_{p}_playername") for p in POSITIONS]
            roster = [p for p in roster if isinstance(p, str) and p]
            if len(roster) == 5:
                rosters_by_team_ts[(team, ts)] = roster
                lane_means: list[float] = []
                for p in roster:
                    if player_gd15[p]:
                        lane_means.append(mean(list(player_gd15[p])[-GD15_ROLL:]))
                if lane_means:
                    team_gd15_by_ts[(team, ts)] = float(mean(lane_means))
        # Then update history
        for side in ("blue", "red"):
            for pos in POSITIONS:
                p  = row.get(f"{side}_{pos}_playername")
                gd = row.get(f"{side}_{pos}_golddiffat15")
                if isinstance(p, str) and p and pd.notna(gd):
                    val = float(gd)
                    player_gd15[p].append(val)
                    player_gd15_dated[p].append((ts, val))

    # Build per-team snapshots from game_features (recent window only).
    # Each snapshot is the BEFORE-state of that game.
    teams: dict[str, list[dict]] = defaultdict(list)
    recent = gf[gf["date"] >= cutoff]
    print(f"Building snapshots from {len(recent):,} games in last {WINDOW_DAYS}d…")
    for _, row in recent.iterrows():
        ts = row["date"].isoformat()
        for side, opp in (("blue", "red"), ("red", "blue")):
            team = row[f"{side}_team"]
            elo  = row[f"{side}_elo"]
            rwr  = row[f"{side}_rwr"]
            if not isinstance(team, str) or pd.isna(elo): continue
            teams[team].append({
                "date":   ts,
                "elo":    float(elo),
                "rwr":    None if rwr is None or pd.isna(rwr) else float(rwr),
                "gd15":   team_gd15_by_ts.get((team, ts)),
                "roster": rosters_by_team_ts.get((team, ts), []),
            })

    # Append a synthetic "as-of-now" snapshot per team so a date AFTER their
    # most recent game (e.g. "today") reflects the state INCLUDING that game.
    # Picks up the cumulative rwr (team_wins deque) + post-most-recent-game gd15.
    now_iso = datetime.now(timezone.utc).isoformat()
    # Re-derive player gd15 history walking ALL games (which we already did);
    # team_gd15_by_ts is keyed by past game timestamps. For each team, we want
    # the value AFTER their most recent game — which equals the team_gd15
    # computation using the FINAL player_gd15 history (after iterating all games).
    # Cleanest: compute it once more here.
    for team in teams:
        # Find this team's most recent roster (from rosters_by_team_ts)
        team_rosters = [(ts, roster) for (t, ts), roster in rosters_by_team_ts.items() if t == team]
        if not team_rosters: continue
        team_rosters.sort()
        most_recent_roster = team_rosters[-1][1]
        # Compute team gd15 using the final player_gd15 history
        lane_means = []
        for p in most_recent_roster:
            if player_gd15[p]:
                lane_means.append(mean(list(player_gd15[p])[-GD15_ROLL:]))
        synth_gd15 = float(mean(lane_means)) if lane_means else None
        # Rwr: use the final team_wins deque
        synth_rwr = _rolling_mean(team_wins[team], RWR_ROLL)
        # Elo: use the most recent game's AFTER-state. Since game_features stores
        # BEFORE-state, we need the BEFORE-state of the NEXT game — but there is
        # no next game. Approximate: use most recent BEFORE-state elo. Player ELOs
        # shift slightly after each game but for "today before any games" this is
        # the closest we have without recomputing ELO from scratch here.
        last_snap = teams[team][-1] if teams[team] else None
        synth_elo = last_snap["elo"] if last_snap else None
        teams[team].append({
            "date":   now_iso,
            "elo":    synth_elo,
            "rwr":    synth_rwr,
            "gd15":   synth_gd15,
            "roster": most_recent_roster,
            "synthetic": True,
        })

    for team in teams:
        teams[team].sort(key=lambda e: e["date"])

    # Dated per-player gd15 history (last 15 entries with dates) so the JS page
    # can filter by user's chosen "as-of date" before taking the rolling-5 mean.
    # Mirrors src/feature_engineering.py:515-519 + date-aware lookup.
    needed_players: set[str] = set()
    for team_snaps in teams.values():
        for snap in team_snaps:
            for p in snap.get("roster", []):
                needed_players.add(p)
    KEEP_TAIL = 15  # safety buffer above GD15_ROLL=5 so date filter has room
    player_gd15_export: dict[str, list[list]] = {}
    for p in needed_players:
        hist = player_gd15_dated.get(p, [])
        if hist:
            # Keep date + value, tail to KEEP_TAIL most recent
            player_gd15_export[p] = [[d, round(v, 2)] for d, v in hist[-KEEP_TAIL:]]

    now = datetime.now(timezone.utc).isoformat()
    # Per-team-pair h2h history (BEFORE-game stored value) + matchup game count
    # (used for Bayesian-shrunk h2h updates when user injects future results).
    h2h_dated:    dict[str, list[list]] = defaultdict(list)
    h2h_n_games:  dict[str, int]        = defaultdict(int)
    for _, row in gf.iterrows():
        t_blue = row["blue_team"]; t_red = row["red_team"]
        if not isinstance(t_blue, str) or not isinstance(t_red, str): continue
        # Pair key (sorted alphabetically)
        if t_blue <= t_red:
            key = f"{t_blue}|||{t_red}"
        else:
            key = f"{t_red}|||{t_blue}"
        # Tally game count (every Gen.G vs HLE counts toward both directions)
        h2h_n_games[key] += 1
        if pd.isna(row.get("h2h_wr")): continue
        h2h_blue = float(row["h2h_wr"])
        wr = h2h_blue if t_blue <= t_red else 1 - h2h_blue
        h2h_dated[key].append([row["date"].isoformat(), round(wr, 6)])

    # Trim to last 30 entries per pair
    h2h_export = {k: v[-30:] for k, v in h2h_dated.items()}
    n_games_export = dict(h2h_n_games)

    # Per-team win history (last 15 dated W/L entries so we can extend the
    # rolling-10 rwr when user injects future game results).
    team_wins_dated: dict[str, list[list]] = defaultdict(list)
    for _, row in gf.iterrows():
        t_blue = row["blue_team"]; t_red = row["red_team"]
        if not isinstance(t_blue, str) or not isinstance(t_red, str): continue
        if pd.isna(row.get("blue_win")): continue
        bw = int(row["blue_win"])
        ts = row["date"].isoformat()
        team_wins_dated[t_blue].append([ts, bw])
        team_wins_dated[t_red].append([ts, 1 - bw])
    team_wins_export = {k: v[-15:] for k, v in team_wins_dated.items()}

    out = {
        "generated":          now,
        "as_of":              now,
        "window_days":        WINDOW_DAYS,
        "gd15_roll":          GD15_ROLL,
        "teams":              dict(teams),
        # { player: [[date_iso, gd15], ...] }  — last 15 entries with dates
        "player_gd15_dated":  player_gd15_export,
        # { "min|||max": [[date_iso, h2h_wr_from_min_perspective], ...] }
        "team_pair_h2h_dated": h2h_export,
        # { "min|||max": total_game_count } — for Bayesian h2h updates
        "team_pair_n_games":   n_games_export,
        # { team: [[date_iso, 0_or_1], ...] } — last 15 W/L per team for rwr cascade
        "team_wins_dated":     team_wins_export,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")))
    size_kb = OUT_PATH.stat().st_size // 1024
    n_total = sum(len(v) for v in teams.values())
    print(f"Wrote {OUT_PATH}  ({len(teams)} teams, {n_total} snapshots, {size_kb}KB)")


if __name__ == "__main__":
    main()
