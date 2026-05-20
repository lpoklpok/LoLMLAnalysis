import os
import re
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd

ODDS_DIR = Path(os.path.dirname(__file__)) / ".." / "data" / "odds"
CURRENT_YEAR = 2026
HISTORICAL_YEARS = list(range(2024, CURRENT_YEAR))
ALL_YEARS = HISTORICAL_YEARS + [CURRENT_YEAR]

LEAGUES = ["LCK", "LEC", "LPL", "LCS", "EWC"]
MAX_PAGES = 160
DATE_TOLERANCE = 3
WAIT_PAGE_LOAD = 10
WAIT_PAGINATION = 6
PAGINATION_MS = 20_000

LEAGUE_SLUGS: Dict[str, str] = {
    "LEC": "league-of-legends-lec",
    "LCK": "league-of-legends-lck",
    "LPL": "league-of-legends-lpl",
    "LCS": "league-of-legends-lcs",
    "EWC": "league-of-legends-esports-world-cup",
}

# Leagues that use a single URL for all years (no year suffix)
SINGLE_URL_LEAGUES = {"EWC"}

TEAM_NAME_MAP: Dict[str, str] = {
    # LCK
    "bnk fearx": "BNK FEARX", "fearx": "BNK FEARX",
    "dn soopers": "DN SOOPers",
    "dplus kia": "Dplus Kia", "dplus": "Dplus Kia",
    "gen.g": "Gen.G", "geng": "Gen.G",
    "hanjin brion": "HANJIN BRION", "oksavingsbank brion": "HANJIN BRION",
    "brion": "HANJIN BRION",
    "hanwha life esports": "Hanwha Life Esports", "hanwha life": "Hanwha Life Esports",
    "kt rolster": "KT Rolster", "kt": "KT Rolster",
    "kiwoom drx": "Kiwoom DRX", "drx": "Kiwoom DRX",
    "nongshim redforce": "Nongshim RedForce",
    "t1": "T1",
    # LEC
    "fnatic": "Fnatic",
    "g2 esports": "G2 Esports", "g2": "G2 Esports",
    "giantx": "GiantX",
    "karmine corp": "Karmine Corp",
    "los ratones": "Los Ratones",
    "movistar koi": "Movistar KOI", "koi": "Movistar KOI",
    "natus vincere": "Natus Vincere", "navi": "Natus Vincere",
    "sk gaming": "SK Gaming",
    "team heretics": "Team Heretics",
    "team vitality": "Team Vitality",
    # LPL
    "anyone's legend": "Anyone's Legend",
    "bilibili gaming": "Bilibili Gaming", "blg": "Bilibili Gaming",
    "edward gaming": "EDward Gaming", "edg": "EDward Gaming",
    "jd gaming": "JD Gaming", "jdg": "JD Gaming",
    "lng esports": "LNG Esports", "lng": "LNG Esports",
    "oh my god": "Oh My God", "omg": "Oh My God",
    "top esports": "Top Esports", "tes": "Top Esports",
    "weibo gaming": "Weibo Gaming", "wb": "Weibo Gaming",
    "funplus phoenix": "FunPlus Phoenix", "fpx": "FunPlus Phoenix",
    "royal never give up": "Royal Never Give Up", "rng": "Royal Never Give Up",
    "rare atom": "Rare Atom",
    # LCS
    "cloud9": "Cloud9", "c9": "Cloud9",
    "flyquest": "FlyQuest",
    "team liquid": "Team Liquid", "tl": "Team Liquid",
    "100 thieves": "100 Thieves",
    "dignitas": "Dignitas",
    "sentinels": "Sentinels",
}


def canon(name: str) -> str:
    return TEAM_NAME_MAP.get(str(name).strip().lower(), str(name).strip())


def _league_year_url(league: str, year: int) -> str:
    slug = LEAGUE_SLUGS[league.upper()]
    if league.upper() in SINGLE_URL_LEAGUES:
        return f"https://www.oddsportal.com/esports/league-of-legends/{slug}/results/"
    if year == CURRENT_YEAR:
        return f"https://www.oddsportal.com/esports/league-of-legends/{slug}/results/"
    return f"https://www.oddsportal.com/esports/league-of-legends/{slug}-{year}/results/"


def _clean_lines(text: str) -> List[str]:
    return [x.strip() for x in text.splitlines() if x.strip()]


def _is_date_header(line: str) -> bool:
    return bool(
        re.match(r"^(Today|Yesterday|Tomorrow), \d{1,2} [A-Z][a-z]{2} - ", line)
        or re.match(r"^\d{1,2} [A-Z][a-z]{2} 20\d{2} - ", line)
    )


