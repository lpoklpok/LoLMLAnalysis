"""
export_champ_stats.py
Produces web/public/champ_stats.json — used by the /predict page's Draft
Mode toggle to compute the post-draft model's champion-level features
client-side.

Output structure:
{
  "generated":     "...",
  "as_of":         "YYYY-MM-DD",
  "meta_lookback_days":   14,
  "player_lookback_days": 30,
  "champions": [...],       # sorted list of all champ names seen recently
  "meta_wr": {              # 14-day per-(champion, position) global WR
      "Renekton|top": { "games": 47, "wr": 0.532 },
      ...
  },
  "player_champ": {         # 30-day per-(player, champion) WR
      "Kiin|Renekton":  { "games": 6, "wr": 0.667 },
      ...
  }
}
"""
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT      = Path(__file__).resolve().parent.parent
SRC       = ROOT / 'data' / 'processed' / 'games_with_odds.csv'
ROSTER    = ROOT / 'data' / 'processed' / 'roster_state.json'
OUT       = ROOT / 'web' / 'public' / 'champ_stats.json'

POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']
META_DAYS   = 14
PLAYER_DAYS = 30
MAJOR_LEAGUES = ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'LTA N', 'LTA S',
                 'WLDs', 'MSI', 'EWC', 'FST']
MIN_META_GAMES   = 5    # below this we omit (too noisy)
MIN_PLAYER_GAMES = 1    # show any pick


def main():
    print(f'Loading {SRC.name}...')
    df = pd.read_csv(SRC, low_memory=False)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    now = datetime.now(timezone.utc)

    # Meta WR — all leagues, last 14 days, per-position
    recent_meta = df[df['date'] >= now - timedelta(days=META_DAYS)].copy()
    print(f'  recent {META_DAYS}d games: {len(recent_meta):,}')

    meta_agg: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])  # [games, wins]
    for _, g in recent_meta.iterrows():
        blue_won = int(g['blue_team_result']) == 1
        for pos in POSITIONS:
            for side, side_won in [('blue', blue_won), ('red', not blue_won)]:
                champ = g.get(f'{side}_{pos}_champion')
                if not isinstance(champ, str) or not champ:
                    continue
                k = (champ, pos)
                meta_agg[k][0] += 1
                meta_agg[k][1] += int(side_won)

    meta_wr = {}
    for (champ, pos), (n, w) in meta_agg.items():
        if n < MIN_META_GAMES: continue
        meta_wr[f'{champ}|{pos}'] = {'games': n, 'wr': round(w / n, 4)}
    print(f'  meta_wr entries (>= {MIN_META_GAMES} games): {len(meta_wr):,}')

    # Player-champ WR — major-league players, last 30 days
    with open(ROSTER) as f:
        rosters = json.load(f)
    active_players: set[str] = set()
    for team, players in rosters.items():
        active_players.update(players)
    print(f'  active major-league players: {len(active_players):,}')

    recent_player = df[(df['date'] >= now - timedelta(days=PLAYER_DAYS)) &
                       (df['league'].isin(MAJOR_LEAGUES))].copy()
    print(f'  recent {PLAYER_DAYS}d games (majors): {len(recent_player):,}')

    pc_agg: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for _, g in recent_player.iterrows():
        blue_won = int(g['blue_team_result']) == 1
        for pos in POSITIONS:
            for side, side_won in [('blue', blue_won), ('red', not blue_won)]:
                p     = g.get(f'{side}_{pos}_playername')
                champ = g.get(f'{side}_{pos}_champion')
                if not isinstance(p, str) or not isinstance(champ, str):
                    continue
                if p not in active_players:
                    continue
                k = (p, champ)
                pc_agg[k][0] += 1
                pc_agg[k][1] += int(side_won)

    player_champ = {}
    for (p, c), (n, w) in pc_agg.items():
        if n < MIN_PLAYER_GAMES: continue
        player_champ[f'{p}|{c}'] = {'games': n, 'wr': round(w / n, 4)}
    print(f'  player_champ entries: {len(player_champ):,}')

    # Champion list for autocomplete (all champs ever picked, sorted)
    all_champs: set[str] = set()
    for _, g in df.iterrows():
        for pos in POSITIONS:
            for side in ('blue', 'red'):
                c = g.get(f'{side}_{pos}_champion')
                if isinstance(c, str) and c:
                    all_champs.add(c)
    champions = sorted(all_champs)
    print(f'  total unique champions seen: {len(champions)}')

    payload = {
        'generated':            now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'as_of':                now.strftime('%Y-%m-%d'),
        'meta_lookback_days':   META_DAYS,
        'player_lookback_days': PLAYER_DAYS,
        'champions':            champions,
        'meta_wr':              meta_wr,
        'player_champ':         player_champ,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload))
    kb = OUT.stat().st_size / 1024
    print(f'\nWrote {OUT} ({kb:.0f}KB)')


if __name__ == '__main__':
    main()
