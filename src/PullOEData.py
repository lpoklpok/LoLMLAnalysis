import gdown
import os
import requests

FOLDER_ID = "1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH"
# Default = Tim Sevenhuysen's original CSV. Two override modes:
#   1. OE_DRIVE_FILE_ID:   direct file ID (you copied the file once, paste the
#                          new ID). Use this for a single-shot manual fix.
#   2. OE_DRIVE_FOLDER_ID: ID of a folder in your own Drive (shared "anyone
#                          with link"). PullOEData uses the Drive API to list
#                          the folder, picks the file whose name contains the
#                          CURRENT_YEAR, and downloads that. You manage by
#                          deleting/adding files inside the folder — no need
#                          to re-edit the GitHub secret per refresh.
# Folder mode takes precedence when both are set.
CURRENT_YEAR_FILE_ID = os.environ.get("OE_DRIVE_FILE_ID") or "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm"
OVERRIDE_FOLDER_ID   = os.environ.get("OE_DRIVE_FOLDER_ID")

RAW_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw')
CURRENT_YEAR = 2026
HISTORICAL_YEARS = list(range(2014, CURRENT_YEAR))

os.makedirs(RAW_DIR, exist_ok=True)


def resolve_file_id_from_folder(folder_id: str) -> str | None:
    """Use Drive v3 files.list to find a CSV in the folder whose name contains
    str(CURRENT_YEAR). Returns the file ID, or None if not found. Requires
    GOOGLE_API_KEY to be set (uses the API key to list public folder contents).
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("  OE_DRIVE_FOLDER_ID set but GOOGLE_API_KEY missing — can't list folder")
        return None
    q = f"'{folder_id}' in parents and trashed = false"
    url = (
        "https://www.googleapis.com/drive/v3/files"
        f"?q={requests.utils.quote(q)}"
        "&fields=files(id,name,modifiedTime,mimeType)"
        f"&key={api_key}"
    )
    try:
        r = requests.get(url, timeout=30)
        if r.status_code != 200:
            print(f"  folder list HTTP {r.status_code}: {r.text[:300]}")
            return None
        files = (r.json() or {}).get("files", [])
    except Exception as e:
        print(f"  folder list error: {e}")
        return None
    if not files:
        print(f"  folder {folder_id} appears empty")
        return None
    print(f"  folder contains {len(files)} file(s):")
    for f in files:
        print(f"    - {f.get('name')}  (id={f.get('id')}, modified={f.get('modifiedTime')})")
    # Prefer file whose name contains the current year
    year_str = str(CURRENT_YEAR)
    cands = [f for f in files if year_str in (f.get("name") or "")]
    pick = cands[0] if cands else None
    if pick is None and len(files) == 1:
        pick = files[0]
        print(f"  no name match for {year_str}; only one file in folder — using it")
    if pick is None:
        print(f"  no file in folder matches {year_str} and folder has multiple files")
        return None
    print(f"  → picking '{pick.get('name')}' ({pick.get('id')})")
    return pick.get("id")


if OVERRIDE_FOLDER_ID:
    print(f"OE_DRIVE_FOLDER_ID set — looking up current-year file in folder {OVERRIDE_FOLDER_ID}")
    new_id = resolve_file_id_from_folder(OVERRIDE_FOLDER_ID)
    if new_id:
        CURRENT_YEAR_FILE_ID = new_id
    else:
        print("  folder lookup failed; falling back to OE_DRIVE_FILE_ID / default")

print(f"Using current-year FILE_ID = {CURRENT_YEAR_FILE_ID}"
      f" {'(folder override)' if OVERRIDE_FOLDER_ID else ('(file override)' if os.environ.get('OE_DRIVE_FILE_ID') else '(default — Tim Sevenhuysen original)')}")

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
    """Raise if `path` doesn't look like a CSV. Catches:
      - HTML (Google Drive quota page)
      - JSON (Drive API error response, e.g., 403 / 404 / quota)
      - Truncated / suspiciously small payloads
      - Files missing the expected header columns
    """
    with open(path, "rb") as f:
        head = f.read(2048).lstrip()
    if head.startswith(b"<!DOCTYPE") or head.startswith(b"<html"):
        raise RuntimeError("Downloaded payload is HTML, not CSV (Google Drive quota page).")
    if head.startswith(b"{") or head.startswith(b"["):
        # Drive API returns JSON-shaped errors when the call fails
        snippet = head[:300].decode("utf-8", errors="replace")
        raise RuntimeError(f"Downloaded payload is JSON, not CSV (API error). Body: {snippet}")
    if len(head) < 256:
        raise RuntimeError(f"Downloaded payload is suspiciously small ({len(head)} bytes).")
    # The OE CSV header starts with 'gameid' — sanity-check we actually got it
    first_line = head.split(b"\n", 1)[0]
    if b"gameid" not in first_line:
        raise RuntimeError(f"Downloaded payload doesn't look like OE CSV (first line: {first_line[:120]!r})")


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
    if r.status_code >= 400:
        body = r.text[:500] if r.text else ""
        raise RuntimeError(f"HTTP {r.status_code} from {url.split('?')[0]}: {body}")
    # Old-style cookie-based confirm token (still hit for some files)
    confirm = next((v for k, v in r.cookies.items() if k.startswith("download_warning")), None)
    if confirm:
        sep = "&" if "?" in url else "?"
        r = session.get(f"{url}{sep}confirm={confirm}", stream=True, allow_redirects=True)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code} after confirm: {r.text[:500]}")
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


def _gdown_then_validate(file_id: str, path: str) -> None:
    """Thin wrapper around gdown that validates the result and atomically
    moves the tmp file into place."""
    tmp = path + ".gdown.tmp"
    try:
        gdown.download(id=file_id, output=tmp, quiet=False)
        _validate_csv(tmp)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def download_via_drive_api(file_id: str, path: str) -> None:
    """Download a public Drive file via the official Drive v3 API using an
    API key from the GOOGLE_API_KEY env var. Per-project quotas here are
    much larger than the anonymous-download pool that the /uc endpoints
    drain into, so this is the most reliable path."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY env var not set")
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&key={api_key}"
    _download_url_to_tmp(url, path, headers={"User-Agent": _BROWSER_UA})


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


# Download order: Drive API (best, needs GOOGLE_API_KEY) → gdown → direct requests.
last_err: Exception | None = None
downloaded = False
for label, fn in [
    ("drive_api", lambda: download_via_drive_api(CURRENT_YEAR_FILE_ID, output_path)),
    ("gdown",     lambda: _gdown_then_validate(CURRENT_YEAR_FILE_ID, output_path)),
    ("requests",  lambda: download_via_requests(CURRENT_YEAR_FILE_ID, output_path)),
]:
    try:
        fn()
        print(f"{label} succeeded.")
        downloaded = True
        break
    except Exception as e:
        last_err = e
        print(f"{label} failed: {e}")

if not downloaded:
    if os.path.exists(output_path):
        print(f"All download methods failed ({last_err}). Using cached file from previous run.")
    else:
        raise RuntimeError(f"Could not download {CURRENT_YEAR} data and no cache exists.") from last_err
