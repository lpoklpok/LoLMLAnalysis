"""
export_pick_tendencies.py
Per-team pick tendencies in 2026:
  (a) After a loss in a series — distribution of blue/red side and first/second pick.
      "After a loss" = team had draft choice for this game (= they lost the previous
      game of the same series).
  (b) As G1 favorite — same distributions, only for G1 games where this team had
      higher team ELO going in.

Pulls from Supabase `games` (for firstPick) + `game_features` (for elo_diff, game_in_series).

Output: web/public/pick_tendencies.json
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

ROOT     = Path(os.path.dirname(__file__)).parent
OUT_PATH = ROOT / "web" / "public" / "pick_tendencies.json"
load_dotenv(ROOT / ".env")


def _paginate(url: str, params: dict, key_extra: dict | None = None) -> list[dict]:
    URL = (os.environ["SUPABASE_URL"]).strip('"')
    KEY = (os.environ["SUPABASE_SERVICE_KEY"]).strip('"')
    rows, offset = [], 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/{url}",
            params={**params, "limit": "1000", "offset": str(offset), **(key_extra or {})},
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    return rows


def main() -> None:
    print("Pulling 2026 games from Supabase...")
    games_rows = _paginate("games", {
        "select": "date,blue_team_teamname,red_team_teamname,blue_team_firstPick,blue_team_result",
        "and":    "(date.gte.2026-01-01,date.lt.2027-01-01)",
        "order":  "date.asc",
    })
    games = pd.DataFrame(games_rows)
    games["date"] = pd.to_datetime(games["date"], utc=True)
    print(f"  {len(games):,} games")

    print("Pulling 2026 game_features...")
    gf_rows = _paginate("game_features", {
        "select": "date,blue_team,red_team,elo_diff,game_in_series,blue_win",
        "and":    "(date.gte.2026-01-01,date.lt.2027-01-01)",
        "order":  "date.asc",
    })
    gf = pd.DataFrame(gf_rows)
    gf["date"] = pd.to_datetime(gf["date"], utc=True)
    print(f"  {len(gf):,} feature rows")

    # Join on date + blue_team
    merged = games.merge(
        gf[["date", "blue_team", "red_team", "elo_diff", "game_in_series"]],
        left_on=["date", "blue_team_teamname", "red_team_teamname"],
        right_on=["date", "blue_team", "red_team"],
        how="inner",
    )
    print(f"  joined: {len(merged):,} rows")

    # Identify series: same date-day + same team pair (unordered)
    merged["_day"]  = merged["date"].dt.date
    merged["_pair"] = merged.apply(
        lambda r: "|".join(sorted([str(r["blue_team_teamname"]), str(r["red_team_teamname"])])), axis=1
    )
    merged = merged.sort_values("date").reset_index(drop=True)

    # For "after loss/win" lookup, need previous game in same series for each team
    after_loss: dict[str, list[dict]] = defaultdict(list)   # team had draft choice
    after_win:  dict[str, list[dict]] = defaultdict(list)   # team did NOT have draft choice (opp chose)
    as_g1_fav:  dict[str, list[dict]] = defaultdict(list)   # G1 ELO favorite
    as_g1_dog:  dict[str, list[dict]] = defaultdict(list)   # G1 ELO underdog

    for (_day, _pair), group in merged.groupby(["_day", "_pair"]):
        group = group.sort_values("date").reset_index(drop=True)
        for i, row in group.iterrows():
            blue_team  = row["blue_team_teamname"]
            red_team   = row["red_team_teamname"]
            blue_first = row["blue_team_firstPick"]
            blue_won   = row["blue_team_result"]
            game_n     = row["game_in_series"]

            # Skip rows with missing fields
            if pd.isna(blue_first) or pd.isna(blue_won) or pd.isna(game_n): continue
            blue_first = int(blue_first); game_n = int(game_n)

            # Helper to record an outcome for one of the teams in this game
            def record(bucket: dict[str, list[dict]], team: str) -> None:
                if team == blue_team:
                    bucket[team].append({"side": "blue", "first_pick": bool(blue_first)})
                elif team == red_team:
                    bucket[team].append({"side": "red",  "first_pick": not bool(blue_first)})

            # ---- (a) After-loss / after-win: which team lost/won previous game in series ----
            if i > 0:
                prev = group.iloc[i - 1]
                prev_blue_won = prev["blue_team_result"]
                if not pd.isna(prev_blue_won):
                    prev_blue_won = int(prev_blue_won)
                    prev_blue = prev["blue_team_teamname"]
                    prev_red  = prev["red_team_teamname"]
                    loser_team  = prev_red  if prev_blue_won == 1 else prev_blue
                    winner_team = prev_blue if prev_blue_won == 1 else prev_red
                    record(after_loss, loser_team)
                    record(after_win,  winner_team)

            # ---- (b) G1 favorite / underdog: which team had ELO advantage at G1? ----
            if game_n == 1 and not pd.isna(row.get("elo_diff")):
                elo_diff = float(row["elo_diff"])
                if   elo_diff > 0:
                    record(as_g1_fav, blue_team)
                    record(as_g1_dog, red_team)
                elif elo_diff < 0:
                    record(as_g1_fav, red_team)
                    record(as_g1_dog, blue_team)

    # Aggregate
    def aggregate(samples: list[dict]) -> dict:
        n = len(samples)
        if n == 0: return {"total": 0}
        n_blue  = sum(1 for s in samples if s["side"] == "blue")
        n_red   = n - n_blue
        n_first = sum(1 for s in samples if s["first_pick"])
        n_secd  = n - n_first
        return {
            "total": n,
            "side":  {"blue":  {"n": n_blue,  "pct": round(n_blue / n, 4)},
                      "red":   {"n": n_red,   "pct": round(n_red  / n, 4)}},
            "pick":  {"first": {"n": n_first, "pct": round(n_first/ n, 4)},
                      "second":{"n": n_secd,  "pct": round(n_secd / n, 4)}},
        }

    teams = set(after_loss.keys()) | set(after_win.keys()) | set(as_g1_fav.keys()) | set(as_g1_dog.keys())
    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "window":    "2026 games only",
        "teams":     {
            t: {
                "after_loss":     aggregate(after_loss[t]),
                "after_win":      aggregate(after_win[t]),
                "as_g1_favorite": aggregate(as_g1_fav[t]),
                "as_g1_underdog": aggregate(as_g1_dog[t]),
            } for t in sorted(teams)
        },
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")))
    size_kb = OUT_PATH.stat().st_size // 1024
    print(f"Wrote {OUT_PATH}  ({len(teams)} teams, {size_kb}KB)")


if __name__ == "__main__":
    main()
