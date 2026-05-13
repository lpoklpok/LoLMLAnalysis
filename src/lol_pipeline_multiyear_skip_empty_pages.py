"""
lol_pipeline.py
===============
Single script that runs the full LoL odds pipeline end to end.

SETUP — edit the CONFIG block below, then run:
    python lol_pipeline.py

Steps:
    1. Download  — pull latest OraclesElixir CSV from Google Drive
    2. Clean     — reshape to one game-level row per game (clean_OE logic)
    3. Scrape    — pull series odds from OddsPortal (LCK / LEC / LPL / LCS)
    4. Merge     — attach odds to every game row; compute per-game implied q
                   and conditional series probability
    5. Analyse   — favorites implied vs actual, edge/ROI by bucket, and
                   game-weighted q over/under-performance by team

Flags (all optional):
    --skip-download   reuse existing OE CSV instead of re-downloading
    --skip-scrape     reuse existing odds CSV instead of re-scraping
    --headless        run browser without a visible window
    --leagues LCK LEC scrape only specific leagues
    --min-games N     minimum games for team-level analysis table (default 10)
"""

from __future__ import annotations

# ============================================================
# CONFIG — edit these paths to match your machine
# ============================================================
import os

# Folder where all files will be read from and written to.
# Use raw string (r"...") on Windows.
WORK_DIR = r"C:\Users\kevin\OneDrive\Desktop\NBA Model 2\Updated Bots\Lol"

# File names (no need to change unless you want different names)
YEARS_TO_RUN = [2024, 2025, 2026]

# File names. The script will append the year span, e.g. 2024_2025_2026.
OE_COMBINED_RAW_FILE = "LoL_esports_match_data_from_OraclesElixir_combined.csv"
OE_CLEAN_FILE        = "cleaned_major_leagues_team_level_series.csv"
ODDS_FILE            = "odds_raw.csv"
GAMES_ODDS_FILE      = "games_with_odds.csv"

# OraclesElixir Google Drive file IDs.
# 2026 is from your existing script; 2025/2024 are the public yearly OE files.
OE_FILE_IDS = {
    2026: "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm",
    2025: "1v6LRphp2kYciU4SXp0PCjEMuev1bDejc",
    2024: "1IjIEhLc9n8eLKeY-yh_YigKVWbhgGBsN",
}

# Leagues to scrape
LEAGUES_TO_SCRAPE = ["LCK", "LEC", "LPL", "LCS"]

# Minimum total games for team-level analysis
MIN_GAMES = 10

# ============================================================
# IMPORTS
# ============================================================
import argparse
import re
import time
from math import comb
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 50)

# ============================================================
# SHARED CONSTANTS
# ============================================================

LEAGUE_SLUGS: Dict[str, str] = {
    "LEC": "league-of-legends-lec",
    "LCK": "league-of-legends-lck",
    "LPL": "league-of-legends-lpl",
    "LCS": "league-of-legends-lcs",
}

# Default/current-season URLs. Older seasons use a year suffix, e.g.
# https://www.oddsportal.com/esports/league-of-legends/league-of-legends-lck-2025/results/
LEAGUES_URLS: Dict[str, str] = {
    lg: f"https://www.oddsportal.com/esports/league-of-legends/{slug}/results/"
    for lg, slug in LEAGUE_SLUGS.items()
}

def _league_year_url(league: str, year: int) -> str:
    """Build OddsPortal's year-specific LoL results URL."""
    league = str(league).upper()
    slug = LEAGUE_SLUGS[league]
    current_year = int(pd.Timestamp.today().year)
    if int(year) == current_year:
        return f"https://www.oddsportal.com/esports/league-of-legends/{slug}/results/"
    return f"https://www.oddsportal.com/esports/league-of-legends/{slug}-{int(year)}/results/"

LEAGUES_TO_KEEP_OE = {"LCK", "LCS", "LEC", "LPL"}
ROLE_POSITIONS     = ["top", "jng", "mid", "bot", "sup"]
GOLD_DIFF_COLS     = ["golddiffat10", "golddiffat15", "golddiffat20"]
TARGET_YEARS       = set(YEARS_TO_RUN)
MAX_PAGES          = 160
DATE_TOLERANCE     = 3

WAIT_PAGE_LOAD   = 10
WAIT_PAGINATION  = 6
WAIT_LEAGUES     = 2
PAGINATION_MS    = 20_000

TEAM_NAME_MAP: Dict[str, str] = {
    # LCK
    "bnk fearx": "BNK FEARX", "fearx": "BNK FEARX",
    "dn soopers": "DN SOOPers",
    "dplus kia": "Dplus Kia", "dplus": "Dplus Kia",
    "gen.g": "Gen.G", "geng": "Gen.G",
    "hanjin brion": "HANJIN BRION", "oksavingsbank brion": "HANJIN BRION",
    "oksvingsbank brion": "HANJIN BRION", "brion": "HANJIN BRION",
    "hanwha life esports": "Hanwha Life Esports", "hanwha life": "Hanwha Life Esports",
    "kt rolster": "KT Rolster", "kt": "KT Rolster",
    "kiwoom drx": "Kiwoom DRX", "drx": "Kiwoom DRX",
    "kiwoom": "Kiwoom DRX", "krx": "Kiwoom DRX",
    "kiwoom heroes drx": "Kiwoom DRX", "drx kiwoom": "Kiwoom DRX",
    "team drx": "Kiwoom DRX", "kiwoomdrx": "Kiwoom DRX",
    "nongshim redforce": "Nongshim RedForce",
    "t1": "T1",
    # LEC
    "fnatic": "Fnatic",
    "g2 esports": "G2 Esports", "g2": "G2 Esports",
    "giantx": "GiantX",
    "karmine corp": "Karmine Corp", "kc": "Karmine Corp",
    "karmine corp blue": "Karmine Corp Blue",
    "los ratones": "Los Ratones",
    "movistar koi": "Movistar KOI", "koi": "Movistar KOI",
    "natus vincere": "Natus Vincere", "navi": "Natus Vincere",
    "sk gaming": "SK Gaming", "sk": "SK Gaming",
    "shifters": "Shifters",
    "team heretics": "Team Heretics", "heretics": "Team Heretics",
    "team vitality": "Team Vitality", "vitality": "Team Vitality",
    # LPL
    "anyone's legend": "Anyone's Legend", "al": "Anyone's Legend",
    "bilibili gaming": "Bilibili Gaming", "blg": "Bilibili Gaming",
    "edward gaming": "EDward Gaming", "edg": "EDward Gaming",
    "invictus gaming": "Invictus Gaming", "ig": "Invictus Gaming",
    "jd gaming": "JD Gaming", "jdg": "JD Gaming",
    "lgd gaming": "LGD Gaming", "lgd": "LGD Gaming",
    "lng esports": "LNG Esports", "lng": "LNG Esports",
    "ninjas in pyjamas": "Ninjas in Pyjamas", "nip": "Ninjas in Pyjamas",
    "oh my god": "Oh My God", "omg": "Oh My God",
    "team we": "Team WE", "we": "Team WE",
    "thundertalk gaming": "ThunderTalk Gaming", "ttg": "ThunderTalk Gaming",
    "thunder talk gaming": "ThunderTalk Gaming", "thunder talk": "ThunderTalk Gaming",
    "thundertalk": "ThunderTalk Gaming", "tt gaming": "ThunderTalk Gaming",
    "tt": "ThunderTalk Gaming",
    "top esports": "Top Esports", "tes": "Top Esports",
    "ultra prime": "Ultra Prime", "up": "Ultra Prime",
    "weibo gaming": "Weibo Gaming", "wb": "Weibo Gaming",
    # LCS
    "cloud9": "Cloud9", "c9": "Cloud9",
    "dignitas": "Dignitas", "dig": "Dignitas",
    "disguised": "Disguised", "dst": "Disguised",
    "flyquest": "FlyQuest", "fly": "FlyQuest",
    "flyquest esports": "FlyQuest",
    "lyon": "LYON", "lyon gaming": "LYON",
    "sentinels": "Sentinels", "sen": "Sentinels",
    "shopify rebellion": "Shopify Rebellion", "sr": "Shopify Rebellion",
    "team liquid": "Team Liquid", "tl": "Team Liquid",
}


