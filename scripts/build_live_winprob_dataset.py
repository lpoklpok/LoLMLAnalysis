"""
Build the frame-level training dataset for the live win-prob model.

Source of truth: Supabase. The `games` table has both per-game timeline
columns (goldat10/15/20/25 + diffs, xp/cs/kills at the same snapshots)
and `q_blue_win` (ELO-only prior). The `predictions` table additionally
carries `pred_full` (full pre-game model — preferred prior where present).

Coverage strategy:
  • Use `pred_full` as the prior when available (LCK+LEC majors)
  • Fall back to `q_blue_win` for LCS, EWC, etc.
  • Filter to games with `golddiffat10` present (i.e. OE has timeline)

Filters:
  • year: 2026
  • leagues: LCK, LEC, LCS, EWC (any major with prior + timeline)

Output: data/processed/live_winprob/frames.csv
"""
import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

OUT_PATH    = Path("data/processed/live_winprob/frames.csv")
SNAPSHOTS   = [10, 15, 20, 25]
PAGE        = 1000


def paginated(client, table: str, select: str, **filters):
    rows = []
    start = 0
    while True:
        q = client.table(table).select(select)
        for k, v in filters.items():
            if k == "gte":
                col, val = v
                q = q.gte(col, val)
            elif k == "in_":
                col, vals = v
                q = q.in_(col, vals)
        q = q.range(start, start + PAGE - 1)
        r = q.execute()
        rows.extend(r.data)
        if len(r.data) < PAGE:
            break
        start += PAGE
    return rows


def main() -> None:
    load_dotenv(".env")
    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    games_cols = (
        "gameid,league,date,q_blue_win,blue_team_result,"
        "blue_team_goldat10,blue_team_goldat15,blue_team_goldat20,blue_team_goldat25,"
        "red_team_goldat10,red_team_goldat15,red_team_goldat20,red_team_goldat25,"
        "blue_team_xpat10,blue_team_xpat15,blue_team_xpat20,blue_team_xpat25,"
        "red_team_xpat10,red_team_xpat15,red_team_xpat20,red_team_xpat25,"
        "blue_team_csat10,blue_team_csat15,blue_team_csat20,blue_team_csat25,"
        "red_team_csat10,red_team_csat15,red_team_csat20,red_team_csat25,"
        "blue_team_killsat10,blue_team_killsat15,blue_team_killsat20,blue_team_killsat25,"
        "red_team_killsat10,red_team_killsat15,red_team_killsat20,red_team_killsat25"
    )
    games_rows = paginated(client, "games", games_cols, gte=("date", "2026-01-01"))
    games = pd.DataFrame(games_rows)
    print(f"games 2026 rows: {len(games)}")
    # Dedup by gameid (Supabase has multi-row duplicates for some games)
    games = games.drop_duplicates(subset=["gameid"], keep="first").reset_index(drop=True)
    print(f"after dedup by gameid: {len(games)}")

    # Keep games with both a prior and timeline at minute 10
    games = games[games["q_blue_win"].notna() & games["blue_team_goldat10"].notna()].copy()
    print(f"with q_blue_win + timeline: {len(games)} (by league: {games['league'].value_counts().to_dict()})")

    # Prefer pred_full when available
    preds_rows = paginated(client, "predictions", "gameid,pred_full", gte=("date", "2026-01-01"))
    preds = pd.DataFrame(preds_rows).rename(columns={"pred_full": "prior_pref"})
    games = games.merge(preds, on="gameid", how="left")
    games["prior_p_blue"] = games["prior_pref"].fillna(games["q_blue_win"]).astype(float)
    n_pref = games["prior_pref"].notna().sum()
    print(f"using pred_full for {n_pref} games, q_blue_win fallback for {len(games)-n_pref}")

    rows: list[dict] = []
    for _, g in games.iterrows():
        for m in SNAPSHOTS:
            b_gold = g.get(f"blue_team_goldat{m}");   r_gold = g.get(f"red_team_goldat{m}")
            b_xp   = g.get(f"blue_team_xpat{m}");     r_xp   = g.get(f"red_team_xpat{m}")
            b_cs   = g.get(f"blue_team_csat{m}");     r_cs   = g.get(f"red_team_csat{m}")
            b_k    = g.get(f"blue_team_killsat{m}");  r_k    = g.get(f"red_team_killsat{m}")
            if any(pd.isna(v) for v in (b_gold, r_gold, b_xp, r_xp, b_cs, r_cs, b_k, r_k)):
                continue
            rows.append({
                "gameid":       g["gameid"],
                "league":       g["league"],
                "date":         g["date"],
                "time_min":     m,
                "gold_diff":    float(b_gold) - float(r_gold),
                "xp_diff":      float(b_xp)   - float(r_xp),
                "cs_diff":      float(b_cs)   - float(r_cs),
                "kill_diff":    int(b_k)      - int(r_k),
                "prior_p_blue": float(g["prior_p_blue"]),
                "blue_wins":    int(g["blue_team_result"]),
            })

    frames = pd.DataFrame(rows)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    frames.to_csv(OUT_PATH, index=False)
    print(f"\nwrote {len(frames)} frames ({frames['gameid'].nunique()} games) → {OUT_PATH}")
    print(frames.groupby(["league", "time_min"]).size().unstack(fill_value=0))
    print(f"\ntarget rate: {frames['blue_wins'].mean():.3f}")


if __name__ == "__main__":
    main()