def _parse_date_header(header: str) -> Optional[pd.Timestamp]:
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
    return pd.Timestamp(m.group(1)).normalize() if m else None


def _parse_year(header: Optional[str]) -> Optional[int]:
    if not header:
        return None
    header = str(header).strip()
    if header.startswith(("Today", "Yesterday", "Tomorrow")):
        return int(pd.Timestamp.today().year)
    m = re.search(r"\b(20\d{2})\b", header)
    return int(m.group(1)) if m else None


def _is_odd(s: str) -> bool:
    return bool(re.match(r"^\d+\.\d+$", s) or re.match(r"^[+-]\d+$", s))


def _to_decimal(s: str) -> float:
    if re.match(r"^[+-]\d+$", s):
        n = int(s)
        return round(n / 100 + 1, 6) if n > 0 else round(100 / abs(n) + 1, 6)
    return float(s)


def _vig_free(o1: float, o2: float) -> Tuple[float, float]:
    p1, p2 = 1 / o1, 1 / o2
    t = p1 + p2
    return p1 / t, p2 / t


KNOWN_TEAMS = {name.lower() for name in TEAM_NAME_MAP.values()} | set(TEAM_NAME_MAP.keys())

def _is_lol_match(team1: str, team2: str) -> bool:
    return (team1.strip().lower() in KNOWN_TEAMS or team2.strip().lower() in KNOWN_TEAMS)


def _page_header_years(body: str) -> List[int]:
    years = []
    for line in _clean_lines(body):
        if _is_date_header(line):
            y = _parse_year(line)
            if y is not None:
                years.append(int(y))
    return years


def _parse_page(body: str, league: str, page_num: int, url: str, target_years: set) -> List[Dict]:
    lines = _clean_lines(body)
    rows, current_date, i = [], None, 0
    while i < len(lines):
        line = lines[i]
        if _is_date_header(line):
            current_date = line; i += 1; continue
        if line == "Finished" and i + 7 < len(lines):
            team1, s1, dash, s2, team2, o1s, o2s = (lines[i + j] for j in range(1, 8))
            if s1.isdigit() and dash == "–" and s2.isdigit() and _is_odd(o1s) and _is_odd(o2s):
                if not _is_lol_match(team1, team2):
                    i += 8; continue
                year = _parse_year(current_date)
                if year not in target_years:
                    i += 8; continue
                o1, o2 = _to_decimal(o1s), _to_decimal(o2s)
                vf1, vf2 = _vig_free(o1, o2)
                rows.append({
                    "league": league, "page_num": page_num, "source_url": url,
                    "date_header": current_date,
                    "match_date": _parse_date_header(current_date or ""),
                    "year": year,
                    "team1_raw": team1, "team2_raw": team2,
                    "team1": canon(team1), "team2": canon(team2),
                    "series_score": f"{s1}-{s2}",
                    "score1": int(s1), "score2": int(s2),
                    "odd1_decimal": o1, "odd2_decimal": o2,
                    "implied_prob1_vigfree": round(vf1, 6),
                    "implied_prob2_vigfree": round(vf2, 6),
                })
                i += 8; continue
        if line in {"1", "2"}:
            i += 1; continue
        i += 1
    return rows


def _settle_page(page, timeout_ms: int = 20000) -> None:
    for state in ("domcontentloaded", "networkidle"):
        try:
            page.wait_for_load_state(state, timeout=timeout_ms)
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
    return page.locator("body").inner_text(timeout=20_000)


def _wait_for_matches(page, timeout_ms: int = 15000) -> bool:
    start = time.time()
    while (time.time() - start) * 1000 < timeout_ms:
        try:
            if "Finished" in _clean_lines(_get_body(page)):
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
    return False


def _wait_change(page, old: str) -> bool:
    start = time.time()
    while (time.time() - start) * 1000 < PAGINATION_MS:
        try:
            if _get_body(page) != old:
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
    return False


def _dismiss_cookie(page) -> None:
    for sel in ["button:has-text('Accept')", "button:has-text('I Accept')",
                "button:has-text('Agree')", "button:has-text('Allow all')",
                "#onetrust-accept-btn-handler"]:
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=1000):
                btn.click(timeout=2000)
                page.wait_for_timeout(1000)
                return
        except Exception:
            continue