# Extra historical/common OddsPortal aliases for 2024/2025 seasons
TEAM_NAME_MAP.update({
    "rare atom": "Rare Atom", "ra": "Rare Atom",
    "funplus phoenix": "FunPlus Phoenix", "fpx": "FunPlus Phoenix",
    "royal never give up": "Royal Never Give Up", "rng": "Royal Never Give Up",
    "mgn vikings esports": "MGN Vikings Esports", "mgn vikings": "MGN Vikings Esports",
    "100 thieves": "100 Thieves", "100t": "100 Thieves",
    "nrg": "NRG",
    "immortals": "Immortals", "imt": "Immortals",
    "golden guardians": "Golden Guardians", "gg": "Golden Guardians",
    "evil geniuses": "Evil Geniuses", "eg": "Evil Geniuses",
    "mad lions koi": "MAD Lions KOI", "mad lions": "MAD Lions KOI",
    "rogue": "Rogue",
    "excel esports": "Excel Esports", "excel": "Excel Esports",
    "astralis": "Astralis",
})

ALLOWED_TEAMS_BY_LEAGUE: Dict[str, set] = {}

def _is_allowed_lol_match(league: str, team1: str, team2: str) -> bool:
    """Reject sidebar/recommended matches from other sports in the raw body text."""
    allowed = ALLOWED_TEAMS_BY_LEAGUE.get(str(league).upper())
    if not allowed:
        return True
    return canon(team1) in allowed and canon(team2) in allowed

def canon(name: str) -> str:
    return TEAM_NAME_MAP.get(str(name).strip().lower(), str(name).strip())

def pair_key(a: str, b: str) -> str:
    return "|".join(sorted([canon(a).lower(), canon(b).lower()]))

# ============================================================
# STEP 1 — DOWNLOAD OraclesElixir CSV
# ============================================================

def _year_suffix(years: List[int]) -> str:
    return "_".join(str(y) for y in sorted(years))

def _download_google_drive_file(file_id: str, out_path: Path) -> None:
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    r = requests.get(url, timeout=180)
    r.raise_for_status()
    out_path.write_bytes(r.content)

def step_download(years: List[int], work_dir: Path) -> List[Path]:
    print("\n" + "="*60)
    print("STEP 1 — Download OraclesElixir CSVs")
    print("="*60)
    paths: List[Path] = []
    for year in sorted(years):
        if year not in OE_FILE_IDS:
            raise ValueError(f"No OraclesElixir Google Drive file ID configured for {year}. Add it to OE_FILE_IDS.")
        out_path = work_dir / f"{year}_LoL_esports_match_data_from_OraclesElixir.csv"
        print(f"  Downloading OE {year} from Google Drive...")
        _download_google_drive_file(OE_FILE_IDS[year], out_path)
        print(f"  Saved → {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")
        paths.append(out_path)
    return paths

def _existing_oe_paths(years: List[int], work_dir: Path) -> List[Path]:
    paths = [work_dir / f"{year}_LoL_esports_match_data_from_OraclesElixir.csv" for year in sorted(years)]
    missing = [p for p in paths if not p.exists()]
    if missing:
        raise FileNotFoundError("Missing OE raw files: " + ", ".join(str(p) for p in missing))
    return paths

# ============================================================
# STEP 2 — CLEAN OraclesElixir CSV  (clean_OE.py logic)
# ============================================================

