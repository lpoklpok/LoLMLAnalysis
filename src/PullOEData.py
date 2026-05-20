import gdown
import os
import requests

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

# Refresh current year data with fallback if Google Drive rate-limits gdown
output_path = os.path.join(RAW_DIR, f"{CURRENT_YEAR}_LoL_esports_match_data_from_OraclesElixir.csv")
print(f"Refreshing {CURRENT_YEAR} data...")

def _validate_csv(path):
    """Raise if `path` doesn't look like a CSV (Google Drive returns HTML on quota hits)."""
    with open(path, "rb") as f:
        head = f.read(256).lstrip()
    if head.startswith(b"<!DOCTYPE") or head.startswith(b"<html"):
        raise RuntimeError("Downloaded payload is HTML, not CSV (likely Google Drive quota page).")
    if len(head) < 32:
        raise RuntimeError(f"Downloaded payload is suspiciously small ({len(head)} bytes).")


def download_via_requests(file_id, path):
    session = requests.Session()
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    r = session.get(url, stream=True)
    # Handle large-file confirm token
    confirm = next((v for k, v in r.cookies.items() if k.startswith("download_warning")), None)
    if confirm:
        r = session.get(url + f"&confirm={confirm}", stream=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        for chunk in r.iter_content(32768):
            if chunk:
                f.write(chunk)
    _validate_csv(tmp)
    os.replace(tmp, path)


tmp_path = output_path + ".gdown.tmp"
try:
    gdown.download(id=CURRENT_YEAR_FILE_ID, output=tmp_path, quiet=False)
    _validate_csv(tmp_path)
    os.replace(tmp_path, output_path)
    print("gdown succeeded.")
except Exception as e:
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    print(f"gdown failed ({e}), trying direct requests download...")
    try:
        download_via_requests(CURRENT_YEAR_FILE_ID, output_path)
        print("requests download succeeded.")
    except Exception as e2:
        if os.path.exists(output_path):
            print(f"Both download methods failed ({e2}). Using cached file from previous run.")
        else:
            raise RuntimeError(f"Could not download {CURRENT_YEAR} data and no cache exists.") from e2
