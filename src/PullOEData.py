import gdown
import os

FOLDER_ID = "1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH"
CURRENT_YEAR_FILE_ID = "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm"

RAW_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw')
CURRENT_YEAR = 2026
HISTORICAL_YEARS = list(range(2014, CURRENT_YEAR))

os.makedirs(RAW_DIR, exist_ok=True)

# Download entire folder if any historical year is missing
missing_years = [
    y for y in HISTORICAL_YEARS
    if not os.path.exists(os.path.join(RAW_DIR, f"{y}_LoL_esports_match_data_from_OraclesElixir.csv"))
]
if missing_years:
    print(f"Missing historical years: {missing_years}. Downloading full folder...")
    gdown.download_folder(id=FOLDER_ID, output=RAW_DIR, quiet=False)
else:
    print("All historical years present, skipping folder download.")

# Always re-download the current year since it updates regularly
print(f"Refreshing {CURRENT_YEAR} data...")
gdown.download(id=CURRENT_YEAR_FILE_ID, output=os.path.join(RAW_DIR, f"{CURRENT_YEAR}_LoL_esports_match_data_from_OraclesElixir.csv"), quiet=False)