def step_clean(in_paths: List[Path], out_path: Path) -> pd.DataFrame:
    print("\n" + "="*60)
    print("STEP 2 — Clean OraclesElixir CSV")
    print("="*60)

    dfs = []
    for in_path in in_paths:
        print(f"  Reading {in_path.name}")
        part = pd.read_csv(in_path, low_memory=False)
        part["source_file"] = in_path.name
        dfs.append(part)
    df = pd.concat(dfs, ignore_index=True)
    df = df[df["league"].isin(LEAGUES_TO_KEEP_OE)].copy()
    df["position"] = df["position"].astype(str).str.lower()

    # --- Role-level features ---
    player_df = df[df["position"].isin(ROLE_POSITIONS)].copy()
    role_needed = ["gameid", "side", "position", "playername", "champion"] + GOLD_DIFF_COLS
    player_df = player_df[role_needed].copy()
    player_df["side"] = player_df["side"].astype(str).str.strip().str.lower()
    player_df["playername"] = player_df["playername"].astype(str).str.strip()
    player_df["champion"] = player_df["champion"].astype(str).str.strip()
    player_df = player_df[player_df["side"].isin(["blue", "red"])].copy()
    for c in GOLD_DIFF_COLS:
        player_df[c] = pd.to_numeric(player_df[c], errors="coerce")
    player_df = player_df.sort_values(["gameid", "side", "position"]).drop_duplicates(
        subset=["gameid", "side", "position"], keep="first"
    )

    role_gold = player_df.pivot(index="gameid", columns=["side", "position"], values=GOLD_DIFF_COLS).copy()
    role_gold.columns = [f"{side}_{pos}_{metric}" for metric, side, pos in role_gold.columns]
    role_gold = role_gold.reset_index()

    role_players = player_df.pivot(index="gameid", columns=["side", "position"], values="playername").copy()
    role_players.columns = [f"{side}_{pos}_player" for side, pos in role_players.columns]
    role_players = role_players.reset_index()

    role_champs = player_df.pivot(index="gameid", columns=["side", "position"], values="champion").copy()
    role_champs.columns = [f"{side}_{pos}_champion" for side, pos in role_champs.columns]
    role_champs = role_champs.reset_index()

    role_features = role_gold.merge(role_players, on="gameid", how="outer")
    role_features = role_features.merge(role_champs, on="gameid", how="outer")

    # --- Team rows ---
    team_df = df[df["position"] == "team"].copy()
    needed = ["gameid","league","date","game","side","teamname","result","firstPick","gamelength",
              "ban1","ban2","ban3","ban4","ban5","pick1","pick2","pick3","pick4","pick5"]
    team_df = team_df[needed].copy()
    team_df["side"] = team_df["side"].astype(str).str.strip().str.lower()
    team_df["teamname"] = team_df["teamname"].astype(str).str.strip()
    team_df["date"] = pd.to_datetime(team_df["date"], errors="coerce")
    team_df["game"] = pd.to_numeric(team_df["game"], errors="coerce")
    team_df["result"] = pd.to_numeric(team_df["result"], errors="coerce")
    team_df["firstPick"] = pd.to_numeric(team_df["firstPick"], errors="coerce")
    team_df["gamelength"] = pd.to_numeric(team_df["gamelength"], errors="coerce")
    team_df = team_df.dropna(subset=["gameid","league","date","side","teamname","result"]).copy()
    team_df = team_df[team_df["side"].isin(["blue","red"])].copy()
    team_df = team_df.sort_values(["gameid","side","date"]).drop_duplicates(subset=["gameid","side"], keep="first")

    blue = team_df[team_df["side"] == "blue"].copy().rename(columns={
        "teamname":"blue_team","result":"blue_result","firstPick":"blue_firstPick",
        "gamelength":"blue_gamelength","ban1":"blue_ban1","ban2":"blue_ban2","ban3":"blue_ban3",
        "ban4":"blue_ban4","ban5":"blue_ban5","pick1":"blue_pick1","pick2":"blue_pick2",
        "pick3":"blue_pick3","pick4":"blue_pick4","pick5":"blue_pick5"})
    red = team_df[team_df["side"] == "red"].copy().rename(columns={
        "teamname":"red_team","result":"red_result","firstPick":"red_firstPick",
        "gamelength":"red_gamelength","ban1":"red_ban1","ban2":"red_ban2","ban3":"red_ban3",
        "ban4":"red_ban4","ban5":"red_ban5","pick1":"red_pick1","pick2":"red_pick2",
        "pick3":"red_pick3","pick4":"red_pick4","pick5":"red_pick5"})

    blue_cols = ["gameid","league","date","game","blue_team","blue_result","blue_firstPick",
                 "blue_gamelength","blue_ban1","blue_ban2","blue_ban3","blue_ban4","blue_ban5",
                 "blue_pick1","blue_pick2","blue_pick3","blue_pick4","blue_pick5"]
    red_cols  = ["gameid","league","date","game","red_team","red_result","red_firstPick",
                 "red_gamelength","red_ban1","red_ban2","red_ban3","red_ban4","red_ban5",
                 "red_pick1","red_pick2","red_pick3","red_pick4","red_pick5"]

    games = pd.merge(blue[blue_cols], red[red_cols], on=["gameid","league","date","game"],
                     how="inner", validate="one_to_one")
    games["game_length"] = games["blue_gamelength"].combine_first(games["red_gamelength"])
    games["game_length_min"] = games["game_length"] / 60.0
    games = games.drop(columns=["blue_gamelength","red_gamelength"])
    games = games.merge(role_features, on="gameid", how="left")
    games = games[((games["blue_result"]==1)&(games["red_result"]==0))|
                  ((games["blue_result"]==0)&(games["red_result"]==1))].copy()

    games["winner"] = np.where(games["blue_result"]==1, games["blue_team"], games["red_team"])
    games["loser"]  = np.where(games["blue_result"]==0, games["blue_team"], games["red_team"])
    games["match_date"] = games["date"].dt.normalize()
    games["match_date_only"] = games["date"].dt.date
    games["team_low"]  = games[["blue_team","red_team"]].min(axis=1)
    games["team_high"] = games[["blue_team","red_team"]].max(axis=1)

    pair_cols = ["league","team_low","team_high"]
    games = games.sort_values(pair_cols + ["match_date","date","gameid"]).copy()
    games["prev_match_date"] = games.groupby(pair_cols)["match_date"].shift(1)
    games["day_gap"] = (games["match_date"] - games["prev_match_date"]).dt.days
    games["new_series_flag"] = (games["prev_match_date"].isna() | games["day_gap"].isna() |
                                (games["day_gap"] < 0) | (games["day_gap"] > 1))
    games["series_number_for_pair"] = games.groupby(pair_cols)["new_series_flag"].cumsum()
    games["series_id"] = (games["league"].astype(str) + "_" + games["team_low"].astype(str) +
                          "_vs_" + games["team_high"].astype(str) + "_" +
                          games["series_number_for_pair"].astype(str))

    games["series_start_date"]    = games.groupby("series_id")["match_date_only"].transform("min")
    games["series_end_date"]      = games.groupby("series_id")["match_date_only"].transform("max")
    games["series_games_observed"]= games.groupby("series_id")["gameid"].transform("count")

    def infer_series_type(n):
        if n <= 1: return "BO1"
        elif n <= 3: return "BO3"
        elif n <= 5: return "BO5"
        else: return f"BO{n}"

    games["series_type"] = games["series_games_observed"].apply(infer_series_type)
    games = games.sort_values(["series_id","match_date","date","gameid"]).copy()
    games["game_in_series"] = games.groupby("series_id").cumcount() + 1

    ss = (games.groupby("series_id").agg(
        n_games=("gameid","size"), game_notna=("game", lambda s: s.notna().all()),
        game_nunique=("game", lambda s: s.nunique(dropna=True)),
        game_min=("game","min"), game_max=("game","max")).reset_index())
    valid = set(ss[(ss["game_notna"]) & (ss["game_nunique"]==ss["n_games"]) &
                   (ss["game_min"]==1) & (ss["game_max"]==ss["n_games"])]["series_id"].tolist())
    mask = games["series_id"].isin(valid)
    games.loc[mask, "game_in_series"] = games.loc[mask, "game"].astype(int)

    role_gold_cols    = [f"{s}_{p}_{m}" for m in GOLD_DIFF_COLS for s in ["blue","red"] for p in ROLE_POSITIONS if f"{s}_{p}_{m}" in games.columns]
    role_player_cols  = [f"{s}_{p}_player"   for s in ["blue","red"] for p in ROLE_POSITIONS if f"{s}_{p}_player"   in games.columns]
    role_champ_cols   = [f"{s}_{p}_champion" for s in ["blue","red"] for p in ROLE_POSITIONS if f"{s}_{p}_champion" in games.columns]

    final_cols = (["series_id","league","series_start_date","series_end_date","match_date_only",
                   "date","series_type","series_games_observed","game_in_series","gameid",
                   "game_length","game_length_min","blue_team","red_team","winner","loser",
                   "blue_result","red_result","blue_firstPick","red_firstPick"]
                  + role_gold_cols + role_player_cols + role_champ_cols
                  + ["blue_ban1","blue_ban2","blue_ban3","blue_ban4","blue_ban5",
                     "blue_pick1","blue_pick2","blue_pick3","blue_pick4","blue_pick5",
                     "red_ban1","red_ban2","red_ban3","red_ban4","red_ban5",
                     "red_pick1","red_pick2","red_pick3","red_pick4","red_pick5"])

    games = games[final_cols].copy().rename(columns={"match_date_only": "match_date"})
    games = games.sort_values(["league","series_start_date","series_id","game_in_series","date"]).reset_index(drop=True)

    # Dynamic LoL-team guard for the OddsPortal scraper. This prevents football/sidebar rows
    # from being parsed while still allowing older 2024/2025 teams that are not in the alias map.
    global ALLOWED_TEAMS_BY_LEAGUE
    ALLOWED_TEAMS_BY_LEAGUE = {}
    for lg, grp in games.groupby("league"):
        teams = set(grp["blue_team"].dropna().astype(str)) | set(grp["red_team"].dropna().astype(str))
        # Add canonical forms too, in case OddsPortal uses an alias.
        teams |= {canon(t) for t in teams}
        ALLOWED_TEAMS_BY_LEAGUE[str(lg).upper()] = teams
    print("  Built OddsPortal LoL-team guard:")
    for lg, teams in sorted(ALLOWED_TEAMS_BY_LEAGUE.items()):
        print(f"    {lg}: {len(teams)} teams")

    games.to_csv(out_path, index=False)
    print(f"  {len(games)} game rows across {games['series_id'].nunique()} series")
    print(f"  Saved → {out_path}")
    return games

# ============================================================
# STEP 3 — SCRAPE OddsPortal  (scraper.py logic)
# ============================================================

def _clean_lines(text: str) -> List[str]:
    return [x.strip() for x in text.splitlines() if x.strip()]

