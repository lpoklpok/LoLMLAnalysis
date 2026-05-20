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


_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _download_url_to_tmp(url: str, path: str, headers: dict | None = None) -> None:
    """Stream a single URL into path+.tmp, validate, then move into place."""
    session = requests.Session()
    if headers:
        session.headers.update(headers)
    r = session.get(url, stream=True, allow_redirects=True)
    # Old-style cookie-based confirm token (still hit for some files)
    confirm = next((v for k, v in r.cookies.items() if k.startswith("download_warning")), None)
    if confirm:
        sep = "&" if "?" in url else "?"
        r = session.get(f"{url}{sep}confirm={confirm}", stream=True, allow_redirects=True)
    tmp = path + ".requests.tmp"
    try:
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(32768):
                if chunk:
                    f.write(chunk)
        _validate_csv(tmp)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def download_via_requests(file_id: str, path: str) -> None:
    """
    Try several Drive download endpoints in order. The legacy /uc endpoint and
    the newer drive.usercontent endpoint go through different CDN caches, so
    one may serve fresher data than the other. Browser-like User-Agent helps
    avoid being routed to the API-side cache.
    """
    import time
    cb = int(time.time())  # cache-busting query param
    attempts = [
        (f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t&_cb={cb}",
         {"User-Agent": _BROWSER_UA}),
        (f"https://drive.google.com/uc?export=download&id={file_id}&confirm=t&_cb={cb}",
         {"User-Agent": _BROWSER_UA}),
        (f"https://drive.google.com/uc?export=download&id={file_id}",
         None),  # original, no UA — matches old behavior
    ]
    last_err = None
    for url, headers in attempts:
        try:
            _download_url_to_tmp(url, path, headers=headers)
            return
        except Exception as e:
            last_err = e
            print(f"  attempt failed: {url.split('?')[0]} → {e}")
    raise RuntimeError(f"All Drive endpoints failed; last error: {last_err}")


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
