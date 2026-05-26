"""
check_team_name_drift.py

Detects suspicious team-name mismatches between Polymarket events and our OE
data. After normalization (_norm_team), exact-key matches succeed; this script
flags cases where the normalized keys differ by 1–2 characters — usually the
sign of a Unicode quirk we haven't mapped, a missing space, or a vendor-specific
abbreviation that should be aliased.

Outputs:
  • web/public/team_name_drift.json — machine-readable list of suspect pairs
  • Discord notification if DISCORD_WEBHOOK is set in env (only when new
    drifts appear since the last run)

Run as part of daily.yml. Self-contained — only needs polymarket_submarket_snapshots.csv
and games.csv on disk.
"""
import datetime
import json
import os
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import pandas as pd
import requests

ROOT       = Path(__file__).resolve().parent.parent
PROCESSED  = ROOT / 'data' / 'processed'
GAMES_CSV  = PROCESSED / 'games.csv'
SNAP_CSV   = PROCESSED / 'polymarket_submarket_snapshots.csv'
OUT_PATH   = ROOT / 'web' / 'public' / 'team_name_drift.json'

# Edit-distance thresholds for "suspiciously close" team-name matches.
# Smaller = stricter (fewer flags). The combo below catches "Nongshim RedForce"
# vs "Nongshim Red Force" (no normalized diff once spaces are stripped, so they
# match exactly) and "BNK FEARX" vs "BNK FearX" (also normalize-equal). What
# we DO want to catch is cases where two normalized keys differ by 1-2 chars
# OR have a long shared prefix/suffix but a small disagreement in the middle
# (e.g. 'tloesports' vs 'teamloesports').
MAX_EDIT_DIST   = 2     # absolute character difference (Levenshtein)
MIN_SIMILARITY  = 0.80  # SequenceMatcher ratio (handles substring drift better)
# Reject short-string false positives: "BIG" vs "NRG" has edit dist 2 but
# they're clearly different teams. Require both that the strings are at least
# moderately long (≥6 chars after normalization) AND share enough characters.
MIN_LENGTH      = 6     # min normalized key length to consider
HARD_MIN_RATIO  = 0.70  # always require at least this much similarity


def _norm_team(s) -> str:
    """Mirror src/merge_polymarket_data.py:_norm_team exactly."""
    s = str(s).lower()
    s = s.replace('ø', 'o').replace('ł', 'l').replace('æ', 'ae').replace('œ', 'oe')
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]', '', s)


def _edit_distance(a: str, b: str) -> int:
    """Standard Levenshtein. Small strings; quadratic is fine."""
    if a == b: return 0
    if not a:  return len(b)
    if not b:  return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = curr
    return prev[-1]


def _load_existing() -> dict:
    if OUT_PATH.exists():
        try:    return json.loads(OUT_PATH.read_text())
        except Exception: return {}
    return {}


def _post_discord(new_drifts: list[dict]) -> None:
    webhook = os.environ.get('DISCORD_WEBHOOK', '').strip()
    if not webhook or not new_drifts:
        return
    lines = ['**Team-name drift detected — Polymarket markets that look like OE teams but don\'t match exactly**', '']
    for d in new_drifts[:10]:
        lines.append(f"• **{d['polymarket_team']!r}** (Polymarket, key=`{d['polymarket_key']}`) ↔ **{d['oe_team']!r}** (OE, key=`{d['oe_key']}`) — edit dist {d['edit_distance']}, ratio {d['similarity']:.2f}")
    if len(new_drifts) > 10:
        lines.append(f"… and {len(new_drifts) - 10} more (see team_name_drift.json)")
    lines.append('')
    lines.append('Fix in `src/merge_polymarket_data.py:_norm_team` (add a `.replace()`) so the merge picks up these games.')
    payload = {'content': '\n'.join(lines)[:1900]}
    try:
        r = requests.post(webhook, json=payload, timeout=10)
        if r.status_code >= 300:
            print(f'  Discord webhook returned {r.status_code}: {r.text[:200]}')
    except Exception as e:
        print(f'  Discord post failed: {e!r}')


