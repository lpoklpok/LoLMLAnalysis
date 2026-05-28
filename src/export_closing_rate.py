"""
export_closing_rate.py
For every team, compute their "closing rate" — the average gap between the
in-game-20 model's predicted win probability and whether they actually won.

closing_rate(team) = mean( (1 if won else 0) - in_game_20_pred )
                        across games where the team played and gd@20 exists

Positive  → team wins more often than the 20-min state suggests (closers/comebackers)
Negative  → team wins less often than the 20-min state suggests (throwers)

Output: web/public/closing_rate.json — for the findings page.

Filters to the last 90 days by default and to teams with >= 8 qualifying games
(otherwise the sample is too noisy to trust).
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
ROOT = Path(__file__).resolve().parent.parent
OUT  = ROOT / 'web' / 'public' / 'closing_rate.json'

MAJOR = ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'LTA N', 'LTA S',
         'WLDs', 'MSI', 'EWC', 'FST']
LOOKBACK_DAYS = 90
MIN_GAMES     = 8


def main():
    client = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_KEY'])
    cutoff = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).strftime('%Y-%m-%dT%H:%M:%S+00:00')
    print(f'Filtering to games on/after {cutoff[:10]}')

    rows = []
    offset = 0
    while True:
        r = (client.table('game_features')
                  .select('date,league,blue_team,red_team,blue_win,model_pred_in_game_20')
                  .gte('date', cutoff)
                  .in_('league', MAJOR)
                  .range(offset, offset + 999)
                  .execute())
        if not r.data: break
        rows.extend(r.data)
        if len(r.data) < 1000: break
        offset += 1000

    df = pd.DataFrame(rows)
    if 'model_pred_in_game_20' in df.columns:
        df = df.dropna(subset=['model_pred_in_game_20'])
    if 'model_pred_in_game_20' not in df.columns or df.empty:
        print('model_pred_in_game_20 column missing or empty — writing empty payload.')
        payload = {
            'generated':     datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'lookback_days': LOOKBACK_DAYS,
            'min_games':     MIN_GAMES,
            'leagues':       MAJOR,
            'closers':       [], 'throwers': [],
            'note':          'Column not yet populated. Will fill in after next cron run.',
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(payload, indent=2))
        return
    print(f'Loaded {len(df):,} games with in_game_20 prediction')

    # Build per-team records — both as blue and as red
    records = []
    for _, g in df.iterrows():
        blue_pred = float(g['model_pred_in_game_20'])
        # Blue's record on this game
        records.append({
            'team': g['blue_team'], 'opp': g['red_team'],
            'side': 'blue', 'pred': blue_pred, 'won': int(g['blue_win'] == 1),
        })
        # Red's record (flip)
        records.append({
            'team': g['red_team'], 'opp': g['blue_team'],
            'side': 'red',  'pred': 1 - blue_pred, 'won': int(g['blue_win'] == 0),
        })
    rec = pd.DataFrame(records)
    rec['delta'] = rec['won'] - rec['pred']

    agg = (rec.groupby('team')
              .agg(n_games=('won', 'count'),
                   wins=('won', 'sum'),
                   avg_pred=('pred', 'mean'),
                   actual_wr=('won', 'mean'),
                   closing_rate=('delta', 'mean'))
              .reset_index())
    agg = agg[agg['n_games'] >= MIN_GAMES].copy()
    agg = agg.sort_values('closing_rate', ascending=False)
    print(f'Teams with >= {MIN_GAMES} games: {len(agg)}')

    payload = {
        'generated':      datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'lookback_days':  LOOKBACK_DAYS,
        'min_games':      MIN_GAMES,
        'leagues':        MAJOR,
        'closers': [
            {'team': r['team'], 'n_games': int(r['n_games']), 'wins': int(r['wins']),
             'avg_pred': round(float(r['avg_pred']), 4),
             'actual_wr': round(float(r['actual_wr']), 4),
             'closing_rate': round(float(r['closing_rate']), 4)}
            for _, r in agg.head(15).iterrows()
        ],
        'throwers': [
            {'team': r['team'], 'n_games': int(r['n_games']), 'wins': int(r['wins']),
             'avg_pred': round(float(r['avg_pred']), 4),
             'actual_wr': round(float(r['actual_wr']), 4),
             'closing_rate': round(float(r['closing_rate']), 4)}
            for _, r in agg.tail(15).iloc[::-1].iterrows()
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2))
    print(f'Wrote {OUT}')
    print(f'\nTop 5 closers:')
    for r in payload['closers'][:5]:
        print(f"  {r['team']:30}  +{r['closing_rate']*100:>5.1f}pp  ({r['wins']}/{r['n_games']} actual vs {r['avg_pred']*100:.0f}% expected)")
    print(f'Top 5 throwers:')
    for r in payload['throwers'][:5]:
        print(f"  {r['team']:30}  {r['closing_rate']*100:>+5.1f}pp  ({r['wins']}/{r['n_games']} actual vs {r['avg_pred']*100:.0f}% expected)")


if __name__ == '__main__':
    main()