def _is_date_header(line: str) -> bool:
    """
    OddsPortal date headers we accept:
      - Today, 23 Apr - 08:00
      - Yesterday, 22 Apr - 10:00
      - Tomorrow, 24 Apr - 08:00
      - 23 Apr 2026 - 08:00

    Important: do NOT accept generic no-year headers like "23 Apr -"
    here, because full-page body text can include other sports widgets/sidebar rows.
    """
    return bool(
        re.match(r"^(Today|Yesterday|Tomorrow), \d{1,2} [A-Z][a-z]{2} - ", line)
        or re.match(r"^\d{1,2} [A-Z][a-z]{2} 20\d{2} - ", line)
    )

def _parse_date_header(header: str) -> Optional[pd.Timestamp]:
    """Parse OddsPortal date headers, with explicit exceptions for Today/Yesterday/Tomorrow."""
    if not header:
        return None

    header = str(header).strip()

    if header.startswith("Today"):
        return pd.Timestamp.today().normalize()
    if header.startswith("Yesterday"):
        return (pd.Timestamp.today() - pd.Timedelta(days=1)).normalize()
    if header.startswith("Tomorrow"):
        return (pd.Timestamp.today() + pd.Timedelta(days=1)).normalize()

    m = re.search(r"(\d{1,2} [A-Z][a-z]{2} 20\d{2})", header)
    if m:
        return pd.Timestamp(m.group(1)).normalize()

    return None

def _parse_year(header: Optional[str]) -> Optional[int]:
    """Return the actual current year for Today/Yesterday/Tomorrow headers."""
    if not header:
        return None

    header = str(header).strip()
    if header.startswith(("Today", "Yesterday", "Tomorrow")):
        return int(pd.Timestamp.today().year)

    m = re.search(r"\b(20\d{2})\b", header)
    return int(m.group(1)) if m else None

def _is_odd(s: str) -> bool:
    """Accept both decimal (1.85) and American (-1250, +980) odds."""
    return bool(re.match(r"^\d+\.\d+$", s) or re.match(r"^[+-]\d+$", s))

def _to_decimal(s: str) -> float:
    """Convert either decimal or American odds string to decimal odds."""
    if re.match(r"^[+-]\d+$", s):
        n = int(s)
        if n > 0:
            return round(n / 100 + 1, 6)
        else:
            return round(100 / abs(n) + 1, 6)
    return float(s)

def _is_time(s: str) -> bool:
    return bool(re.match(r"^\d{2}:\d{2}$", s))

def _vig_free(o1: float, o2: float) -> Tuple[float, float]:
    p1, p2 = 1/o1, 1/o2
    t = p1 + p2
    return p1/t, p2/t

def _parse_page(body: str, league: str, page_num: int, url: str) -> List[Dict]:
    """
    Scan the full page body for Finished match rows.
    No section-header detection — OddsPortal changes that text too often.
    Year guard (TARGET_YEARS) keeps only requested seasons and helps avoid picking
    up matches from other sports that happen to appear on the same page.
    """
    lines = _clean_lines(body)
    rows, current_date, i = [], None, 0
    while i < len(lines):
        line = lines[i]
        if _is_date_header(line):
            current_date = line; i += 1; continue
        if line == "Finished" and i + 7 < len(lines):
            team1, s1, dash, s2, team2, o1s, o2s = (lines[i+j] for j in range(1, 8))
            if s1.isdigit() and dash == "–" and s2.isdigit() and _is_odd(o1s) and _is_odd(o2s):
                if not _is_allowed_lol_match(league, team1, team2):
                    i += 8
                    continue
                o1, o2 = _to_decimal(o1s), _to_decimal(o2s)
                year = _parse_year(current_date)
                # Only keep rows from requested years — filters out other sports
                if year not in TARGET_YEARS:
                    i += 8; continue
                vf1, vf2 = _vig_free(o1, o2)
                rows.append({
                    "league": league, "page_num": page_num, "source_url": url,
                    "date_header": current_date,
                    "match_date": _parse_date_header(current_date or ""),
                    "year": year,
                    "status": "Finished",
                    "team1_raw": team1, "team2_raw": team2,
                    "team1": canon(team1), "team2": canon(team2),
                    "team1_key": canon(team1).lower(), "team2_key": canon(team2).lower(),
                    "series_score": f"{s1}-{s2}",
                    "score1": int(s1), "score2": int(s2),
                    "odd1_decimal": o1, "odd2_decimal": o2,
                    "implied_prob1_vigfree": round(vf1, 6),
                    "implied_prob2_vigfree": round(vf2, 6),
                })
                i += 8; continue
        if _is_time(line) and i + 5 < len(lines):
            team1, dash, team2, o1s, o2s = (lines[i+j] for j in range(1, 6))
            if dash == "–" and _is_odd(o1s) and _is_odd(o2s):
                if not _is_allowed_lol_match(league, team1, team2):
                    i += 6
                    continue
                o1, o2 = _to_decimal(o1s), _to_decimal(o2s)
                year = _parse_year(current_date)
                if year not in TARGET_YEARS:
                    i += 6; continue
                vf1, vf2 = _vig_free(o1, o2)
                rows.append({
                    "league": league, "page_num": page_num, "source_url": url,
                    "date_header": current_date,
                    "match_date": _parse_date_header(current_date or ""),
                    "year": year, "status": "Upcoming",
                    "team1_raw": team1, "team2_raw": team2,
                    "team1": canon(team1), "team2": canon(team2),
                    "team1_key": canon(team1).lower(), "team2_key": canon(team2).lower(),
                    "series_score": None, "score1": None, "score2": None,
                    "odd1_decimal": o1, "odd2_decimal": o2,
                    "implied_prob1_vigfree": round(vf1, 6),
                    "implied_prob2_vigfree": round(vf2, 6),
                })
                i += 6; continue
        if line in {"1", "2"}: i += 1; continue
        i += 1
    return rows

def _read_body(page) -> str:
    return page.locator("body").inner_text(timeout=20_000)


def _settle_page(page, timeout_ms: int = 20000) -> None:
    """
    OddsPortal can lazy-render the first visible match rows, especially on
    LCK/LPL pages. This waits for the network, then scrolls down/up to force
    the top results table to render before we read body.inner_text().
    """
    try:
        page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    except Exception:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=timeout_ms)
    except Exception:
        pass

    try:
        page.mouse.wheel(0, 900)
        page.wait_for_timeout(900)
        page.mouse.wheel(0, -1400)
        page.wait_for_timeout(1200)
    except Exception:
        pass


def _get_body(page) -> str:
    _settle_page(page)
    return _read_body(page)


def _page_url(base_url: str, page_num: int) -> str:
    """OddsPortal results pagination is hash-based, so clicking can be flaky."""
    base = base_url.split("#")[0].rstrip("/") + "/"
    if page_num <= 1:
        return base
    return f"{base}#/page/{page_num}/"


def _page_header_years(body: str) -> List[int]:
    """Read date-header years from the visible page, before row-level filtering."""
    years: List[int] = []
    for line in _clean_lines(body):
        if _is_date_header(line):
            y = _parse_year(line)
            if y is not None:
                years.append(int(y))
    return years

def _wait_change(page, old: str) -> bool:
    start = time.time()
    while (time.time() - start) * 1000 < PAGINATION_MS:
        try:
            if _get_body(page) != old: return True
        except Exception: pass
        page.wait_for_timeout(500)
    return False


def _wait_for_matches(page, timeout_ms: int = 15000) -> bool:
    """Wait until the page body contains at least one 'Finished' match row."""
    start = time.time()
    while (time.time() - start) * 1000 < timeout_ms:
        try:
            body = _get_body(page)
            lines = _clean_lines(body)
            if "Finished" in lines:
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
    return False

