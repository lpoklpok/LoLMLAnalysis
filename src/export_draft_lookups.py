"""
export_draft_lookups.py
Builds a JSON of all historical aggregates needed by the /draft-sim page:
  - teams / rosters: per-team recent player by role
  - player_champ_wr: player on a specific champion in a specific role
  - champ_role_wr:   champion overall WR in a role
  - champ_matchup_wr: champ A vs champ B in same lane (A perspective)
  - player_h2h_wr:    player A vs player B same role (A perspective)

Data window: last 12 months from today.
Output: web/public/draft_lookups.json
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(os.path.dirname(__file__)).parent
GAMES_CSV = ROOT / "data" / "processed" / "games.csv"
OUT_PATH  = ROOT / "web" / "public" / "draft_lookups.json"

POSITIONS = ["top", "jng", "mid", "bot", "sup"]
WINDOW_DAYS = 365


def _agg(df: pd.DataFrame, by_cols: list[str], win_col: str, min_n: int = 2) -> dict:
    """Group by `by_cols`; return {pipe-key: [n, w]}. Drops entries with n < min_n."""
    g = df.groupby(by_cols, dropna=True)[win_col].agg(["sum", "count"]).reset_index()
    g = g[g["count"] >= min_n]
    out = {}
    for _, row in g.iterrows():
        key = "|".join(str(row[c]) for c in by_cols)
        out[key] = [int(row["count"]), int(row["sum"])]
    return out


def main() -> None:
    df = pd.read_csv(GAMES_CSV, low_memory=False)
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    cutoff = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
    df = df[df["date"] >= cutoff].copy()
    df = df.dropna(subset=["blue_team_result", "red_team_result"])
    df["blue_win"] = df["blue_team_result"].astype(int)
    df["red_win"]  = df["red_team_result"].astype(int)
    print(f"Loaded {len(df):,} games in last {WINDOW_DAYS}d")

    # ---- 1. Flatten to "team-role-game" long-form ----
    # Each row: side, role, team, player, champion, won
    long_rows = []
    for side in ("blue", "red"):
        opp = "red" if side == "blue" else "blue"
        team_col = f"{side}_team_teamname"
        for pos in POSITIONS:
            ch_col = f"{side}_{pos}_champion"
            pl_col = f"{side}_{pos}_playername"
            opp_ch = f"{opp}_{pos}_champion"
            opp_pl = f"{opp}_{pos}_playername"
            if ch_col not in df.columns or pl_col not in df.columns:
                continue
            sub = df[[ch_col, pl_col, opp_ch, opp_pl, f"{side}_win", "date"]].dropna(
                subset=[ch_col, pl_col]
            ).copy()
            sub.columns = ["champ", "player", "opp_champ", "opp_player", "won", "date"]
            sub["role"] = pos
            sub["side"] = side
            long_rows.append(sub)
    long = pd.concat(long_rows, ignore_index=True)
    print(f"Long-form rows: {len(long):,}")

    # ---- 2. Aggregates ----
    player_champ_wr = _agg(long, ["player", "role", "champ"], "won")
    champ_role_wr   = _agg(long, ["role", "champ"], "won")

    # Champ vs champ: each row already encodes (champ vs opp_champ) from this side's perspective.
    cm = long.dropna(subset=["opp_champ"]).copy()
    champ_matchup_wr = _agg(cm, ["role", "champ", "opp_champ"], "won")

    # Player H2H: same role, opposing players, per game
    ph = long.dropna(subset=["opp_player"]).copy()
    player_h2h_wr = _agg(ph, ["role", "player", "opp_player"], "won")

    # ---- 3. Player champion pools (per player, role): champs played + WR sorted by n ----
    champ_pool: dict[str, list[dict]] = defaultdict(list)
    g = long.groupby(["player", "role", "champ"])["won"].agg(["sum", "count"]).reset_index()
    g = g.sort_values("count", ascending=False)
    for _, row in g.iterrows():
        key = f"{row['player']}|{row['role']}"
        champ_pool[key].append({
            "champ": row["champ"],
            "n":     int(row["count"]),
            "w":     int(row["sum"]),
        })

    # ---- 4. Team rosters: most-recent + most-played player per role per team ----
    rosters: dict[str, dict] = defaultdict(lambda: defaultdict(list))
    teams_set: set[str] = set()
    for side in ("blue", "red"):
        team_col = f"{side}_team_teamname"
        if team_col not in df.columns:
            continue
        for pos in POSITIONS:
            pl_col = f"{side}_{pos}_playername"
            if team_col not in df.columns or pl_col not in df.columns:
                continue
            sub = df[[team_col, pl_col, "date"]].dropna()
            sub.columns = ["team", "player", "date"]
            if sub.empty: continue
            teams_set.update(sub["team"].unique())
            # Last seen + n per (team, player) for this role
            agg = sub.groupby(["team", "player"]).agg(
                last=("date", "max"),
                n=("date", "count"),
            ).reset_index()
            for _, r in agg.iterrows():
                rosters[r["team"]][pos].append({
                    "player": r["player"],
                    "n":      int(r["n"]),
                    "last":   r["last"].isoformat(),
                })

    # Dedupe roster entries (same player may appear from both side aggregations)
    for team, by_role in rosters.items():
        for pos, lst in list(by_role.items()):
            by_player: dict[str, dict] = {}
            for entry in lst:
                p = entry["player"]
                if p not in by_player or entry["last"] > by_player[p]["last"]:
                    by_player[p] = entry
                else:
                    # accumulate n
                    by_player[p]["n"] = max(by_player[p]["n"], entry["n"])
            # Sort: prefer recency, then sample
            ranked = sorted(by_player.values(),
                            key=lambda e: (e["last"], e["n"]),
                            reverse=True)
            by_role[pos] = ranked[:8]  # cap to 8 candidates per slot

    # ---- 5. Team list with league + recent activity ----
    teams_out: list[dict] = []
    # Per-team latest league + last seen
    team_rows = []
    for side in ("blue", "red"):
        team_rows.append(df[[f"{side}_team_teamname", "league", "date"]].rename(
            columns={f"{side}_team_teamname": "team"}
        ))
    team_df = pd.concat(team_rows, ignore_index=True).dropna(subset=["team"])
    team_df = team_df.sort_values("date")
    last = team_df.groupby("team").last().reset_index()
    for _, r in last.iterrows():
        teams_out.append({
            "team":   r["team"],
            "league": r.get("league"),
            "last":   r["date"].isoformat() if pd.notna(r["date"]) else None,
        })
    teams_out.sort(key=lambda t: (t["league"] or "", t["team"]))

    # ---- 6. Player list (for slot dropdown autocomplete; per role) ----
    players_by_role: dict[str, list[dict]] = {p: [] for p in POSITIONS}
    pg = long.groupby(["role", "player"])["won"].agg(["count", "sum", lambda s: s.index.max()]).reset_index()
    pg.columns = ["role", "player", "n", "w", "_idx"]
    pg = pg.drop(columns=["_idx"]).sort_values(["role", "n"], ascending=[True, False])
    # Also tag with most-recent date
    last_date_per_player = long.groupby(["role", "player"])["date"].max().reset_index()
    pg = pg.merge(last_date_per_player, on=["role", "player"], how="left")
    for _, r in pg.iterrows():
        players_by_role[r["role"]].append({
            "player": r["player"],
            "n":      int(r["n"]),
            "w":      int(r["w"]),
            "last":   r["date"].isoformat() if pd.notna(r["date"]) else None,
        })

    # ---- 7. Output ----
    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "window_days": WINDOW_DAYS,
        "n_games": int(len(df)),
        "teams": teams_out,
        "rosters": {t: dict(by_role) for t, by_role in rosters.items()},
        "players_by_role": players_by_role,
        "champ_pool":      dict(champ_pool),
        "player_champ_wr": player_champ_wr,
        "champ_role_wr":   champ_role_wr,
        "champ_matchup_wr": champ_matchup_wr,
        "player_h2h_wr":   player_h2h_wr,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, default=str))
    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    print(f"Wrote {OUT_PATH} ({size_mb:.1f} MB)")
    print(f"  teams: {len(teams_out):,}")
    print(f"  player_champ_wr keys: {len(player_champ_wr):,}")
    print(f"  champ_matchup_wr keys: {len(champ_matchup_wr):,}")
    print(f"  player_h2h_wr keys: {len(player_h2h_wr):,}")


if __name__ == "__main__":
    main()