def _click_page(page, target: int, old: str) -> bool:
    label = str(target)
    for bit in [f"#/page/{target}/", f"page/{target}/"]:
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
    for sel in [f"nav a:text-is('{label}')", f"[class*='pagination'] a:text-is('{label}')",
                f"a:text-is('{label}')"]:
        try:
            loc = page.locator(sel)
            for i in range(loc.count()):
                c = loc.nth(i)
                if c.is_visible(timeout=1000) and c.inner_text(timeout=1000).strip() == label:
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
    for sel in ["a[rel='next']", "a:has-text('Next')", "a:has-text('›')", "a:has-text('»')"]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=1000):
                loc.scroll_into_view_if_needed(timeout=2000)
                page.wait_for_timeout(500)
                loc.click(timeout=4000)
                if _wait_change(page, old):
                    _wait_for_matches(page)
                    page.wait_for_timeout(WAIT_PAGINATION * 1000)
                    return True
        except Exception:
            continue
    return False


def _upcoming_url(league: str) -> str:
    slug = LEAGUE_SLUGS[league.upper()]
    return f"https://www.oddsportal.com/esports/league-of-legends/{slug}/"


def _parse_upcoming_page(body: str, league: str, url: str) -> List[Dict]:
    """Parse upcoming (not-started) matches from OddsPortal main league page."""
    lines = _clean_lines(body)
    rows, current_date, i = [], None, 0
    time_re = re.compile(r"^\d{1,2}:\d{2}$")

    while i < len(lines):
        line = lines[i]
        if _is_date_header(line):
            current_date = line; i += 1; continue

        # Upcoming match pattern: HH:MM, team1, team2, odds1, odds2
        if time_re.match(line) and i + 4 < len(lines):
            match_time = line
            team1, team2, o1s, o2s = lines[i+1], lines[i+2], lines[i+3], lines[i+4]
            if _is_odd(o1s) and _is_odd(o2s) and _is_lol_match(team1, team2):
                date = _parse_date_header(current_date or "")
                year = _parse_year(current_date)
                o1, o2 = _to_decimal(o1s), _to_decimal(o2s)
                vf1, vf2 = _vig_free(o1, o2)
                rows.append({
                    "league":                league,
                    "source_url":            url,
                    "date_header":           current_date,
                    "match_date":            date,
                    "match_time":            match_time,
                    "year":                  year,
                    "team1_raw":             team1,
                    "team2_raw":             team2,
                    "team1":                 canon(team1),
                    "team2":                 canon(team2),
                    "odd1_decimal":          o1,
                    "odd2_decimal":          o2,
                    "implied_prob1_vigfree": round(vf1, 6),
                    "implied_prob2_vigfree": round(vf2, 6),
                })
                i += 5; continue
        i += 1
    return rows


def scrape_upcoming_odds(leagues: List[str] = None, headless: bool = True) -> pd.DataFrame:
    """Scrape upcoming match odds from OddsPortal for all specified leagues."""
    from playwright.sync_api import sync_playwright

    if leagues is None:
        leagues = LEAGUES

    all_rows: List[Dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_context().new_page()

        for league in leagues:
            url = _upcoming_url(league)
            print(f"  [{league}] fetching upcoming odds from {url}...")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                page.wait_for_timeout(WAIT_PAGE_LOAD * 1000)
                _dismiss_cookie(page)
                _settle_page(page)
                body = _get_body(page)
                rows = _parse_upcoming_page(body, league, url)
                print(f"  [{league}] found {len(rows)} upcoming matches")
                all_rows.extend(rows)
                unrecognised = [r["team1_raw"] for r in rows if r["team1"] == r["team1_raw"] and r["team1_raw"].strip().lower() not in TEAM_NAME_MAP]
                unrecognised += [r["team2_raw"] for r in rows if r["team2"] == r["team2_raw"] and r["team2_raw"].strip().lower() not in TEAM_NAME_MAP]
                if unrecognised:
                    print(f"  [{league}] *** UNRECOGNISED: {sorted(set(unrecognised))} ***")
            except Exception as e:
                print(f"  [{league}] error: {e}")
            time.sleep(2)

        browser.close()

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)
    out_path = ODDS_DIR / "upcoming_odds.csv"
    ODDS_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_path, index=False)
    print(f"Saved {len(df)} upcoming odds rows → {out_path}")
    return df