def _dismiss_cookie(page) -> None:
    for sel in ["button:has-text('Accept')","button:has-text('I Accept')",
                "button:has-text('Agree')","button:has-text('Got it')",
                "button:has-text('Allow all')","#onetrust-accept-btn-handler"]:
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=1000):
                btn.click(timeout=2000); page.wait_for_timeout(1000); return
        except Exception: continue

def _click_page(page, target: int, old: str) -> bool:
    """
    Click OddsPortal pagination safely.

    The previous broad selectors like span:has-text('2') can click scores or other
    page text, which makes page 2/page 3 silently re-read page 1. Prefer actual
    pagination links with href="#/page/N/", then fall back to exact visible page
    buttons only inside likely pagination containers.
    """
    label = str(target)
    href_bits = [f"#/page/{target}/", f"page/{target}/"]

    # Best path: click an anchor whose href is the target page hash.
    for bit in href_bits:
        try:
            loc = page.locator(f"a[href*='{bit}']")
            for i in range(loc.count()):
                c = loc.nth(i)
                if not c.is_visible(timeout=1000):
                    continue
                c.scroll_into_view_if_needed(timeout=2000)
                page.wait_for_timeout(500)
                c.click(timeout=5000)
                if _wait_change(page, old):
                    _wait_for_matches(page, timeout_ms=30000)
                    page.wait_for_timeout(WAIT_PAGINATION * 1000)
                    return True
        except Exception:
            continue

    # Fallback: only click exact text matches that look like pagination controls.
    # Avoid generic span/LI matches because those can be scores or odds.
    for sel in [f"nav a:text-is('{label}')", f"nav button:text-is('{label}')",
                f"[class*='pagination'] a:text-is('{label}')",
                f"[class*='pagination'] button:text-is('{label}')",
                f"a:text-is('{label}')", f"button:text-is('{label}')"]:
        try:
            loc = page.locator(sel)
            for i in range(loc.count()):
                c = loc.nth(i)
                if not c.is_visible(timeout=1000):
                    continue
                txt = c.inner_text(timeout=1000).strip()
                if txt != label:
                    continue
                c.scroll_into_view_if_needed(timeout=2000)
                page.wait_for_timeout(500)
                c.click(timeout=5000)
                if _wait_change(page, old):
                    _wait_for_matches(page, timeout_ms=30000)
                    page.wait_for_timeout(WAIT_PAGINATION * 1000)
                    return True
        except Exception:
            continue
    return False

def _click_next(page, old: str) -> bool:
    for sel in ["a[rel='next']","button[rel='next']","a:has-text('Next')",
                "button:has-text('Next')","a:has-text('›')","a:has-text('»')"]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=1000):
                loc.scroll_into_view_if_needed(timeout=2000)
                page.wait_for_timeout(500); loc.click(timeout=4000)
                if _wait_change(page, old):
                    _wait_for_matches(page)
                    page.wait_for_timeout(WAIT_PAGINATION * 1000)
                    return True
        except Exception: continue
    return False

def _scrape_league(url: str, league: str, headless: bool, target_year: Optional[int] = None) -> pd.DataFrame:
    """
    Scrape one league/year OddsPortal results URL using click-based pagination.

    Why this version:
      - year-specific URLs are kept: 2026 current URL has no slug, 2025/2024 use -YYYY.
      - pagination is click-based again because manually opening #/page/N/ can re-render page 1.
      - broad page-number selectors were tightened so we do not accidentally click scores/odds.
      - if Playwright says the page/context/browser closed, stop that league-year immediately.
    """
    from playwright.sync_api import sync_playwright

    all_rows: List[Dict] = []
    requested_years = {int(target_year)} if target_year is not None else set(TARGET_YEARS)
    min_year = min(requested_years)
    seen_page_signatures = set()
    empty_pages = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()

        try:
            print(f"  [{league}] loading page 1...", flush=True)
            page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_timeout(WAIT_PAGE_LOAD * 1000)
            _dismiss_cookie(page)
            _settle_page(page)
            _wait_for_matches(page, timeout_ms=30_000)
        except Exception as e:
            print(f"  [{league}] initial load error: {e}")
            try:
                browser.close()
            except Exception:
                pass
            return pd.DataFrame()

        page_num = 1
        while page_num <= MAX_PAGES:
            print(f"  [{league}] page {page_num}", end=" ", flush=True)

            try:
                if page.is_closed() or context.pages == []:
                    print("→ page/context closed, stopping")
                    break
                body = _get_body(page)
            except Exception as e:
                msg = str(e)
                print(f"→ read error: {msg}")
                if "closed" in msg.lower():
                    break
                empty_pages += 1
                if empty_pages >= 3:
                    print(f"  [{league}] too many read errors, stopping")
                    break
                continue

            header_years = sorted(set(_page_header_years(body)))

            # Detect accidental repeated page 1/page N. This is informational only;
            # we still parse once, but stop if a click repeatedly does not move.
            sig_lines = [x for x in _clean_lines(body) if x not in {"1", "2"}]
            page_sig = "\n".join(sig_lines[:120])
            repeated_page = page_sig in seen_page_signatures
            seen_page_signatures.add(page_sig)

            try:
                rows = _parse_page(body, league, page_num, page.url)
            except Exception as e:
                import traceback
                print(f"→ parse error: {e}")
                traceback.print_exc()
                break

            finished = [r for r in rows if r["status"] == "Finished" and int(r.get("year", -1)) in requested_years]
            row_years = sorted({int(r["year"]) for r in finished if r.get("year") is not None})

            if finished and not repeated_page:
                print(f"→ {len(finished)} finished, row_years={row_years}, header_years={header_years}")
                all_rows.extend(finished)
                empty_pages = 0
            elif finished and repeated_page:
                print(f"→ repeated page content, not adding duplicate rows, row_years={row_years}, header_years={header_years}")
                # If pagination lands on the same content again, stop this league-year.
                # Otherwise we can loop forever or keep re-reading page 1.
                print(f"  [{league}] repeated page after pagination, moving to next league/year")
                break
            else:
                print(f"→ no parsed LoL rows, header_years={header_years}")
                # Empty parsed page means this league-year has no more usable LoL odds rows.
                # Do not keep retrying pages; cleanly move on to the next year/league.
                print(f"  [{league}] no parsed rows on this page, moving to next league/year")
                break

            # Stop if this page is older than the requested season.
            if header_years and max(header_years) < min_year:
                print(f"  [{league}] reached pre-{min_year}, moving to next league/year")
                break

            # Move to next page. If the click fails or does not change body, stop this league-year.
            old_body = body
            moved = False
            try:
                moved = _click_page(page, page_num + 1, old_body) or _click_next(page, old_body)
            except Exception as e:
                msg = str(e)
                print(f"  [{league}] pagination error: {msg}")
                if "closed" in msg.lower():
                    break

            if not moved:
                print(f"  [{league}] no next page / pagination did not change page")
                break

            page_num += 1

        try:
            browser.close()
        except Exception:
            pass

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)

    seen_raw = sorted(set(df["team1_raw"].tolist() + df["team2_raw"].tolist()))
    unrecognised = [r for r in seen_raw if r.strip().lower() not in TEAM_NAME_MAP]
    print(f"  [{league}] raw names from OddsPortal: {seen_raw}")
    if unrecognised:
        print(f"  [{league}] *** UNRECOGNISED names (not in alias map): {unrecognised} ***")
        print(f"  [{league}] Add these to TEAM_NAME_MAP at the top of the script")

    df = df[(df["status"] == "Finished") & (df["year"].isin(requested_years))].copy()
    df = df.drop_duplicates(subset=["league", "date_header", "team1", "team2", "score1", "score2"]).reset_index(drop=True)
    return df

