import pandas as pd
import glob
import os
import warnings

RAW_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw')
PROCESSED_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'processed')

YEARS = [2024, 2025, 2026]
POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup']

# Columns that describe the game itself, not a specific team or player
GAME_META_COLS = ['gameid', 'league', 'year', 'split', 'playoffs', 'date', 'game', 'patch', 'gamelength']

# Columns to exclude from team/player prefixing (used for pivoting or already in meta)
EXCLUDE_COLS = set(GAME_META_COLS + ['side', 'position', 'datacompleteness', 'url'])

# Only these columns are kept per player (everything else is on the team rows)
PLAYER_KEEP_COLS = ['playername', 'champion', 'golddiffat10', 'golddiffat15', 'golddiffat20', 'golddiffat25']


def load_raw():
    dfs = []
    for year in YEARS:
        path = os.path.join(RAW_DIR, f"{year}_LoL_esports_match_data_from_OraclesElixir.csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing: {path}. Run PullOEData.py first.")
        print(f"Loading {year}...")
        dfs.append(pd.read_csv(path, low_memory=False))
    df = pd.concat(dfs, ignore_index=True)
    df['position'] = df['position'].str.lower()
    df['side'] = df['side'].str.lower()
    print(f"Total rows loaded: {len(df):,}")
    return df


def pivot_to_one_row_per_game(df):
    stat_cols = [c for c in df.columns if c not in EXCLUDE_COLS]

    # Game metadata — same across all 12 rows, take first occurrence
    meta = df.groupby('gameid')[GAME_META_COLS[1:]].first()

    # Team rows (position == 'team'): prefix with blue_team_ or red_team_
    team_df = df[df['position'] == 'team'][['gameid', 'side'] + stat_cols]
    blue_team = (team_df[team_df['side'] == 'blue']
                 .drop(columns='side')
                 .set_index('gameid')
                 .add_prefix('blue_team_'))
    red_team = (team_df[team_df['side'] == 'red']
                .drop(columns='side')
                .set_index('gameid')
                .add_prefix('red_team_'))

    # Player rows: only keep champion + gold diff columns
    player_df = df[df['position'].isin(POSITIONS)][['gameid', 'side', 'position'] + PLAYER_KEEP_COLS]
    player_pivots = []
    for side in ['blue', 'red']:
        for pos in POSITIONS:
            subset = (player_df[(player_df['side'] == side) & (player_df['position'] == pos)]
                      .drop(columns=['side', 'position'])
                      .set_index('gameid')
                      .add_prefix(f'{side}_{pos}_'))
            player_pivots.append(subset)

    with warnings.catch_warnings():
        warnings.simplefilter('ignore', pd.errors.PerformanceWarning)
        result = pd.concat([meta, blue_team, red_team] + player_pivots, axis=1).reset_index().copy()
    print(f"Games after pivot: {len(result):,}")
    return result


def run():
    os.makedirs(PROCESSED_DIR, exist_ok=True)
    df = load_raw()
    games = pivot_to_one_row_per_game(df)
    output_path = os.path.join(PROCESSED_DIR, 'games.csv')
    games.to_csv(output_path, index=False)
    print(f"Saved to {output_path} — {len(games.columns):,} columns")
    return games


if __name__ == '__main__':
    run()
