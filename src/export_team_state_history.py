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
                "select": "date,blue_team,red_team,blue_elo,red_elo,blue_win",
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

    # Per-player gd15 rolling history from games.csv (rebuild from all time)
    print("Loading games.csv for gd15 + rosters…")
    games = pd.read_csv(GAMES_CSV, low_memory=False, usecols=lambda c: c in {
        "date", "blue_team_teamname", "red_team_teamname",
        *(f"{s}_{p}_playername"   for s in ("blue", "red") for p in POSITIONS),
        *(f"{s}_{p}_golddiffat15" for s in ("blue", "red") for p in POSITIONS),
    })
    games["date"] = pd.to_datetime(games["date"], utc=True, errors="coerce")
    games = games.sort_values("date")

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
                    player_gd15[p].append(float(gd))

    # Build per-team snapshots from game_features (recent window only)
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

    for team in teams:
        teams[team].sort(key=lambda e: e["date"])

    now = datetime.now(timezone.utc).isoformat()
    out = {
        "generated":   now,
        "as_of":       now,
        "window_days": WINDOW_DAYS,
        "teams":       dict(teams),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")))
    size_kb = OUT_PATH.stat().st_size // 1024
    n_total = sum(len(v) for v in teams.values())
    print(f"Wrote {OUT_PATH}  ({len(teams)} teams, {n_total} snapshots, {size_kb}KB)")


if __name__ == "__main__":
    main()