def step_scrape(out_path: Path, leagues: List[str], headless: bool) -> pd.DataFrame:
    print("\n" + "="*60)
    print("STEP 3 — Scrape OddsPortal")
    print("="*60)
    dfs = []
    # Scrape each requested year from its own OddsPortal URL.
    # Archived seasons use URLs like league-of-legends-lck-2025/results/.
    for league in leagues:
        for year in sorted(TARGET_YEARS, reverse=True):
            url = _league_year_url(league, year)
            try:
                print(f"  [{league} {year}] URL: {url}")
                df = _scrape_league(url, league, headless, target_year=year)
                print(f"  [{league} {year}] {len(df)} series scraped")
                dfs.append(df)
            except Exception as e:
                print(f"  [{league} {year}] ERROR: {e}")
            time.sleep(WAIT_LEAGUES)
    dfs = [d for d in dfs if not d.empty]
    if not dfs:
        print("  No data scraped — odds file will be empty")
        return pd.DataFrame()
    out = pd.concat(dfs, ignore_index=True)
    out.to_csv(out_path, index=False)
    print(f"  Saved → {out_path}  ({len(out)} rows)")
    return out

# ============================================================
# STEP 4 — MERGE ODDS INTO GAME CSV  (merge.py logic)
# ============================================================

def _bo3(q): return 3*q**2 - 2*q**3
def _bo5(q): return 10*q**3 - 15*q**4 + 6*q**5

def _solve_q(p: float, stype: str) -> float:
    if pd.isna(p): return np.nan
    if stype == "BO1": return float(p)
    p = float(p)
    if p <= 0: return 0.0
    if p >= 1: return 1.0
    fn = _bo3 if stype == "BO3" else _bo5
    lo, hi = 0.0, 1.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if abs(fn(mid) - p) < 1e-10: return mid
        if fn(mid) < p: lo = mid
        else: hi = mid
    return (lo + hi) / 2

def _cond_series_p(q: float, wb: int, rb: int, wn: int) -> float:
    nb, nr = wn - wb, wn - rb
    if nb <= 0: return 1.0
    if nr <= 0: return 0.0
    if q <= 0: return 0.0
    if q >= 1: return 1.0
    p = 0.0
    for j in range(nr):
        p += comb(nb - 1 + j, j) * (q ** nb) * ((1 - q) ** j)
    return p

def _wn(stype: str) -> int:
    return {"BO1": 1, "BO3": 2, "BO5": 3}.get(stype, 2)

def _build_lookup(odds_df: pd.DataFrame) -> Dict:
    lookup: Dict = {}
    for _, row in odds_df.iterrows():
        league = str(row.get("league", "")).upper()
        t1 = str(row.get("team1", row.get("team1_raw", "")))
        t2 = str(row.get("team2", row.get("team2_raw", "")))
        pk = pair_key(t1, t2)
        try: date_ts = pd.Timestamp(row.get("match_date"))
        except Exception: continue
        lookup.setdefault(league, {}).setdefault(pk, {})[date_ts] = row.to_dict()
    return lookup

def _find_odds(league, bt, rt, sdate, lookup) -> Tuple[Optional[Dict], Optional[int]]:
    pk = pair_key(bt, rt)
    try: date_ts = pd.Timestamp(str(sdate))
    except Exception: return None, None
    pair_data = lookup.get(league.upper(), {}).get(pk, {})
    if not pair_data: return None, None
    if date_ts in pair_data: return pair_data[date_ts], 0
    best, bs = None, None
    for od, row in pair_data.items():
        shift = abs((date_ts - od).days)
        if shift <= DATE_TOLERANCE and (bs is None or shift < bs):
            best, bs = row, shift
    return best, bs

def _orient(odds_row: Dict, blue_team: str) -> Tuple[Optional[float], Optional[float]]:
    t1k = canon(str(odds_row.get("team1", ""))).lower()
    bk  = canon(blue_team).lower()
    p1 = odds_row.get("implied_prob1_vigfree")
    p2 = odds_row.get("implied_prob2_vigfree")
    if p1 is None or p2 is None: return None, None
    p1, p2 = float(p1), float(p2)
    if p1 > 1: p1 /= 100
    if p2 > 1: p2 /= 100
    return (p1, p2) if t1k == bk else (p2, p1)

def _update_score(tracker, sid, row):
    try:
        if int(row.get("blue_result", 0)) == 1: tracker[sid][0] += 1
        elif int(row.get("red_result", 0)) == 1: tracker[sid][1] += 1
    except (TypeError, ValueError): pass

def step_merge(games_df: pd.DataFrame, odds_df: pd.DataFrame, out_path: Path) -> pd.DataFrame:
    print("\n" + "="*60)
    print("STEP 4 — Merge odds into game CSV")
    print("="*60)
    print(f"  Game rows : {len(games_df)}  |  Odds rows : {len(odds_df)}")

    if odds_df.empty:
        print("  WARNING: No odds data — skipping merge")
        for col in ["odds_team1","odds_team2","odds_series_score","odds_date_header",
                    "odds_date_shift_days","odd1_decimal","odd2_decimal",
                    "blue_series_p","red_series_p","blue_implied_q","red_implied_q",
                    "blue_wins_before","red_wins_before","blue_cond_series_p","red_cond_series_p",
                    "match_found","implied_complete"]:
            games_df[col] = None
        games_df.to_csv(out_path, index=False)
        return games_df

    lookup = _build_lookup(odds_df)
    new_cols = ["odds_team1","odds_team2","odds_series_score","odds_date_header",
                "odds_date_shift_days","odd1_decimal","odd2_decimal",
                "blue_series_p","red_series_p","blue_implied_q","red_implied_q",
                "blue_wins_before","red_wins_before","blue_cond_series_p","red_cond_series_p",
                "match_found","implied_complete"]
    for col in new_cols: games_df[col] = None

    series_cache: Dict[str, Tuple] = {}
    score_tracker: Dict[str, list] = {}

    for idx, row in games_df.iterrows():
        sid   = str(row.get("series_id", idx))
        lg    = str(row.get("league", ""))
        bt    = str(row.get("blue_team", ""))
        rt    = str(row.get("red_team", ""))
        stype = str(row.get("series_type", "BO3"))
        sdate = row.get("series_start_date", row.get("match_date", ""))

        if sid not in series_cache:
            series_cache[sid] = _find_odds(lg, bt, rt, sdate, lookup)
        odds_row, shift = series_cache[sid]

        if sid not in score_tracker: score_tracker[sid] = [0, 0]
        wb, rb = score_tracker[sid]

        games_df.at[idx, "blue_wins_before"] = int(wb)
        games_df.at[idx, "red_wins_before"]  = int(rb)

        if odds_row is None:
            games_df.at[idx, "match_found"]     = False
            games_df.at[idx, "implied_complete"] = False
            _update_score(score_tracker, sid, row)
            continue

        bp, rp = _orient(odds_row, bt)
        ok = bp is not None and rp is not None
        bq = _solve_q(bp, stype) if ok else None
        rq = (1.0 - bq) if bq is not None else None
        wn = _wn(stype)
        bc = _cond_series_p(bq, wb, rb, wn) if (ok and bq is not None) else None
        rc = (1.0 - bc) if bc is not None else None

        games_df.at[idx, "odds_team1"]           = odds_row.get("team1")
        games_df.at[idx, "odds_team2"]           = odds_row.get("team2")
        games_df.at[idx, "odds_series_score"]    = odds_row.get("series_score")
        games_df.at[idx, "odds_date_header"]     = odds_row.get("date_header")
        games_df.at[idx, "odds_date_shift_days"] = shift
        games_df.at[idx, "odd1_decimal"]         = odds_row.get("odd1_decimal")
        games_df.at[idx, "odd2_decimal"]         = odds_row.get("odd2_decimal")
        games_df.at[idx, "blue_series_p"]        = round(bp, 6) if bp is not None else None
        games_df.at[idx, "red_series_p"]         = round(rp, 6) if rp is not None else None
        games_df.at[idx, "blue_implied_q"]       = round(bq, 6) if bq is not None else None
        games_df.at[idx, "red_implied_q"]        = round(rq, 6) if rq is not None else None
        games_df.at[idx, "blue_cond_series_p"]   = round(bc, 6) if bc is not None else None
        games_df.at[idx, "red_cond_series_p"]    = round(rc, 6) if rc is not None else None
        games_df.at[idx, "match_found"]          = True
        games_df.at[idx, "implied_complete"]     = ok
        _update_score(score_tracker, sid, row)

    matched = int(games_df["match_found"].sum())
    total   = len(games_df)
    print(f"  Matched: {matched}/{total} game rows ({matched/total*100:.1f}%)")
    games_df.to_csv(out_path, index=False)
    print(f"  Saved → {out_path}")
    return games_df

