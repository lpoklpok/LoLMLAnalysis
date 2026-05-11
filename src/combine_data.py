import pandas as pd
import glob
import os

RAW_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')

def load_and_combine():
    csv_files = glob.glob(os.path.join(RAW_DIR, '202[4-6]*.csv'))
    if not csv_files:
        raise FileNotFoundError(f"No 2024-2026 CSV files found in {RAW_DIR}")

    dfs = []
    for f in sorted(csv_files):
        print(f"Loading {os.path.basename(f)}...")
        dfs.append(pd.read_csv(f, low_memory=False))

    combined = pd.concat(dfs, ignore_index=True)
    print(f"Combined: {len(combined):,} rows")

    # Oracle's Elixir uses 'position' column; team-level rows have value 'team'
    pos_col = 'position' if 'position' in combined.columns else 'role'
    team_df = combined[combined[pos_col].str.lower() == 'team'].copy()
    print(f"Team rows: {len(team_df):,}")

    # Each game has 2 team rows (one per team); group by gameid to get both
    team_df = team_df.sort_values(['gameid', 'teamid'] if 'teamid' in team_df.columns else 'gameid')

    output_path = os.path.join(OUTPUT_DIR, 'team_games.csv')
    team_df.to_csv(output_path, index=False)
    print(f"Saved to {output_path}")
    return team_df

if __name__ == '__main__':
    df = load_and_combine()
    print(df.head())
