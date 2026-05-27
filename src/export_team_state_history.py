"""
export_team_state_history.py
For each team active in the last N days, exports a per-game timeline of
"team state BEFORE the game" (elo, rwr from features.csv; roster + team-level
gd15/outperf snapshot derived from games.csv). Powers /predict page's date
toggle so the user can replay predictions as-of any point in the last 30 days.

The page uses this to look up "team X state immediately before date D"
by finding the latest snapshot with date >= D (which corresponds to the
team's next game's BEFORE-state, i.e. their state at D).

Output: web/public/team_state_history.json
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT       = Path(os.path.dirname(__file__)).parent
FEATS_CSV  = ROOT / "data" / "processed" / "features.csv"
GAMES_CSV  = ROOT / "data" / "processed" / "games.csv"
OUT_PATH   = ROOT / "web" / "public" / "team_state_history.json"
WINDOW_DAYS = 30
POSITIONS = ["top", "jng", "mid", "bot", "sup"]


def main() -> None:
    feats = pd.read_csv(FEATS_CSV, low_memory=False)
    feats["date"] = pd.to_datetime(feats["date"], utc=True, errors="coerce")
    cutoff = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
    feats = feats[feats["date"] >= cutoff].copy().sort_values("date")
    print(f"features.csv: {len(feats):,} rows in last {WINDOW_DAYS}d")

    games = pd.read_csv(GAMES_CSV, low_memory=False,
                         usecols=lambda c: c in {
                             "date", "blue_team_teamname", "red_team_teamname",
                             *(f"{s}_{p}_playername" for s in ("blue", "red") for p in POSITIONS),
                         })
    games["date"] = pd.to_datetime(games["date"], utc=True, errors="coerce")
    games = games[games["date"] >= cutoff].sort_values("date")

    # Roster lookup: (team, ts) -> 5-player list at time of that game.
    # We round to the second since features/games may differ by a few ms in date.
    rosters_by_team_ts: dict[tuple[str, str], list[str]] = {}
    for _, row in games.iterrows():
        ts = row["date"].isoformat()
        for side in ("blue", "red"):
            team = row[f"{side}_team_teamname"]
            if not isinstance(team, str): continue
            roster = []
            for pos in POSITIONS:
                p = row.get(f"{side}_{pos}_playername")
                if isinstance(p, str) and p:
                    roster.append(p)
            if len(roster) == 5:
                rosters_by_team_ts[(team, ts)] = roster

    teams: dict[str, list[dict]] = defaultdict(list)

    def _push(team: str, side: str, row: pd.Series) -> None:
        elo = row.get(f"{side}_elo")
        rwr = row.get(f"{side}_rwr")
        if pd.isna(elo): return
        ts  = row["date"].isoformat()
        teams[team].append({
            "date":    ts,
            "elo":     float(elo),
            "rwr":     None if pd.isna(rwr) else float(rwr),
            "roster":  rosters_by_team_ts.get((team, ts), []),
        })

    for _, row in feats.iterrows():
        b = row.get("blue_team"); r = row.get("red_team")
        if isinstance(b, str): _push(b, "blue", row)
        if isinstance(r, str): _push(r, "red",  row)

    # Sort each team's timeline by date asc (already sorted, but safe)
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
    n_total = sum(len(v) for v in teams.values())
    size_kb = OUT_PATH.stat().st_size // 1024
    print(f"Wrote {OUT_PATH}  ({len(teams)} teams, {n_total} snapshots, {size_kb}KB)")


if __name__ == "__main__":
    main()