# ============================================================
# STEP 5 — ANALYSIS  (analysis.py logic)
# ============================================================

def _build_series_df(game_df: pd.DataFrame) -> pd.DataFrame:
    matched = game_df[game_df["match_found"] == True].copy()
    rows = []
    for sid, grp in matched.groupby("series_id"):
        row0 = grp.iloc[0]
        t1, t2 = row0.get("odds_team1"), row0.get("odds_team2")
        score1 = score2 = 0
        for _, g in grp.iterrows():
            winner = g["blue_team"] if g["blue_result"] == 1 else g["red_team"]
            if winner == t1: score1 += 1
            elif winner == t2: score2 += 1
        t1_blue = grp[grp["blue_team"] == t1]
        if len(t1_blue) > 0:
            r = t1_blue.iloc[0]
            p1, p2 = r["blue_series_p"], r["red_series_p"]
            q1, q2 = r["blue_implied_q"], r["red_implied_q"]
            odd1 = r["odd1_decimal"] if r.get("odds_team1") == t1 else r["odd2_decimal"]
            odd2 = r["odd2_decimal"] if r.get("odds_team1") == t1 else r["odd1_decimal"]
        else:
            t1_red = grp[grp["red_team"] == t1]
            if len(t1_red) > 0:
                r = t1_red.iloc[0]
                p1, p2 = r["red_series_p"], r["blue_series_p"]
                q1, q2 = r["red_implied_q"], r["blue_implied_q"]
                odd1 = r["odd2_decimal"] if r.get("odds_team1") == t1 else r["odd1_decimal"]
                odd2 = r["odd1_decimal"] if r.get("odds_team1") == t1 else r["odd2_decimal"]
            else:
                p1 = p2 = q1 = q2 = odd1 = odd2 = None
        rows.append({"series_id": sid, "league": row0["league"],
                     "series_type": row0["series_type"],
                     "series_start_date": row0["series_start_date"],
                     "team1": t1, "team2": t2,
                     "score1": score1, "score2": score2,
                     "p_team1": p1, "p_team2": p2,
                     "q_team1": q1, "q_team2": q2,
                     "odd1_decimal": odd1, "odd2_decimal": odd2,
                     "team1_win": 1 if score1 > score2 else 0,
                     "team2_win": 1 if score2 > score1 else 0})
    df = pd.DataFrame(rows).dropna(subset=["p_team1","p_team2"]).copy()
    for col in ["p_team1","p_team2","q_team1","q_team2"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df

def _run_favorites(df: pd.DataFrame, out_dir: Path) -> pd.DataFrame:
    df = df.copy()
    df["favorite_side"] = np.where(df["p_team1"] >= df["p_team2"], "team1", "team2")
    df["favorite_team"] = np.where(df["favorite_side"] == "team1", df["team1"], df["team2"])
    df["underdog_team"] = np.where(df["favorite_side"] == "team1", df["team2"], df["team1"])
    df["favorite_p"]    = df[["p_team1","p_team2"]].max(axis=1)
    df["underdog_p"]    = df[["p_team1","p_team2"]].min(axis=1)
    df["favorite_won"]  = np.where(df["favorite_side"] == "team1", df["team1_win"], df["team2_win"])
    df["underdog_won"]  = 1 - df["favorite_won"]
    df["favorite_decimal_odds"] = np.where(df["favorite_side"] == "team1", df["odd1_decimal"], df["odd2_decimal"])
    df["favorite_profit"] = np.where(df["favorite_won"] == 1, df["favorite_decimal_odds"] - 1.0, -1.0)

    print("\n" + "="*60)
    print("ANALYSIS: FAVORITES OVERALL")
    print("="*60)
    fi, fa = df["favorite_p"].mean(), df["favorite_won"].mean()
    print(f"  Implied win rate : {fi:.4%}")
    print(f"  Actual win rate  : {fa:.4%}")
    print(f"  Edge             : {fa - fi:+.4%}")

    bins   = [0.50, 0.60, 0.70, 0.80, 0.90, 1.01]
    labels = ["50-60%","60-70%","70-80%","80-90%","90-100%"]
    df["favorite_bucket"] = pd.cut(df["favorite_p"], bins=bins, labels=labels, include_lowest=True, right=False)

    bucket = (df.groupby("favorite_bucket", dropna=False)
                .agg(series=("favorite_won","count"),
                     implied_win_rate=("favorite_p","mean"),
                     actual_win_rate=("favorite_won","mean")).reset_index())
    bucket["edge"] = (bucket["actual_win_rate"] - bucket["implied_win_rate"]).round(4)
    bucket[["implied_win_rate","actual_win_rate"]] = bucket[["implied_win_rate","actual_win_rate"]].round(4)

    print("\n" + "="*60)
    print("ANALYSIS: FAVORITES BY BUCKET")
    print("="*60)
    print(bucket.to_string(index=False))

    league = (df.groupby("league")
                .agg(series=("favorite_won","count"),
                     favorite_implied=("favorite_p","mean"),
                     favorite_actual=("favorite_won","mean")).reset_index())
    league["edge"] = (league["favorite_actual"] - league["favorite_implied"]).round(4)

    print("\n" + "="*60)
    print("ANALYSIS: FAVORITES BY LEAGUE")
    print("="*60)
    print(league.to_string(index=False))

    bucket.to_csv(out_dir / "favorites_by_bucket.csv", index=False)
    league.to_csv(out_dir / "favorites_by_league.csv", index=False)
    return df

def _run_edge(df: pd.DataFrame, out_dir: Path) -> None:
    lb = (df.groupby(["league","favorite_bucket"], dropna=False)
            .agg(series=("favorite_won","count"),
                 implied_win_rate=("favorite_p","mean"),
                 actual_win_rate=("favorite_won","mean"),
                 total_profit=("favorite_profit","sum")).reset_index())
    lb["edge"] = (lb["actual_win_rate"] - lb["implied_win_rate"]).round(4)
    lb["roi"]  = (lb["total_profit"] / lb["series"]).round(4)
    lb[["implied_win_rate","actual_win_rate","total_profit"]] = lb[["implied_win_rate","actual_win_rate","total_profit"]].round(4)

    print("\n" + "="*60)
    print("ANALYSIS: EDGE + ROI BY LEAGUE AND BUCKET")
    print("="*60)
    print(lb.to_string(index=False))

    ep = lb.pivot(index="league", columns="favorite_bucket", values="edge")
    rp = lb.pivot(index="league", columns="favorite_bucket", values="roi")
    print("\n--- Edge pivot ---"); print(ep.to_string())
    print("\n--- ROI pivot ---");  print(rp.to_string())

    lb.to_csv(out_dir / "edge_by_league_bucket.csv", index=False)
    ep.to_csv(out_dir / "edge_pivot.csv")
    rp.to_csv(out_dir / "roi_pivot.csv")

def _run_q(series_df: pd.DataFrame, out_dir: Path, min_games: int) -> None:
    df = series_df.copy()
    df["total_games"] = df["score1"] + df["score2"]
    df = df[df["total_games"] > 0].copy()
    df["realized_q1"] = df["score1"] / df["total_games"]
    df["realized_q2"] = df["score2"] / df["total_games"]
    df["exp_wins1"]   = df["q_team1"] * df["total_games"]
    df["exp_wins2"]   = df["q_team2"] * df["total_games"]
    df["wae1"] = df["score1"] - df["exp_wins1"]
    df["wae2"] = df["score2"] - df["exp_wins2"]

    t1 = df[["league","team1","series_type","p_team1","q_team1","realized_q1","score1","total_games","exp_wins1","wae1"]].copy()
    t1.columns = ["league","team","series_type","implied_series_p","implied_q","realized_q","wins","games","expected_wins","wins_above_expectation"]
    t2 = df[["league","team2","series_type","p_team2","q_team2","realized_q2","score2","total_games","exp_wins2","wae2"]].copy()
    t2.columns = ["league","team","series_type","implied_series_p","implied_q","realized_q","wins","games","expected_wins","wins_above_expectation"]
    long = pd.concat([t1, t2], ignore_index=True)

    DCOLS = ["team","series_count","total_games","total_wins","total_expected_wins",
             "implied_q_game_weighted","realized_q_game_weighted","q_diff_game_weighted",
             "wins_above_expectation","z_score"]

    def summarise(grp_df, gcols):
        s = grp_df.groupby(gcols, as_index=False).agg(
            series_count=("team","size"), total_games=("games","sum"),
            total_wins=("wins","sum"), total_expected_wins=("expected_wins","sum"),
            avg_implied_series_p=("implied_series_p","mean"))
        s["implied_q_game_weighted"]  = s["total_expected_wins"] / s["total_games"]
        s["realized_q_game_weighted"] = s["total_wins"] / s["total_games"]
        s["q_diff_game_weighted"]     = s["realized_q_game_weighted"] - s["implied_q_game_weighted"]
        s["wins_above_expectation"]   = s["total_wins"] - s["total_expected_wins"]
        s["variance_proxy"] = s["total_games"] * s["implied_q_game_weighted"] * (1 - s["implied_q_game_weighted"])
        s["z_score"] = np.where(s["variance_proxy"] > 0,
                                s["wins_above_expectation"] / np.sqrt(s["variance_proxy"]), np.nan)
        return s

    ts = summarise(long, ["team"])
    tf = ts[ts["total_games"] >= min_games].copy()

    print("\n" + "="*60)
    print("ANALYSIS: GAME-WEIGHTED Q — TOP OUTPERFORMERS")
    print("="*60)
    print(tf.sort_values("q_diff_game_weighted", ascending=False)[DCOLS].head(20).to_string(index=False))
    print("\n" + "="*60)
    print("ANALYSIS: GAME-WEIGHTED Q — TOP UNDERPERFORMERS")
    print("="*60)
    print(tf.sort_values("q_diff_game_weighted", ascending=True)[DCOLS].head(20).to_string(index=False))

    lt = summarise(long, ["league","team"])
    ltf = lt[lt["total_games"] >= min_games].copy()
    DCOLS_LT = ["team"] + DCOLS[1:]

    for league in sorted(ltf["league"].dropna().unique()):
        sub = ltf[ltf["league"] == league].copy()
        print(f"\n{'='*60}\nANALYSIS: {league} — GAME-WEIGHTED Q\n{'='*60}")
        print("  Outperformers:")
        print(sub.sort_values("q_diff_game_weighted", ascending=False)[DCOLS_LT].head(10).to_string(index=False))
        print("  Underperformers:")
        print(sub.sort_values("q_diff_game_weighted", ascending=True)[DCOLS_LT].head(10).to_string(index=False))

    ts.sort_values("q_diff_game_weighted", ascending=False).to_csv(out_dir / "team_q_summary.csv", index=False)
    lt.sort_values(["league","q_diff_game_weighted"], ascending=[True,False]).to_csv(out_dir / "league_team_q_summary.csv", index=False)

def step_analyse(game_df: pd.DataFrame, out_dir: Path, min_games: int) -> None:
    print("\n" + "="*60)
    print("STEP 5 — Analysis")
    print("="*60)
    out_dir.mkdir(parents=True, exist_ok=True)

    series_df = _build_series_df(game_df)
    print(f"  {len(series_df)} matched series available for analysis")
    if series_df.empty:
        print("  No matched series — skipping analysis (run scraper to get odds)")
        return

    series_df.to_csv(out_dir / "series_with_odds.csv", index=False)
    enriched = _run_favorites(series_df, out_dir)
    _run_edge(enriched, out_dir)
    _run_q(series_df, out_dir, min_games)

    print("\n" + "="*60)
    print(f"All CSVs saved to: {out_dir}")
    print("="*60)
    for f in sorted(out_dir.iterdir()):
        print(f"  {f.name}")

# ============================================================
# MAIN
# ============================================================

def main() -> None:
    parser = argparse.ArgumentParser(description="LoL full pipeline — multi-year script")
    parser.add_argument("--years", nargs="+", type=int, default=YEARS_TO_RUN,
                        help="Years to download/scrape/merge, e.g. --years 2024 2025 2026")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--skip-scrape",   action="store_true")
    parser.add_argument("--headless",      action="store_true")
    parser.add_argument("--leagues",       nargs="+", choices=list(LEAGUES_URLS),
                        default=LEAGUES_TO_SCRAPE)
    parser.add_argument("--min-games",     type=int, default=MIN_GAMES)
    parser.add_argument("--work-dir",      default=WORK_DIR,
                        help="Override the WORK_DIR set at the top of the script")
    args = parser.parse_args()

    years = sorted(set(int(y) for y in args.years))
    global TARGET_YEARS
    TARGET_YEARS = set(years)
    suffix = _year_suffix(years)

    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    os.chdir(work)

    oe_clean  = work / f"cleaned_major_leagues_team_level_series_{suffix}.csv"
    odds_path = work / f"odds_raw_{suffix}.csv"
    games_out = work / f"games_with_odds_{suffix}.csv"
    out_dir   = work / f"output_{suffix}"

    print("\nYears:", years)
    print("Leagues:", args.leagues)

    # Step 1 — Download OE raw yearly files
    if not args.skip_download:
        oe_paths = step_download(years, work)
    else:
        oe_paths = _existing_oe_paths(years, work)
        print("\n[skip download] using:")
        for p in oe_paths:
            print(f"  {p}")

    # Step 2 — Clean all requested OE years together
    games_df = step_clean(oe_paths, oe_clean)

    # Step 3 — Scrape OddsPortal for all requested years
    if not args.skip_scrape:
        odds_df = step_scrape(odds_path, args.leagues, args.headless)
    else:
        print(f"\n[skip scrape] using {odds_path}")
        odds_df = pd.read_csv(odds_path, low_memory=False) if odds_path.exists() else pd.DataFrame()

    # Step 4 — Merge
    games_df = step_merge(games_df, odds_df, games_out)

    # Step 5 — Analyse
    step_analyse(games_df, out_dir, args.min_games)


if __name__ == "__main__":
    main()