def scrape_league_year(league: str, year: int, headless: bool = True) -> pd.DataFrame:
    from playwright.sync_api import sync_playwright

    url = _league_year_url(league, year)
    target_years = {year}
    all_rows: List[Dict] = []
    seen_signatures = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_context().new_page()

        try:
            print(f"  [{league} {year}] loading page 1...")
            page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_timeout(WAIT_PAGE_LOAD * 1000)
            _dismiss_cookie(page)
            _settle_page(page)
            _wait_for_matches(page, timeout_ms=30_000)
        except Exception as e:
            print(f"  [{league} {year}] load error: {e}")
            browser.close()
            return pd.DataFrame()

        page_num = 1
        while page_num <= MAX_PAGES:
            print(f"  [{league} {year}] page {page_num}", end=" ", flush=True)
            try:
                body = _get_body(page)
            except Exception as e:
                print(f"→ read error: {e}")
                break

            sig = "\n".join(_clean_lines(body)[:120])
            if sig in seen_signatures:
                print("→ repeated page, stopping")
                break
            seen_signatures.add(sig)

            header_years = sorted(set(_page_header_years(body)))
            rows = _parse_page(body, league, page_num, page.url, target_years)
            finished = [r for r in rows if int(r.get("year", -1)) in target_years]

            if finished:
                print(f"→ {len(finished)} rows, header_years={header_years}")
                all_rows.extend(finished)
            else:
                print(f"→ no rows, header_years={header_years}, stopping")
                break

            if header_years and max(header_years) < year:
                print(f"  [{league} {year}] past target year, stopping")
                break

            old_body = body
            if not (_click_page(page, page_num + 1, old_body) or _click_next(page, old_body)):
                print(f"  [{league} {year}] no next page")
                break
            page_num += 1

        browser.close()

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)
    unrecognised = [r for r in sorted(set(df["team1_raw"].tolist() + df["team2_raw"].tolist()))
                    if r.strip().lower() not in TEAM_NAME_MAP]
    if unrecognised:
        print(f"  [{league} {year}] *** UNRECOGNISED names (add to TEAM_NAME_MAP): {unrecognised} ***")

    return df.drop_duplicates(subset=["league", "date_header", "team1", "team2", "score1", "score2"]).reset_index(drop=True)


def run(headless: bool = True) -> None:
    ODDS_DIR.mkdir(parents=True, exist_ok=True)

    all_dfs = []
    for league in LEAGUES:
        # Single-URL leagues (e.g. EWC) are scraped once, not per year
        if league.upper() in SINGLE_URL_LEAGUES:
            out_path = ODDS_DIR / f"odds_{league}.csv"
            df = scrape_league_year(league, CURRENT_YEAR, headless=headless)
            if not df.empty:
                df.to_csv(out_path, index=False)
                print(f"  [{league}] saved {len(df)} rows → {out_path.name}")
                all_dfs.append(df)
            time.sleep(2)
            continue

        for year in ALL_YEARS:
            out_path = ODDS_DIR / f"odds_{league}_{year}.csv"

            # Skip historical years if already scraped
            if year != CURRENT_YEAR and out_path.exists():
                print(f"  [{league} {year}] already scraped, skipping")
                all_dfs.append(pd.read_csv(out_path))
                continue

            df = scrape_league_year(league, year, headless=headless)
            if not df.empty:
                df.to_csv(out_path, index=False)
                print(f"  [{league} {year}] saved {len(df)} rows → {out_path.name}")
                all_dfs.append(df)
            time.sleep(2)

    if all_dfs:
        combined = pd.concat(all_dfs, ignore_index=True)
        combined_path = ODDS_DIR / "odds_all.csv"
        combined.to_csv(combined_path, index=False)
        print(f"\nCombined odds saved → {combined_path} ({len(combined)} rows)")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--upcoming":
        headless = "--headless" in sys.argv
        df = scrape_upcoming_odds(headless=headless)
        if not df.empty:
            print(df[["league", "match_date", "match_time", "team1", "team2",
                       "odd1_decimal", "odd2_decimal"]].to_string())
    elif len(sys.argv) > 1 and sys.argv[1] == "--test":

        MAX_PAGES = 3
        ODDS_DIR.mkdir(parents=True, exist_ok=True)
        df = scrape_league_year("LCK", CURRENT_YEAR, headless=False)
        if not df.empty:
            test_path = ODDS_DIR / "odds_test_LCK_2026.csv"
            df.to_csv(test_path, index=False)
            print(df[["league", "match_date", "team1", "team2", "series_score", "odd1_decimal", "odd2_decimal"]].to_string())
            print(f"\n{len(df)} rows scraped — saved to {test_path}")
        else:
            print("No data scraped — make sure your VPN is connected and try again")
    elif len(sys.argv) > 1 and sys.argv[1] == "--debug":
        # Debug mode: print raw body lines from page 1 of LCK 2026
        from playwright.sync_api import sync_playwright
        url = _league_year_url("LCK", CURRENT_YEAR)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            page = browser.new_context().new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_timeout(WAIT_PAGE_LOAD * 1000)
            _dismiss_cookie(page)
            _settle_page(page)
            _wait_for_matches(page, timeout_ms=30_000)
            body = _get_body(page)
            lines = _clean_lines(body)
            print(f"\n--- RAW BODY LINES ({len(lines)} total) ---")
            for i, line in enumerate(lines[:200]):
                print(f"{i:4d}: {line}")
            browser.close()
    else:
        run(headless=False)