def main() -> int:
    if not SNAP_CSV.exists():
        print(f'  {SNAP_CSV.name} missing — skipping drift check')
        return 0
    if not GAMES_CSV.exists():
        print(f'  {GAMES_CSV.name} missing — skipping drift check')
        return 0

    snaps = pd.read_csv(SNAP_CSV, low_memory=False)
    games = pd.read_csv(GAMES_CSV, low_memory=False, usecols=['blue_team_teamname', 'red_team_teamname', 'date'])

    # Restrict to recent OE games (last 90 days) so we don't flag historical
    # teams that no longer play but might appear as nearest neighbors.
    games['date'] = pd.to_datetime(games['date'], errors='coerce')
    oe_cutoff = pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=90)
    games = games[games['date'] >= oe_cutoff]

    # Build OE team set + a name lookup (display name for each normalized key)
    oe_keys: dict[str, str] = {}
    for col in ('blue_team_teamname', 'red_team_teamname'):
        for name in games[col].dropna().unique():
            oe_keys.setdefault(_norm_team(name), str(name))

    # Polymarket teams from snapshot CSV — UPCOMING events only.
    # (A small grace window catches a market that just resolved today, so the
    # daily run still flags a mismatch we missed.)
    snaps['match_date'] = pd.to_datetime(snaps['match_date'], errors='coerce', utc=True)
    snaps = snaps[snaps['match_date'].notna()]
    pm_cutoff = pd.Timestamp.utcnow() - pd.Timedelta(days=1)
    snaps = snaps[snaps['match_date'] >= pm_cutoff]
    pm_keys: dict[str, str] = {}
    for col in ('team1', 'team2'):
        for name in snaps[col].dropna().unique():
            pm_keys.setdefault(_norm_team(name), str(name))

    # Find Polymarket teams that don't have an exact OE match but are
    # suspiciously close to an OE team.
    drifts: list[dict] = []
    for pm_key, pm_name in pm_keys.items():
        if pm_key in oe_keys:
            continue  # exact match — already wired in
        if len(pm_key) < MIN_LENGTH:
            continue  # too short to fuzzy-match reliably
        # Find best OE candidate
        best = None
        for oe_key, oe_name in oe_keys.items():
            if len(oe_key) < MIN_LENGTH:
                continue
            ed  = _edit_distance(pm_key, oe_key)
            sim = SequenceMatcher(None, pm_key, oe_key).ratio()
            if sim < HARD_MIN_RATIO:
                continue  # protects against short-string false positives
            if ed <= MAX_EDIT_DIST or sim >= MIN_SIMILARITY:
                if best is None or ed < best['edit_distance']:
                    best = {
                        'polymarket_team': pm_name,
                        'polymarket_key':  pm_key,
                        'oe_team':         oe_name,
                        'oe_key':          oe_key,
                        'edit_distance':   ed,
                        'similarity':      round(sim, 3),
                    }
        if best is not None:
            drifts.append(best)

    drifts.sort(key=lambda d: (d['edit_distance'], -d['similarity']))

    existing = _load_existing()
    prev_keys = {(d['polymarket_key'], d['oe_key']) for d in existing.get('drifts', [])}
    new_drifts = [d for d in drifts if (d['polymarket_key'], d['oe_key']) not in prev_keys]

    out = {
        'generated_at_utc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'total_drifts':     len(drifts),
        'new_drifts':       len(new_drifts),
        'drifts':           drifts,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2))

    print(f'  Found {len(drifts)} suspect team-name pairs (new since last run: {len(new_drifts)})')
    for d in drifts[:15]:
        print(f'    {d["polymarket_team"]!r:<35} (PM, {d["polymarket_key"]!r}) ↔ {d["oe_team"]!r:<35} (OE, {d["oe_key"]!r})  ed={d["edit_distance"]}  ratio={d["similarity"]}')

    if new_drifts:
        _post_discord(new_drifts)

    return 0


if __name__ == '__main__':
    sys.exit(main())
