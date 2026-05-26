"""
check_team_name_drift.py

Detects suspicious team-name mismatches between Polymarket events and our OE
data using PAIR-AWARE matching: for each upcoming Polymarket event, we check
whether the team-pair exists in OE under different normalized names. If one
team of the PM pair matches an OE team exactly but the other doesn't, we
know the unmatched team is a name drift and flag it with high confidence.

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


def _norm_team(s) -> str:
    """Mirror src/merge_polymarket_data.py:_norm_team exactly, including aliases."""
    s = str(s).lower()
    s = s.replace('ø', 'o').replace('ł', 'l').replace('æ', 'ae').replace('œ', 'oe')
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r'[^a-z0-9]', '', s)
    aliases = {
        't1academy':         't1esportsacademy',
        'pcific':            'pcificesports',
        'ucamesportsclub':   'ucamesports',
        'senshiesportsclub': 'senshiesports',
        'theotterside':      'otterside',
        'orbitanonymo':      'anonymoesports',
        'big':               'berlininternationalgaming',
    }
    return aliases.get(s, s)


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
        lines.append(
            f"• Event `{d['event_slug']}` ({d['match_date']}) — "
            f"PM **{d['polymarket_team']!r}** (key=`{d['polymarket_key']}`) "
            f"looks like OE **{d['oe_team']!r}** (key=`{d['oe_key']}`) — "
            f"opponent **{d['matched_opponent']!r}** matched both sides ✓"
        )
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

    # OE: last 90 days of games. Build:
    #   oe_team_to_name: normkey → display name
    #   oe_team_opponents: normkey → set of opponent normkeys (so we can ask
    #     "of all OE teams that have played X, which one looks most like Y?")
    games['date'] = pd.to_datetime(games['date'], errors='coerce')
    oe_cutoff = pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=90)
    games = games[games['date'] >= oe_cutoff]

    oe_team_to_name:  dict[str, str]      = {}
    oe_team_opponents: dict[str, set[str]] = {}
    for _, g in games.iterrows():
        bk, rk = _norm_team(g['blue_team_teamname']), _norm_team(g['red_team_teamname'])
        oe_team_to_name.setdefault(bk, str(g['blue_team_teamname']))
        oe_team_to_name.setdefault(rk, str(g['red_team_teamname']))
        oe_team_opponents.setdefault(bk, set()).add(rk)
        oe_team_opponents.setdefault(rk, set()).add(bk)

    # PM events: keep upcoming / very-recent only.
    snaps['match_date'] = pd.to_datetime(snaps['match_date'], errors='coerce', utc=True)
    snaps = snaps[snaps['match_date'].notna()]
    pm_cutoff = pd.Timestamp.utcnow() - pd.Timedelta(days=2)
    snaps = snaps[snaps['match_date'] >= pm_cutoff]

    # Unique events: one row per (event_slug, team1, team2, match_date)
    events = (snaps.groupby('event_slug')
                    .agg(team1=('team1', 'first'),
                         team2=('team2', 'first'),
                         match_date=('match_date', 'first'))
                    .reset_index())

    drifts: list[dict] = []
    for _, ev in events.iterrows():
        k1, k2 = _norm_team(ev['team1']), _norm_team(ev['team2'])
        # If both teams have exact-key matches in OE, no drift to report.
        # (The merge would have worked. If it didn't, that's a different bug
        # class we surface separately below.)
        in_oe = (k1 in oe_team_to_name, k2 in oe_team_to_name)
        if all(in_oe):
            continue

        # Pair-aware drift: if ONE team matches OE exactly and the other doesn't,
        # the unmatched side is the drift. Restrict candidate OE teams to those
        # that have actually played the matched team (most informative signal).
        if in_oe[0] and not in_oe[1]:
            anchor_pm, anchor_key  = ev['team1'], k1
            drift_pm,  drift_key   = ev['team2'], k2
        elif in_oe[1] and not in_oe[0]:
            anchor_pm, anchor_key  = ev['team2'], k2
            drift_pm,  drift_key   = ev['team1'], k1
        else:
            # Neither team matched OE. Less actionable — could be a brand-new
            # team or a fully unmapped name. Skip to keep noise low.
            continue

        # First try: candidates are OE teams the anchor has actually played
        # (highest signal — proves the matchup exists in OE).
        opponents = oe_team_opponents.get(anchor_key, set())
        best = None
        if opponents:
            for cand_key in opponents:
                sim = SequenceMatcher(None, drift_key, cand_key).ratio()
                if best is None or sim > best['similarity']:
                    best = {'oe_team': oe_team_to_name[cand_key],
                            'oe_key':  cand_key,
                            'similarity': round(sim, 3),
                            'via': 'anchor-opponent'}

        # Fallback: PM team and OE team are similar enough that they're
        # plausibly the same team, even if anchor hasn't played them yet.
        # Tighter ratio threshold here to avoid false positives.
        FALLBACK_MIN_RATIO = 0.80
        if best is None or best['similarity'] < FALLBACK_MIN_RATIO:
            for cand_key, cand_name in oe_team_to_name.items():
                if len(cand_key) < 6: continue
                sim = SequenceMatcher(None, drift_key, cand_key).ratio()
                if sim >= FALLBACK_MIN_RATIO and (best is None or sim > best['similarity']):
                    best = {'oe_team': cand_name,
                            'oe_key':  cand_key,
                            'similarity': round(sim, 3),
                            'via': 'global-fuzzy'}
        if best is None or best['similarity'] < 0.5:
            continue

        drifts.append({
            'event_slug':       ev['event_slug'],
            'match_date':       ev['match_date'].strftime('%Y-%m-%d'),
            'matched_opponent': anchor_pm,            # the team that did match (PM side)
            'matched_opponent_oe': oe_team_to_name[anchor_key],
            'polymarket_team':  drift_pm,             # the PM team that drifted
            'polymarket_key':   drift_key,
            'oe_team':          best['oe_team'],      # best OE guess
            'oe_key':           best['oe_key'],
            'similarity':       best['similarity'],
            'via':              best['via'],
        })

    drifts.sort(key=lambda d: (-d['similarity'], d['match_date']))

    existing = _load_existing()
    prev_keys = {(d['polymarket_key'], d.get('oe_key', '')) for d in existing.get('drifts', [])}
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
    for d in drifts[:20]:
        print(f"    {d['event_slug']:<32} ({d['match_date']})  PM {d['polymarket_team']!r:<24} ↔ OE {d['oe_team']!r:<24}  (anchor: {d['matched_opponent']!r})  ratio={d['similarity']}")

    if new_drifts:
        _post_discord(new_drifts)

    return 0


if __name__ == '__main__':
    sys.exit(main())
