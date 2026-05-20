"""
upload_player_elos.py
Builds a ranked player ELO table from elo_state.json + roster_state.json
and uploads to the player_elos Supabase table.
"""

import json
import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(os.path.dirname(__file__)) / '..' / '.env')

PROCESSED_DIR = Path(os.path.dirname(__file__)) / '..' / 'data' / 'processed'


def run():
    # Load ELO state
    with open(PROCESSED_DIR / 'elo_state.json') as f:
        elo_state = json.load(f)
    elo_map = elo_state['elo_map']
    last_split = dict(elo_state['player_last_split'])

    # Load roster (team → [players])
    with open(PROCESSED_DIR / 'roster_state.json') as f:
        roster = json.load(f)
    player_team = {}
    for team, players in roster.items():
        for p in players:
            player_team[p] = team

    # Derive position and league from most recent games
    df = pd.read_csv(PROCESSED_DIR / 'games.csv', low_memory=False)
    df['date'] = pd.to_datetime(df['date'])

    pos_records = []
    for pos in ['top', 'jng', 'mid', 'bot', 'sup']:
        for side in ['blue', 'red']:
            col = f'{side}_{pos}_playername'
            team_col = f'{side}_team_teamname'
            league_col = 'league'
            if col not in df.columns:
                continue
            sub = df[['date', league_col, col, team_col]].dropna(subset=[col])
            sub = sub.rename(columns={col: 'player', team_col: 'team_from_game'})
            sub['position'] = pos
            pos_records.append(sub)

    pos_df = pd.concat(pos_records).sort_values('date', ascending=False)
    player_pos = pos_df.drop_duplicates('player').set_index('player')['position'].to_dict()

    # League per team from most recent game appearance
    blue_tl = df[['blue_team_teamname', 'league']].rename(columns={'blue_team_teamname': 'team'})
    red_tl  = df[['red_team_teamname',  'league']].rename(columns={'red_team_teamname':  'team'})
    team_to_league = (
        pd.concat([blue_tl, red_tl])
        .drop_duplicates('team')
        .set_index('team')['league']
        .to_dict()
    )

    records = []
    for player, elo in elo_map.items():
        team = player_team.get(player, '')
        if not team:
            continue  # skip players not on a current roster
        league = team_to_league.get(team, '')
        pos    = player_pos.get(player, '')
        ls     = last_split.get(player, [None, None])
        records.append({
            'player':     player,
            'elo':        round(float(elo), 1),
            'team':       team,
            'league':     league,
            'position':   pos,
            'last_year':  int(ls[0]) if ls and ls[0] is not None else None,
            'last_split': str(ls[1]) if ls and ls[1] and str(ls[1]) != 'nan' else None,
        })

    records.sort(key=lambda r: -r['elo'])
    print(f"Built {len(records)} player records")

    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_KEY')
    if not supabase_url or not supabase_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        return

    client = create_client(supabase_url, supabase_key)

    print("Deleting existing rows...")
    client.table('player_elos').delete().neq('player', '').execute()

    print(f"Uploading {len(records)} players...")
    for i in range(0, len(records), 500):
        batch = records[i:i+500]
        client.table('player_elos').insert(batch).execute()
        print(f"  {min(i+500, len(records))}/{len(records)}")

    print("Done.")


if __name__ == '__main__':
    run()
